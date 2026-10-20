// Конвейер скана: репо → коллекторы (git + REST, с PAT автора еще AppSec) →
// факты со scan_id → статус и время последнего анализа.
// Воркер stateless: зависимости передаются снаружи, повторный скан — новая строка scans.
// Скан отличается только токеном: с PAT автора REST и git идут с его правами и
// добавляется AppSec; иначе серверный токен без AppSec. Автор пишется в
// scans.user_id (NULL у периодических сканов).
// Статусы: ok — все факты ok; partial — ядро собрано, но есть no-data/bad;
// bad — фатальный сбой воркера или все каналы bad-channel. no-data живет только
// в фактах. 404/403 на GET репозитория поднимается наверх для эвикции; 403 на
// cicd/runs чужого репо — штатная ситуация, не эвикция.
// Мета репо из REST (title, language, likes, last_activity_at…) применяется после
// скор-хука и только пригодным для рейтинга сканом: узкий PAT не двигает ни рейтинг,
// ни дату активности. Видимость применяет любой скан, если поле есть в ответе.
import type { Database } from "bun:sqlite";
import { COLLECTOR_VERSION, encodeFactValue, Fact, noDataFact } from "../collectors/facts";
import { cloneWithDegrade, cleanupClone, extractFacts, gitFactsNoData } from "../collectors/git";
import { ScClient, makeScClient } from "../collectors/http";
import { RestCollectResult, collectRestFacts } from "../collectors/rest";
import { AppsecClient, collectAppsec, makeAppsecClient } from "../collectors/appsec";
import { DEFAULT_SCAN, ScanCloneLimits, ScanConfig } from "../config";
import { compute, PUBLIC_KINDS, ratingEligible, scanStatusOf, writeScores } from "../score/compute";
import { bumpRescoreCursor } from "../score/rescore";
import { refreshRepoTopics } from "./topics";
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
  /** лимиты извлечения (Config.scan.extract): файлы blame, потолок текста и
   *  собственный таймаут извлечения */
  extract?: Pick<ScanConfig["extract"], "maxBlameFiles" | "textCapBytes" | "timeoutMs">;
  /** Config.scan.extract.commentsTopN */
  commentsTopN?: number;
  /** интервал AppSec-запросов (Config.scan.rest.appsecMinIntervalMs) */
  appsecMinIntervalMs?: number;
  /** git-URL репо (по умолчанию — анонимный https git-хост) */
  gitUrl?: (org: string, repo: string) => string;
  /** git-хост (Config.api.gitBase); тесты подставляют свой сервер */
  gitBase?: string;
  /** REST-хост (Config.api.restBase) — для клиента, который runScan строит сам из userToken */
  restBase: string;
  /** AppSec-хост (Config.api.appsecBase) — для клиента по умолчанию */
  appsecBase: string;
  /** швы для тестов: подмена каналов целиком */
  collectGit?: (org: string, repo: string, limits: ScanCloneLimits) => Promise<GitChannelOutcome>;
  collectRest?: (slug: string) => Promise<RestCollectResult>;
  /** шов AppSec-сбора для тестов без сети; bucket/attempts идут в status_detail */
  collectAppsec?: (rest: ScClient, appsec: AppsecClient, slug: string) => Promise<{ fact: Fact | null; noData: { reason: string; detail: string; bucket?: string; attempts?: number } | null }>;
}

export interface ScanOptions {
  trigger?: string;
  /** автор скана (users.id) → scans.user_id; NULL = периодика/серверный токен */
  userId?: number | null;
  /** PAT автора: REST/git с его правами + AppSec-канал; нет → серверный токен, без AppSec */
  userToken?: string | null;
  /**
   * Передача клона следом идущему AI-обзору (clone-handoff.ts): вызывается в конце
   * успешного скана; true – клон остается на диске, его убирает получатель;
   * false или не задан – скан убирает клон сам, как всегда.
   */
  claimClone?: (clone: { dir: string; gitEnv: Record<string, string>; scanId: number; headSha: string | null; bytes: number }) => boolean;
}

export interface ScanResult {
  scanId: number;
  repoId: number;
  status: "ok" | "partial" | "bad";
  startedAt: string;
  finishedAt: string;
  counts: { ok: number; noData: number; bad: number };
  channels: { git: string; rest: string; appsec: string };
  /** 404/403 на GET репозитория токеном скана; эвикция — только у сканов без автора; канальные 403 тут ни при чем */
  repoAccess: "ok" | "gone" | "unknown";
  /** итог скор-хука (null — хук не смог, факты записаны, скан не роняется); полный Score — производное, в БД не хранится */
  score: { healthcraftIndex: number | null; indexCoverage: number; repoHealthScore: number | null; repoHealthCoverage: number } | null;
  /** скан пригоден для рейтинга (записан хуком в scans.rating_eligible) */
  ratingEligible: boolean;
  elapsedMs: number;
  /** скор-хук упал — скан закрыт `bad` (score_failed), задание — failed */
  scoreFailed?: boolean;
}

const DEFAULT_GIT_BASE = "https://git.sourcecraft.dev";

/**
 * Git-URL для скана и генерации обзора: с PAT — креды в URL (живут только внутри
 * процесса, stderr git вычищается), без PAT — анонимный пользователь `git`.
 * Креды добавляются только для http(s): file:// (тесты, локальная разработка) их не несет.
 */
export function scanGitUrl(gitBase: string, pat: string | null, org: string, repo: string): string {
  const u = new URL(`${gitBase.replace(/\/+$/, "")}/${org}/${repo}.git`);
  if (/^https?:$/.test(u.protocol)) {
    if (pat !== null) {
      u.username = "repo-health";
      u.password = encodeURIComponent(pat);
    } else {
      u.username = "git";
    }
  }
  return u.toString();
}

const anonGitUrl = (base: string, org: string, repo: string) => scanGitUrl(base, null, org, repo);

/**
 * Git-URL скана с PAT (формат из доки SourceCraft: `git clone https://anyname:<PAT>@…`):
 * свой репо бывает приватным, и анонимный клон падает с Authentication failed.
 */
const patGitUrl = (base: string, pat: string, org: string, repo: string) => scanGitUrl(base, pat, org, repo);

/**
 * Причина no-data git-канала при неудачном клоне. limits — только свойство
 * самого репо: пробой дискового бюджета или таймаут периодического скана.
 * Таймаут скана по PAT пользователя (токен мог быть медленным или
 * троттлиться) и ошибка git — other.
 */
export function gitFailureReason(cloneReason: "timeout" | "disk" | "git", userScan: boolean): "limits" | "other" {
  if (cloneReason === "disk") return "limits";
  if (cloneReason === "timeout" && !userScan) return "limits";
  return "other";
}

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
  /** явно переданная видимость; без ключа (или null) у существующей строки она не
   *  меняется, иначе upsert без меты перезаписал бы 'private' на 'public'.
   *  Новая строка без видимости — 'private' до подтверждения (fail-closed) */
  visibility?: string | null;
  /** logo.url платформы (дисплей); null не затирает сохранённый */
  logoUrl?: string | null;
  /** language.color платформы (дисплей); null не затирает сохранённый */
  languageColor?: string | null;
  /** описание из каталога – для тематики рейтинга (api/topics.ts); null не затирает сохранённое */
  description?: string | null;
}

export function upsertRepo(db: Database, org: string, repo: string, meta: RepoUpsertMeta = {}): number {
  // fail-closed: новая строка без видимости — 'private' до подтверждения явным
  // полем платформы; UPDATE меняет visibility только когда мета принесла значение
  const hasVisibility = typeof meta.visibility === "string" && meta.visibility !== "";
  const updateVisibility = hasVisibility ? "visibility = excluded.visibility," : "";
  db.query(
    `INSERT INTO repos (org_slug, repo_slug, title, language, likes, last_activity_at, forks, reaction_counts, visibility, logo_url, language_color, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_slug, repo_slug) DO UPDATE SET
       title = COALESCE(excluded.title, title),
       language = COALESCE(excluded.language, language),
       likes = COALESCE(excluded.likes, likes),
       last_activity_at = COALESCE(excluded.last_activity_at, last_activity_at),
       forks = COALESCE(excluded.forks, forks),
       reaction_counts = COALESCE(excluded.reaction_counts, reaction_counts),
       logo_url = COALESCE(excluded.logo_url, logo_url),
       language_color = COALESCE(excluded.language_color, language_color),
       description = COALESCE(excluded.description, description),
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
    hasVisibility ? (meta.visibility as string) : "private",
    meta.logoUrl ?? null,
    meta.languageColor ?? null,
    meta.description ?? null,
  );
  const row = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number };
  return row.id;
}

/**
 * Аварийный fallback дополняет набор, но не затирает уже собранные факты того
 * же kind: insertFacts пишет INSERT OR REPLACE по PK scan_id+category+key, и
 * сбой уборки клона после успешного extractFacts иначе подменил бы живые
 * git-факты на no-data и обнулил Score.
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
    // timeline пишется сжатым (префикс z:), чтение распознает префикс. Сжимаются
    // только ok-значения: no-data остается обычным JSON, его читают сырым
    // парсером и json_extract (карточка, правило пригодности)
    stmt.run(scanId, f.category, f.key, encodeFactValue(f.key, f.value, f.status), f.status, f.source, f.collectedAt);
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
  // скан с PAT → клон с кредами (тестовый шов deps.gitUrl главнее)
  const gitBase = deps.gitBase ?? DEFAULT_GIT_BASE;
  const gitUrlOf =
    deps.gitUrl ??
    (userToken ? (org: string, repo: string) => patGitUrl(gitBase, userToken, org, repo) : (org: string, repo: string) => anonGitUrl(gitBase, org, repo));
  const repoId = upsertRepo(deps.db, org, repo);
  const scan = deps.db
    // версия сборщика: по ней ночная волна доставит в очередь репо, чьи факты
    // собраны старым сборщиком
    .query("INSERT INTO scans (repo_id, started_at, status, public_status, trigger, user_id, collector_version) VALUES (?, ?, 'running', 'running', ?, ?, ?)")
    .run(repoId, startedAt, opts.trigger ?? "probe", opts.userId ?? null, COLLECTOR_VERSION);
  const scanId = Number(scan.lastInsertRowid);

  let gitChannel = "ok";
  let restChannel = "ok";
  let appsecChannel = "skipped";
  let repoAccess: ScanResult["repoAccess"] = "unknown";
  let workerFatal: string | null = null;
  const facts: Fact[] = [];
  // мета репо ждет скор-хука: применяется только пригодным сканом
  let repoMeta: RestCollectResult["repoMeta"] = null;
  // клон живет до конца скана и убирается в `finally` ниже (fail-soft)
  let cloneDir: string | null = null;
  let cloneInfo: { gitEnv: Record<string, string>; headSha: string | null; bytes: number } | null = null;
  // скан закрылся ok/partial с оценкой – клон можно передать обзору (opts.claimClone)
  let handoffEligible = false;

  // REST-клиент: с userToken — клиент PAT автора, иначе серверный;
  // нет ни того ни другого — REST-факты no-data(access)
  const restClient: ScClient | null = userToken
    ? // baseUrl из конфига обязателен: без него клиент ушел бы на боевой хост мимо тестового сервера
      (deps.userScClient ?? makeScClient({ token: userToken, baseUrl: deps.restBase, minIntervalMs: DEFAULT_SCAN.rest.minIntervalMs }))
    : deps.scClient;

  try {
    // --- git-канал (с деградационным ярусом; если он выключен в конфиге — одна попытка) ---
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
            const headBox: { headSha?: string | null } = {};
            try {
              facts.push(
                ...(await extractFacts(clone.dir, {
                  maxBlameFiles: extract.maxBlameFiles,
                  textCapBytes: extract.textCapBytes,
                  // свой бюджет извлечения, не `degrade.timeoutMs`: иначе выключение
                  // деградационного яруса молча меняло бы дедлайн разбора клона
                  deadlineMs: extract.timeoutMs,
                  historyTruncatedSince: clone.historyTruncatedSince ?? undefined,
                  out: headBox,
                })),
              );
            } catch (e) {
              // извлечение упало — клон убирается сразу, дальше он не нужен
              const cleanupError = cleanupClone(clone.dir);
              if (cleanupError) console.error(`[scan ${scanId}] cleanup ${clone.dir}: ${cleanupError}`);
              throw e;
            }
            cloneDir = clone.dir;
            cloneInfo = { gitEnv: clone.gitEnv, headSha: headBox.headSha ?? null, bytes: clone.bytes };
            // head_sha пишется сразу после extractFacts; сбой записи fail-soft:
            // колонка останется NULL, канал не роняется
            if (headBox.headSha) {
              try {
                deps.db.query("UPDATE scans SET head_sha = ? WHERE id = ?").run(headBox.headSha, scanId);
              } catch (e) {
                console.error(`[scan ${scanId}] head_sha write failed: ${String((e as Error).message).slice(0, 120)}`);
              }
            }
          } else {
          const reason = gitFailureReason(clone.reason, userToken !== null);
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
    }
    // видимость — свойство репо: применяет любой скан, если поле есть в ответе
    repoMeta = restRepoMeta;
    if (restRepoMeta && typeof restRepoMeta.visibility === "string") {
      upsertRepo(deps.db, org, repo, { visibility: restRepoMeta.visibility });
    }
    // сигнал эвикции — только ресурс repo (404/403 = репо пропал);
    // 403 на cicd/runs чужого репо штатен и эвикцией не является
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

    // --- AppSec-канал: только с PAT автора, право дает PAT, а не публичность репо.
    // Скан без PAT факт не пишет — compute берет последний ok-факт из
    // более раннего скана с PAT
    if (userToken && restClient) {
      const collect = deps.collectAppsec ?? collectAppsec;
      const appsec = deps.appsecClient
        ? deps.appsecClient(userToken)
        : // адрес AppSec — только из конфига, как и у REST-клиента выше
          makeAppsecClient({ token: userToken, baseUrl: deps.appsecBase, minIntervalMs: deps.appsecMinIntervalMs ?? DEFAULT_SCAN.rest.appsecMinIntervalMs });
      const out = await collect(restClient, appsec, slug);
      if (out.fact) {
        facts.push(out.fact);
        appsecChannel = "ok";
      } else {
        appsecChannel = `no-data(${out.noData?.reason ?? "other"})`;
        facts.push(noDataFact("appsec.findings", (out.noData?.reason as "access" | "no-scan" | "incomplete") ?? "other", "appsec:api", out.noData?.detail ?? "", startedAt));
        // ретраи корзины исчерпаны: причина пишется в status_detail скана и через
        // факт доходит до карточки. В счет частичная выборка Security не идет —
        // она могла бы только льстить оценке, поэтому no-data
        if (out.noData?.reason === "incomplete" && out.noData.bucket !== undefined) {
          deps.db
            .query("UPDATE scans SET status_detail = ? WHERE id = ?")
            .run(`appsec bucket ${out.noData.bucket} unavailable after ${out.noData.attempts ?? 1} attempts`, scanId);
        }
      }
    }
  } catch (e) {
    workerFatal = String((e as Error).message).slice(0, 200);
  }

  // --- хвост скана: факты → статус → скор-хук. Клон убирается при любом
  // исходе — код репозиториев не храним. Сбой уборки fail-soft: EBUSY при
  // удалении не должен ронять успешно собранный канал ---
  const cleanupWindow = (): void => {
    if (cloneDir === null) return;
    const dir = cloneDir;
    cloneDir = null;
    if (handoffEligible && cloneInfo !== null && opts.claimClone !== undefined) {
      // передача – необязательная оптимизация: ее сбой (SQLITE_BUSY в проверке
      // очереди) не роняет уже оцененный скан и не оставляет клон на диске
      let claimed = false;
      try {
        claimed = opts.claimClone({ dir, scanId, ...cloneInfo }) === true;
      } catch (e) {
        console.error(`[scan ${scanId}] clone handoff failed, cleaning up: ${String((e as Error).message).slice(0, 120)}`);
      }
      if (claimed) {
        console.log(`[scan ${scanId}] clone handed off to the queued AI overview`);
        return;
      }
    }
    const cleanupError = cleanupClone(dir);
    if (cleanupError) console.error(`[scan ${scanId}] cleanup ${dir}: ${cleanupError}`);
  };
  try {
    insertFacts(deps.db, scanId, facts);
    // тематика рейтинга: зависимости из манифестов (tree.deps) только что записаны
    refreshRepoTopics(deps.db, repoId);

    const counts = { ok: 0, noData: 0, bad: 0 };
    for (const f of facts) {
      if (f.status === "ok") counts.ok++;
      else if (f.status === "no-data") counts.noData++;
      else counts.bad++;
    }
    // «ядро» скана = ok-факты хотя бы из одного канала; ни одного ok-факта
    // (все каналы bad-channel или всё no-data) — ядра нет, скан bad
    const status: ScanResult["status"] = scanStatusOf(facts, workerFatal !== null);
    // тот же алгоритм на фактах публичных категорий: статус без приватных каналов
    const publicStatus = scanStatusOf(
      facts.filter((f) => PUBLIC_KINDS.includes(f.key)),
      workerFatal !== null,
    );

    const finishedAt = new Date().toISOString();

    // --- скор-хук: compute + recommend. Статус скана, оценка, рекомендации, флаг
    // пригодности и мета репо пишутся одной транзакцией: иначе упавший хук (BUSY,
    // исключение в compute) или гибель процесса оставили бы «скан ok без оценки».
    // Упавший хук закрывает скан `bad` с причиной `score_failed`, задание — failed.
    let scoreSummary: ScanResult["score"] = null;
    let eligible = false;
    let scoreFailed = false;
    try {
      const scores = compute(deps.db, scanId);
      const recs = recommend(deps.db, scanId, { scores });
      eligible = ratingEligible(facts, { status, userId: opts.userId ?? null });
      deps.db.transaction(() => {
        deps.db.query("UPDATE scans SET status = ?, public_status = ?, finished_at = ? WHERE id = ?").run(status, publicStatus, finishedAt, scanId);
        writeScores(deps.db, scores);
        writeRecommendations(deps.db, scanId, scores.modelVersion, recs);
        deps.db.query("UPDATE scans SET rating_eligible = ? WHERE id = ?").run(eligible ? 1 : 0, scanId);
        if (eligible && repoMeta) upsertRepo(deps.db, org, repo, repoMetaToUpsert(repoMeta));
        // скан уже получил оценки — курсор пакетного пересчета сдвигается за него
        bumpRescoreCursor(deps.db, scanId);
      })();
      scoreSummary = { healthcraftIndex: scores.healthcraftIndex, indexCoverage: scores.indexCoverage, repoHealthScore: scores.repoHealthScore, repoHealthCoverage: scores.repoHealthCoverage };
    } catch (e) {
      scoreFailed = true;
      eligible = false;
      console.error(`[scan ${scanId}] score hook failed: ${String((e as Error).message).slice(0, 200)}`);
      try {
        deps.db
          .query("UPDATE scans SET status = 'bad', public_status = 'bad', finished_at = ?, status_detail = 'score_failed', rating_eligible = 0 WHERE id = ?")
          .run(finishedAt, scanId);
      } catch (closeError) {
        // скан остается `running` — его закроет уборка сирот, задание — failed ниже
        console.error(`[scan ${scanId}] closing after score hook failure failed: ${String((closeError as Error).message).slice(0, 200)}`);
      }
    }

    handoffEligible = !scoreFailed && status !== "bad";
    return {
      scanId,
      repoId,
      status: scoreFailed ? "bad" : status,
      ...(scoreFailed ? { scoreFailed: true } : {}),
      startedAt,
      finishedAt,
      counts,
      channels: { git: gitChannel, rest: restChannel, appsec: appsecChannel },
      repoAccess,
      score: scoreSummary,
      ratingEligible: scoreSummary !== null && eligible,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    cleanupWindow();
  }
}

/** Мета REST → upsert; видимость без значения не передается ключом, чтобы не затереть сохраненную. */
export function repoMetaToUpsert(meta: NonNullable<RestCollectResult["repoMeta"]>): RepoUpsertMeta {
  return {
    title: meta.title,
    language: meta.language,
    likes: meta.likes,
    lastActivityAt: meta.lastActivityAt,
    forks: meta.forks,
    reactionCounts: meta.reactionCounts,
    logoUrl: meta.logoUrl,
    languageColor: meta.languageColor,
    ...(typeof meta.visibility === "string" && meta.visibility !== "" ? { visibility: meta.visibility } : {}),
  };
}
