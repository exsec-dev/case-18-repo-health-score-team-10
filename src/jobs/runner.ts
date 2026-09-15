// runner.ts — конвейер scan-job (Б4 В1 + проводка Config.scan В2/Б1):
// постановка репо → прогон коллекторов (git + REST) → факты со scan_id
// → статус/время (ТЗ: фиксация статуса и времени последнего анализа).
// Точка входа — scripts/scan.ts <slug> НАПРЯМУЮ (очередь-механика — В4).
// Воркер stateless: все зависимости инъектятся, повторный скан = новый
// scan. Статусы скана (план): ok = все факты ok; partial = ядро собрано,
// но есть no-data/bad факты; bad = фатал воркера или ВСЕ каналы
// bad-channel. no-data живёт ТОЛЬКО в фактах. Лимиты — Config.scan
// (консолидация 15.09): deps.cloneLimits (расширен degrade-объектом),
// deps.extract, deps.commentsTopN.
import type { Database } from "bun:sqlite";
import { Fact, noDataFact } from "../collectors/facts";
import { cloneWithDegrade, cleanupClone, extractFacts, gitFactsNoData } from "../collectors/git";
import { ScClient } from "../collectors/http";
import { RestCollectResult, collectRestFacts } from "../collectors/rest";
import { DEFAULT_SCAN, ScanCloneLimits, ScanConfig } from "../config";
import { compute, writeScores } from "../score/compute";
import { recommend, writeRecommendations } from "../score/recommend";

export interface GitChannelOutcome {
  facts: Fact[];
  /** ok | limits | other — канал упал, факты no-data */
  failure?: "limits" | "other";
  detail?: string;
}

export interface ScanDeps {
  db: Database;
  /** REST-клиент; null → REST-канал честно no-data (токена нет) */
  scClient: ScClient | null;
  /** лимиты клона + деградационный ярус (Config.scan: clone + degrade) */
  cloneLimits?: ScanCloneLimits;
  /** лимиты извлечения (Config.scan.extract.maxBlameFiles/textCapBytes) */
  extract?: Pick<ScanConfig["extract"], "maxBlameFiles" | "textCapBytes">;
  /** Config.scan.extract.commentsTopN */
  commentsTopN?: number;
  /** git-URL репо (дефолт: анонимный https git-хост, контракт плана) */
  gitUrl?: (org: string, repo: string) => string;
  /** швы для тестов: подмена каналов целиком */
  collectGit?: (org: string, repo: string, limits: ScanCloneLimits) => Promise<GitChannelOutcome>;
  collectRest?: (slug: string) => Promise<RestCollectResult>;
}

export interface ScanResult {
  scanId: number;
  repoId: number;
  status: "ok" | "partial" | "bad";
  startedAt: string;
  finishedAt: string;
  counts: { ok: number; noData: number; bad: number };
  channels: { git: string; rest: string };
  /** score-hook итог (null = хук не смог — факты записаны, скан не роняется) */
  score: { total: number | null; coverage: number } | null;
  elapsedMs: number;
}

const DEFAULT_GIT_URL = (org: string, repo: string) => `https://git@git.sourcecraft.dev/${org}/${repo}.git`;

/** ScanConfig → лимиты шва cloneLimits (clone + degrade одним объектом). */
export function scanCloneLimitsOf(scan: ScanConfig): ScanCloneLimits {
  return { ...scan.clone, degrade: scan.degrade };
}

function upsertRepo(
  db: Database,
  org: string,
  repo: string,
  meta: {
    title?: string | null;
    language?: string | null;
    likes?: number | null;
    lastActivityAt?: string | null;
    forks?: number | null;
    reactionCounts?: { type: string; count: number }[] | null;
  } = {},
): number {
  db.query(
    `INSERT INTO repos (org_slug, repo_slug, title, language, likes, last_activity_at, forks, reaction_counts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_slug, repo_slug) DO UPDATE SET
       title = COALESCE(excluded.title, title),
       language = COALESCE(excluded.language, language),
       likes = COALESCE(excluded.likes, likes),
       last_activity_at = COALESCE(excluded.last_activity_at, last_activity_at),
       forks = COALESCE(excluded.forks, forks),
       reaction_counts = COALESCE(excluded.reaction_counts, reaction_counts)`,
  ).run(
    org,
    repo,
    meta.title ?? null,
    meta.language ?? null,
    meta.likes ?? null,
    meta.lastActivityAt ?? null,
    meta.forks ?? null,
    meta.reactionCounts ? JSON.stringify(meta.reactionCounts) : null,
  );
  const row = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number };
  return row.id;
}

function insertFacts(db: Database, scanId: number, facts: Fact[]): void {
  const stmt = db.query(
    `INSERT OR REPLACE INTO facts (scan_id, category, key, value, status, source, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of facts) {
    stmt.run(scanId, f.category, f.key, JSON.stringify(f.value), f.status, f.source, f.collectedAt);
  }
}

/**
 * Прогон полного скана репо. Ни один сбой канала не валит скан:
 * git-фатал → факты no-data (limits/other), REST-фатал → bad-channel
 * риск-факты; статус скана пересчитывается по фактам.
 */
export async function runScan(deps: ScanDeps, slug: string, opts: { trigger?: string } = {}): Promise<ScanResult> {
  const started = new Date();
  const startedAt = started.toISOString();
  const t0 = Date.now();
  const [org, repo] = slug.split("/");
  if (!org || !repo) throw new Error(`bad slug "${slug}", expected org/repo`);

  const limits = deps.cloneLimits ?? scanCloneLimitsOf(DEFAULT_SCAN);
  const extract = deps.extract ?? DEFAULT_SCAN.extract;
  const repoId = upsertRepo(deps.db, org, repo);
  const scan = deps.db.query("INSERT INTO scans (repo_id, started_at, status, trigger) VALUES (?, ?, 'running', ?)").run(repoId, startedAt, opts.trigger ?? "probe");
  const scanId = Number(scan.lastInsertRowid);
  // job-строка: повторный скан = upsert (UNIQUE(repo_id))
  deps.db
    .query(
      `INSERT INTO jobs (repo_id, status, claimed_at) VALUES (?, 'running', ?)
       ON CONFLICT(repo_id) DO UPDATE SET status = 'running', claimed_at = excluded.claimed_at`,
    )
    .run(repoId, startedAt);

  let gitChannel = "ok";
  let restChannel = "ok";
  let workerFatal: string | null = null;
  const facts: Fact[] = [];

  try {
    // --- git-канал (с деградационным ярусом §5.7) ---
    try {
      if (deps.collectGit) {
        const out = await deps.collectGit(org, repo, limits);
        facts.push(...out.facts);
        if (out.failure) gitChannel = `no-data(${out.failure})`;
      } else {
        const url = (deps.gitUrl ?? DEFAULT_GIT_URL)(org, repo);
        const clone = await cloneWithDegrade(url, undefined, limits);
        if (clone.ok) {
          gitChannel = clone.historyTruncatedSince ? `ok(degraded)` : "ok";
          try {
            facts.push(
              ...(await extractFacts(clone.dir, {
                maxBlameFiles: extract.maxBlameFiles,
                textCapBytes: extract.textCapBytes,
                deadlineMs: limits.degrade.timeoutMs,
                historyTruncatedSince: clone.historyTruncatedSince ?? undefined,
              })),
            );
          } finally {
            cleanupClone(clone.dir); // закон 3: клон удаляется всегда
          }
        } else {
          const reason = clone.reason === "git" ? "other" : "limits";
          gitChannel = `no-data(${reason})`;
          facts.push(...gitFactsNoData(reason, clone.detail, startedAt));
        }
      }
    } catch (e) {
      gitChannel = "fatal";
      facts.push(...gitFactsNoData("other", String((e as Error).message).slice(0, 160), startedAt));
    }

    // --- REST-канал ---
    if (deps.collectRest) {
      const out = await deps.collectRest(slug);
      facts.push(...out.facts);
      if (out.channelErrors.length > 0) restChannel = `errors(${out.channelErrors.map((c) => c.kind).join(",")})`;
      if (out.repoMeta) upsertRepo(deps.db, org, repo, repoMetaToUpsert(out.repoMeta));
    } else if (deps.scClient === null) {
      restChannel = "no-data(no-token)";
      for (const kind of ["issues.stats", "issues.comments_sample", "activity.rest", "cicd.runs"]) {
        facts.push(noDataFact(kind, "access", "rest", "no SOURCECRAFT_TOKEN", startedAt));
      }
    } else {
      const out = await collectRestFacts(deps.scClient, slug, { commentsTopN: deps.commentsTopN ?? DEFAULT_SCAN.extract.commentsTopN });
      facts.push(...out.facts);
      if (out.channelErrors.length > 0) restChannel = `errors(${out.channelErrors.map((c) => c.kind).join(",")})`;
      if (out.repoMeta) upsertRepo(deps.db, org, repo, repoMetaToUpsert(out.repoMeta));
    }
  } catch (e) {
    workerFatal = String((e as Error).message).slice(0, 200);
  }

  insertFacts(deps.db, scanId, facts);

  const counts = { ok: 0, noData: 0, bad: 0 };
  for (const f of facts) {
    if (f.status === "ok") counts.ok++;
    else if (f.status === "no-data") counts.noData++;
    else counts.bad++;
  }
  // «ядро» скана = ok-факты хотя бы из одного канала; ни одного ok-факта
  // (все каналы bad-channel или всё no-data) — ядра нет, скан bad
  const gitHasOk = facts.some((f) => f.source === "git" && f.status === "ok");
  const restHasOk = facts.some((f) => f.source.startsWith("rest:") && f.status === "ok");
  let status: ScanResult["status"];
  if (workerFatal) status = "bad";
  else if (!gitHasOk && !restHasOk) status = "bad";
  else if (counts.noData === 0 && counts.bad === 0) status = "ok";
  else status = "partial";

  const finishedAt = new Date().toISOString();
  deps.db.query("UPDATE scans SET status = ?, finished_at = ? WHERE id = ?").run(status, finishedAt, scanId);
  deps.db.query("UPDATE jobs SET status = ?, lease_until = NULL WHERE repo_id = ?").run(status === "bad" ? "failed" : "done", repoId);

  // --- score-hook (В2/Б5): конец скана → compute + recommend; сбой хука
  // не роняет скан (факты уже записаны, скор пересчитается CLI/пересканом)
  let scoreSummary: { total: number | null; coverage: number } | null = null;
  try {
    const scores = compute(deps.db, scanId, "public");
    writeScores(deps.db, scores);
    const recs = recommend(deps.db, scanId, { scores });
    writeRecommendations(deps.db, scanId, scores.modelVersion, recs);
    scoreSummary = { total: scores.total, coverage: scores.coverage };
  } catch (e) {
    console.error(`[scan ${scanId}] score hook failed: ${String((e as Error).message).slice(0, 200)}`);
  }

  return {
    scanId,
    repoId,
    status,
    startedAt,
    finishedAt,
    counts,
    channels: { git: gitChannel, rest: restChannel },
    score: scoreSummary,
    elapsedMs: Date.now() - t0,
  };
}

function repoMetaToUpsert(meta: NonNullable<RestCollectResult["repoMeta"]>) {
  return {
    title: meta.title,
    language: meta.language,
    likes: meta.likes,
    lastActivityAt: meta.lastActivityAt,
    forks: meta.forks,
    reactionCounts: meta.reactionCounts,
  };
}
