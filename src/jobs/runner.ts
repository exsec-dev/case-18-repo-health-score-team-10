// runner.ts — конвейер scan-job (Б4 В1 + В2/Б1 + В4.1/К3):
// постановка репо → прогон коллекторов (git + REST [+ AppSec с PAT])
// → факты со scan_id → статус/время (ТЗ: фиксация статуса и времени
// последнего анализа). Воркер stateless: зависимости инъектятся,
// повторный скан = новый scan. Один конвейер (В4.1): режима нет —
// скан отличается только токеном: userToken (PAT автора) → REST и git с
// правами юзера + AppSec-канал; иначе серверный токен, AppSec не
// собирается. Автор пишется в scans.user_id (NULL у периодики). Статусы скана: ok = все факты ok; partial = ядро
// собрано, но есть no-data/bad факты; bad = фатал воркера или ВСЕ
// каналы bad-channel. no-data живёт ТОЛЬКО в фактах. repo-сигнал
// (repo-GET 404/403) поднимается наверх для эвикции (канальные 403
// cicd/runs — НЕ эвикция, они штатны чужим).
import type { Database } from "bun:sqlite";
import { Fact, noDataFact } from "../collectors/facts";
import { cloneWithDegrade, cleanupClone, extractFacts, gitFactsNoData } from "../collectors/git";
import { ScClient, makeScClient } from "../collectors/http";
import { RestCollectResult, collectRestFacts } from "../collectors/rest";
import { AppsecClient, collectAppsec, makeAppsecClient } from "../collectors/appsec";
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
  /** серверный REST-клиент (скан без userToken); null → REST-канал честно no-data (токена нет) */
  scClient: ScClient | null;
  /** REST-клиент PAT автора (шов тестов/бюджета); дефолт — клиент из userToken */
  userScClient?: ScClient | null;
  /** AppSec-клиент (PAT → клиент); дефолт — официальный API с интервалом конфига */
  appsecClient?: (pat: string) => AppsecClient;
  /** лимиты клона + деградационный ярус (Config.scan: clone + degrade) */
  cloneLimits?: ScanCloneLimits;
  /** лимиты извлечения (Config.scan.extract.maxBlameFiles/textCapBytes) */
  extract?: Pick<ScanConfig["extract"], "maxBlameFiles" | "textCapBytes">;
  /** Config.scan.extract.commentsTopN */
  commentsTopN?: number;
  /** интервал AppSec-запросов (Config.scan.rest.appsecMinIntervalMs) */
  appsecMinIntervalMs?: number;
  /** git-URL репо (дефолт: анонимный https git-хост, контракт плана) */
  gitUrl?: (org: string, repo: string) => string;
  /** швы для тестов: подмена каналов целиком */
  collectGit?: (org: string, repo: string, limits: ScanCloneLimits) => Promise<GitChannelOutcome>;
  collectRest?: (slug: string) => Promise<RestCollectResult>;
  /** шов AppSec-сбора (тесты без сети) */
  collectAppsec?: (rest: ScClient, appsec: AppsecClient, slug: string) => Promise<{ fact: Fact | null; noData: { reason: string; detail: string } | null }>;
}

export interface ScanOptions {
  trigger?: string;
  /** автор скана (users.id) → scans.user_id; NULL = периодика/серверный токен */
  userId?: number | null;
  /** PAT автора: REST/git с его правами + AppSec-канал; нет → серверный токен, без AppSec */
  userToken?: string | null;
}

export interface ScanResult {
  scanId: number;
  repoId: number;
  status: "ok" | "partial" | "bad";
  startedAt: string;
  finishedAt: string;
  counts: { ok: number; noData: number; bad: number };
  channels: { git: string; rest: string; appsec: string };
  /** repo-GET 404/403 токена скана; эвикция — только у сканов без автора (К3); канальные 403 тут ни при чём */
  repoAccess: "ok" | "gone" | "unknown";
  /** score-hook итог (null = хук не смог — факты записаны, скан не роняется) */
  score: { totalRating: number | null; coverageRating: number; totalFull: number | null; coverageFull: number } | null;
  elapsedMs: number;
}

const DEFAULT_GIT_URL = (org: string, repo: string) => `https://git@git.sourcecraft.dev/${org}/${repo}.git`;

/**
 * Git-URL скана с PAT (дока PAT: `git clone https://anyname:<PAT>@…`):
 * свой репо бывает приватным — анонимный клон падает с Authentication
 * failed (найдено живой приёмкой В4: наш репо приватный). Креды в URL
 * существуют только внутри процесса; stderr git скраббится (git.ts).
 */
const patGitUrl = (pat: string, org: string, repo: string) => `https://repo-health:${encodeURIComponent(pat)}@git.sourcecraft.dev/${org}/${repo}.git`;

/** ScanConfig → лимиты шва cloneLimits (clone + degrade одним объектом). */
export function scanCloneLimitsOf(scan: ScanConfig): ScanCloneLimits {
  return { ...scan.clone, degrade: scan.degrade };
}

export interface RepoUpsertMeta {
  title?: string | null;
  language?: string | null;
  likes?: number | null;
  lastActivityAt?: string | null;
  forks?: number | null;
  reactionCounts?: { type: string; count: number }[] | null;
  /** явно переданная видимость; БЕЗ ключа существующая строка не трогается
   *  (живая приёмка В4: upsert без меты перезаписывал 'private' на 'public') */
  visibility?: string | null;
}

export function upsertRepo(db: Database, org: string, repo: string, meta: RepoUpsertMeta = {}): number {
  // новая строка без меты получает дефолт 'public' (строки В1–В3 — каталог),
  // но UPDATE-ветка меняет visibility ТОЛЬКО когда мета принесла значение
  const updateVisibility = "visibility" in meta ? "visibility = excluded.visibility," : "";
  db.query(
    `INSERT INTO repos (org_slug, repo_slug, title, language, likes, last_activity_at, forks, reaction_counts, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_slug, repo_slug) DO UPDATE SET
       title = COALESCE(excluded.title, title),
       language = COALESCE(excluded.language, language),
       likes = COALESCE(excluded.likes, likes),
       last_activity_at = COALESCE(excluded.last_activity_at, last_activity_at),
       forks = COALESCE(excluded.forks, forks),
       reaction_counts = COALESCE(excluded.reaction_counts, reaction_counts),
       ${updateVisibility}
       id = id`,
  ).run(
    org,
    repo,
    meta.title ?? null,
    meta.language ?? null,
    meta.likes ?? null,
    meta.lastActivityAt ?? null,
    meta.forks ?? null,
    meta.reactionCounts ? JSON.stringify(meta.reactionCounts) : null,
    meta.visibility ?? "public",
  );
  const row = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number };
  return row.id;
}

/**
 * Аварийный fallback ДОПОЛНЯЕТ набор, но НЕ затирает уже собранные
 * факты того же kind (insertFacts пишет INSERT OR REPLACE по PK
 * scan_id+category+key). ERROR_LOG 16.09: сбой уборки клона после
 * успешного extractFacts подменял живые git-факты на no-data и
 * обнулял Score репозитория.
 */
export function fillMissingFacts(collected: Fact[], fallback: Fact[]): Fact[] {
  const have = new Set(collected.map((f) => f.key));
  return fallback.filter((f) => !have.has(f.key));
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
export async function runScan(deps: ScanDeps, slug: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const userToken = opts.userToken ? opts.userToken : null;
  const started = new Date();
  const startedAt = started.toISOString();
  const t0 = Date.now();
  const [org, repo] = slug.split("/");
  if (!org || !repo || slug.split("/").length !== 2) {
    throw new Error(`bad slug "${slug}", expected org/repo`);
  }

  const limits = deps.cloneLimits ?? scanCloneLimitsOf(DEFAULT_SCAN);
  const extract = deps.extract ?? DEFAULT_SCAN.extract;
  // скан с PAT → клон с кредами (депс-шов остаётся главнее для тестов)
  const gitUrlOf = deps.gitUrl ?? (userToken ? (org: string, repo: string) => patGitUrl(userToken, org, repo) : DEFAULT_GIT_URL);
  const repoId = upsertRepo(deps.db, org, repo);
  const scan = deps.db
    .query("INSERT INTO scans (repo_id, started_at, status, trigger, user_id) VALUES (?, ?, 'running', ?, ?)")
    .run(repoId, startedAt, opts.trigger ?? "probe", opts.userId ?? null);
  const scanId = Number(scan.lastInsertRowid);

  let gitChannel = "ok";
  let restChannel = "ok";
  let appsecChannel = "skipped";
  let repoAccess: ScanResult["repoAccess"] = "unknown";
  let workerFatal: string | null = null;
  const facts: Fact[] = [];

  // REST-клиент (К3): userToken → PAT автора (шов или новый клиент),
  // иначе серверный; ни того ни другого → REST честно no-data(access)
  const restClient: ScClient | null = userToken
    ? (deps.userScClient ?? makeScClient({ token: userToken, minIntervalMs: DEFAULT_SCAN.rest.minIntervalMs }))
    : deps.scClient;

  try {
    // --- git-канал (с деградационным ярусом §5.7; тогл конфига — одна попытка) ---
    try {
      if (deps.collectGit) {
        const out = await deps.collectGit(org, repo, limits);
        facts.push(...out.facts);
        if (out.failure) gitChannel = `no-data(${out.failure})`;
      } else {
        const url = gitUrlOf(org, repo);
        const clone = await cloneWithDegrade(url, undefined, limits);
        if (clone.ok) {
          gitChannel = clone.historyTruncatedSince ? "ok(degraded)" : "ok";
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
            // закон 3: клон удаляется всегда; сбой уборки — fail-soft
            // (ERROR_LOG 16.09: EBUSY рушил успешно собранный канал)
            const cleanupError = cleanupClone(clone.dir);
            if (cleanupError) console.error(`[scan ${scanId}] cleanup ${clone.dir}: ${cleanupError}`);
          }
        } else {
          const reason = clone.reason === "git" ? "other" : "limits";
          gitChannel = `no-data(${reason})`;
          facts.push(...gitFactsNoData(reason, clone.detail, startedAt));
        }
      }
    } catch (e) {
      gitChannel = "fatal";
      facts.push(...fillMissingFacts(facts, gitFactsNoData("other", String((e as Error).message).slice(0, 160), startedAt)));
    }

    // --- REST-канал ---
    let restChannelErrors: RestCollectResult["channelErrors"] = [];
    let restRepoMeta: RestCollectResult["repoMeta"] = null;
    if (deps.collectRest) {
      const out = await deps.collectRest(slug);
      facts.push(...out.facts);
      restChannelErrors = out.channelErrors;
      restRepoMeta = out.repoMeta;
      if (out.channelErrors.length > 0) restChannel = `errors(${out.channelErrors.map((c) => c.kind).join(",")})`;
      if (out.repoMeta) upsertRepo(deps.db, org, repo, repoMetaToUpsert(out.repoMeta));
    } else if (restClient === null) {
      restChannel = "no-data(no-token)";
      for (const kind of ["issues.stats", "issues.comments_sample", "activity.rest", "cicd.runs"]) {
        facts.push(noDataFact(kind, "access", "rest", "no SOURCECRAFT_TOKEN", startedAt));
      }
    } else {
      const out = await collectRestFacts(restClient, slug, { commentsTopN: deps.commentsTopN ?? DEFAULT_SCAN.extract.commentsTopN });
      facts.push(...out.facts);
      restChannelErrors = out.channelErrors;
      restRepoMeta = out.repoMeta;
      if (out.channelErrors.length > 0) restChannel = `errors(${out.channelErrors.map((c) => c.kind).join(",")})`;
      if (out.repoMeta) upsertRepo(deps.db, org, repo, repoMetaToUpsert(out.repoMeta));
    }
    // repo-сигнал эвикции: ТОЛЬКО ресурс repo (404/403 = репо пропал);
    // канальные 403 (cicd/runs чужих) — штатны и эвикцией не являются
    const repoErr = restChannelErrors.find((e) => e.resource === "repo");
    repoAccess = repoErr
      ? repoErr.status === 404 || repoErr.status === 403
        ? "gone"
        : "unknown"
      : restRepoMeta !== null
        ? "ok"
        : restClient === null
          ? "unknown"
          : "ok";

    // --- AppSec-канал (только с PAT автора: право даёт PAT, не публичность).
    // Скан без PAT факт не пишет — compute берёт последний ok-факт из
    // более раннего скана с PAT (фолбэк каналов, К1)
    if (userToken && restClient) {
      const collect = deps.collectAppsec ?? collectAppsec;
      const appsec = deps.appsecClient
        ? deps.appsecClient(userToken)
        : makeAppsecClient({ token: userToken, minIntervalMs: deps.appsecMinIntervalMs ?? DEFAULT_SCAN.rest.appsecMinIntervalMs });
      const out = await collect(restClient, appsec, slug);
      if (out.fact) {
        facts.push(out.fact);
        appsecChannel = "ok";
      } else {
        appsecChannel = `no-data(${out.noData?.reason ?? "other"})`;
        facts.push(noDataFact("appsec.findings", (out.noData?.reason as "access" | "no-scan" | "incomplete") ?? "other", "appsec:api", out.noData?.detail ?? "", startedAt));
      }
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

  // --- score-hook (В2/Б5): конец скана → compute + recommend; сбой хука
  // не роняет скан (факты уже записаны, скор пересчитается CLI/пересканом)
  let scoreSummary: ScanResult["score"] = null;
  try {
    const scores = compute(deps.db, scanId);
    writeScores(deps.db, scores);
    const recs = recommend(deps.db, scanId, { scores });
    writeRecommendations(deps.db, scanId, scores.modelVersion, recs);
    scoreSummary = { totalRating: scores.totalRating, coverageRating: scores.coverageRating, totalFull: scores.totalFull, coverageFull: scores.coverageFull };
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
    channels: { git: gitChannel, rest: restChannel, appsec: appsecChannel },
    repoAccess,
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
    visibility: meta.visibility,
  };
}
