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
// В4.1-fix (К-Ф1.1): скор-хук пишет scans.rating_eligible; мета репо из
// REST (title/language/likes/last_activity_at/…) применяется ПОСЛЕ хука и
// только пригодным сканом — узкий PAT не двигает ни рейтинг, ни дату
// активности; видимость применяет любой скан, если поле есть в ответе.
// scans.public_status (Ф1.11) — статус по фактам публичных категорий.
import type { Database } from "bun:sqlite";
import { COLLECTOR_VERSION, encodeFactValue, Fact, noDataFact } from "../collectors/facts";
import { cloneWithDegrade, cleanupClone, extractFacts, gitFactsNoData } from "../collectors/git";
import { ScClient, makeScClient } from "../collectors/http";
import { RestCollectResult, collectRestFacts } from "../collectors/rest";
import { AppsecClient, collectAppsec, makeAppsecClient } from "../collectors/appsec";
import { DEFAULT_SCAN, ScanCloneLimits, ScanConfig } from "../config";
import { compute, PUBLIC_KINDS, ratingEligible, scanStatusOf, writeScores } from "../score/compute";
import { bumpRescoreCursor } from "../score/rescore";
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
   *  СОБСТВЕННЫЙ таймаут извлечения (Ф2.19) */
  extract?: Pick<ScanConfig["extract"], "maxBlameFiles" | "textCapBytes" | "timeoutMs">;
  /** Config.scan.extract.commentsTopN */
  commentsTopN?: number;
  /** интервал AppSec-запросов (Config.scan.rest.appsecMinIntervalMs) */
  appsecMinIntervalMs?: number;
  /** git-URL репо (дефолт: анонимный https git-хост, контракт плана) */
  gitUrl?: (org: string, repo: string) => string;
  /** git-хост (Config.api.gitBase; шов тестовых серверов, Ф1.13) */
  gitBase?: string;
  /** REST-хост (Config.api.restBase) — для клиента, который runScan строит сам из userToken (П3); обязателен с М7 круга 2 */
  restBase: string;
  /** AppSec-хост (Config.api.appsecBase) — для клиента по умолчанию (П3, Н2); обязателен с М7 круга 2 */
  appsecBase: string;
  /** швы для тестов: подмена каналов целиком */
  collectGit?: (org: string, repo: string, limits: ScanCloneLimits) => Promise<GitChannelOutcome>;
  collectRest?: (slug: string) => Promise<RestCollectResult>;
  /** шов AppSec-сбора (тесты без сети; К-Р15 — bucket/attempts для status_detail) */
  collectAppsec?: (rest: ScClient, appsec: AppsecClient, slug: string) => Promise<{ fact: Fact | null; noData: { reason: string; detail: string; bucket?: string; attempts?: number } | null }>;
  // В5.2 (Б3): шов авто-генерации в окне скана (summaryAutoRun) удален вместе с
  // автообновлением по оп-ину; топ рейтинга — такт обслуживания (topAutoTick)
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
  /** score-hook итог (null = хук не смог — факты записаны, скан не роняется); полный Score — дериватив, в БД не хранится (В4.3) */
  score: { healthcraftIndex: number | null; indexCoverage: number; repoHealthScore: number | null; repoHealthCoverage: number } | null;
  /** скан пригоден для рейтинга (К-Ф1.1): записан хуком в scans.rating_eligible */
  ratingEligible: boolean;
  elapsedMs: number;
  /** В4.8.5 (К8.5.12): скор-хук упал — скан закрыт `bad` (score_failed), задание — failed */
  scoreFailed?: boolean;
}

const DEFAULT_GIT_BASE = "https://git.sourcecraft.dev";

/**
 * Git-URL скана/генерации: с PAT — креды в URL (существуют только внутри
 * процесса, stderr скраббится), без — анонимный `git`-юзер. Общий для
 * scan-job и summary-job (В5). user-info добавляется только на http(s):
 * file:// (тесты, локальный дев) кредов не несёт.
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
 * Git-URL скана с PAT (дока PAT: `git clone https://anyname:<PAT>@…`):
 * свой репо бывает приватным — анонимный клон падает с Authentication
 * failed (найдено живой приёмкой В4: наш репо приватный). Креды в URL
 * существуют только внутри процесса; stderr git скраббится (git.ts).
 */
const patGitUrl = (base: string, pat: string, org: string, repo: string) => scanGitUrl(base, pat, org, repo);

/**
 * Причина no-data git-канала при неудачном клоне (круг 2, С5): limits —
 * только свойство репо: пробой диск-бюджета или таймаут периодического
 * скана; таймаут скана по PAT юзера (медленный/троттлимый токен) и ошибка
 * git — other.
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
  /** явно переданная видимость; БЕЗ ключа (или null) существующая строка не трогается
   *  (живая приёмка В4: upsert без меты перезаписывал 'private' на 'public');
   *  новая строка без видимости — 'private' до подтверждения (Ф1.10, fail-closed) */
  visibility?: string | null;
  /** logo.url платформы (дисплей); null не затирает сохранённый */
  logoUrl?: string | null;
  /** language.color платформы (дисплей); null не затирает сохранённый */
  languageColor?: string | null;
}

export function upsertRepo(db: Database, org: string, repo: string, meta: RepoUpsertMeta = {}): number {
  // Ф1.10 (fail-closed): новая строка без видимости — 'private' до подтверждения
  // явным полем платформы; UPDATE-ветка меняет visibility ТОЛЬКО когда мета
  // принесла значение
  const hasVisibility = typeof meta.visibility === "string" && meta.visibility !== "";
  const updateVisibility = hasVisibility ? "visibility = excluded.visibility," : "";
  db.query(
    `INSERT INTO repos (org_slug, repo_slug, title, language, likes, last_activity_at, forks, reaction_counts, visibility, logo_url, language_color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_slug, repo_slug) DO UPDATE SET
       title = COALESCE(excluded.title, title),
       language = COALESCE(excluded.language, language),
       likes = COALESCE(excluded.likes, likes),
       last_activity_at = COALESCE(excluded.last_activity_at, last_activity_at),
       forks = COALESCE(excluded.forks, forks),
       reaction_counts = COALESCE(excluded.reaction_counts, reaction_counts),
       logo_url = COALESCE(excluded.logo_url, logo_url),
       language_color = COALESCE(excluded.language_color, language_color),
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
    // В4.4 (кластер C): timeline пишется сжатым (z:-префикс); чтение
    // прозрачно по префиксу, остальные kinds — как были. Круг 2: сжатие
    // только у ok-значений — no-data едет plain JSON (его читают сырым
    // парсером и json_extract: карточка и правило пригодности)
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
  // скан с PAT → клон с кредами (депс-шов остаётся главнее для тестов)
  const gitBase = deps.gitBase ?? DEFAULT_GIT_BASE;
  const gitUrlOf =
    deps.gitUrl ??
    (userToken ? (org: string, repo: string) => patGitUrl(gitBase, userToken, org, repo) : (org: string, repo: string) => anonGitUrl(gitBase, org, repo));
  const repoId = upsertRepo(deps.db, org, repo);
  const scan = deps.db
    // В5.3-М (Н1): штамп версии сборщика — по нему ночная волна доочередит
    // репо, чьи факты собраны старым сборщиком
    .query("INSERT INTO scans (repo_id, started_at, status, public_status, trigger, user_id, collector_version) VALUES (?, ?, 'running', 'running', ?, ?, ?)")
    .run(repoId, startedAt, opts.trigger ?? "probe", opts.userId ?? null, COLLECTOR_VERSION);
  const scanId = Number(scan.lastInsertRowid);

  let gitChannel = "ok";
  let restChannel = "ok";
  let appsecChannel = "skipped";
  let repoAccess: ScanResult["repoAccess"] = "unknown";
  let workerFatal: string | null = null;
  const facts: Fact[] = [];
  // мета репо буферизуется до скор-хука (К-Ф1.1)
  let repoMeta: RestCollectResult["repoMeta"] = null;
  // В5 (Б1, именованная правка — спека §3.4): окно клона продлено под
  // агентную стадию. Раньше `cleanupClone` стоял в `finally` сразу после
  // `extractFacts`; теперь клон живёт до конца скана — авто-генерация
  // summary (оп-ин) исполнялась в том же окне, инструменты агента читали
  // один и тот же клон (В5.2 Б3: авто-генерация и оп-ин удалены, обзор — своя
  // заявка со своим клоном). Уборка — в `finally` ниже, сбой — по-прежнему fail-soft.
  let cloneDir: string | null = null;

  // REST-клиент (К3): userToken → PAT автора (шов или новый клиент),
  // иначе серверный; ни того ни другого → REST честно no-data(access)
  const restClient: ScClient | null = userToken
    ? // П3: без baseUrl клиент уходил на боевой REST-хост в обход шва Ф1.13
      (deps.userScClient ?? makeScClient({ token: userToken, baseUrl: deps.restBase, minIntervalMs: DEFAULT_SCAN.rest.minIntervalMs }))
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
            const headBox: { headSha?: string | null } = {};
            try {
              facts.push(
                ...(await extractFacts(clone.dir, {
                  maxBlameFiles: extract.maxBlameFiles,
                  textCapBytes: extract.textCapBytes,
                  // Ф2.19: свой бюджет извлечения. Раньше сюда ехал
                  // `degrade.timeoutMs`, и выключение деградационного яруса
                  // молча меняло дедлайн разбора клона
                  deadlineMs: extract.timeoutMs,
                  historyTruncatedSince: clone.historyTruncatedSince ?? undefined,
                  out: headBox,
                })),
              );
            } catch (e) {
              // извлечение упало до открытия окна — уборка на месте (прежняя
              // семантика `finally`), окно не открывается
              const cleanupError = cleanupClone(clone.dir);
              if (cleanupError) console.error(`[scan ${scanId}] cleanup ${clone.dir}: ${cleanupError}`);
              throw e;
            }
            cloneDir = clone.dir;
            // В5 (Б1): транспорт head_sha — колонка пишется сразу после
            // extractFacts (строка scans уже существует); сбой записи —
            // fail-soft: колонка честно останется NULL, канал не роняется
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
        : // П3 (Н2): тот же класс дефекта — адрес AppSec только из конфига
          makeAppsecClient({ token: userToken, baseUrl: deps.appsecBase, minIntervalMs: deps.appsecMinIntervalMs ?? DEFAULT_SCAN.rest.appsecMinIntervalMs });
      const out = await collect(restClient, appsec, slug);
      if (out.fact) {
        facts.push(out.fact);
        appsecChannel = "ok";
      } else {
        appsecChannel = `no-data(${out.noData?.reason ?? "other"})`;
        facts.push(noDataFact("appsec.findings", (out.noData?.reason as "access" | "no-scan" | "incomplete") ?? "other", "appsec:api", out.noData?.detail ?? "", startedAt));
        // К-Р15 (круг 2): после исчерпания ретраев корзины причина «почему
        // данных нет» фиксируется в status_detail скана и доезжает до noData
        // карточки по каналу причин (факт); счёт скоринга не тронут — частичная
        // Security-выборка может только льстить скору (К-Ф2.6), no-data честно
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

  // --- хвост скана: факты → статус → скор-хук. Клон (окно В5) убирается
  // при ЛЮБОМ исходе — закон 3 «код не храним»; сбой уборки — fail-soft
  // (ERROR_LOG 16.09: EBUSY рушил успешно собранный канал) ---
  const cleanupWindow = (): void => {
    if (cloneDir === null) return;
    const dir = cloneDir;
    cloneDir = null;
    const cleanupError = cleanupClone(dir);
    if (cleanupError) console.error(`[scan ${scanId}] cleanup ${dir}: ${cleanupError}`);
  };
  try {
    insertFacts(deps.db, scanId, facts);

    const counts = { ok: 0, noData: 0, bad: 0 };
    for (const f of facts) {
      if (f.status === "ok") counts.ok++;
      else if (f.status === "no-data") counts.noData++;
      else counts.bad++;
    }
    // «ядро» скана = ok-факты хотя бы из одного канала; ни одного ok-факта
    // (все каналы bad-channel или всё no-data) — ядра нет, скан bad
    const status: ScanResult["status"] = scanStatusOf(facts, workerFatal !== null);
    // тот же алгоритм на фактах публичных категорий (Ф1.11): статус без каналов
    const publicStatus = scanStatusOf(
      facts.filter((f) => PUBLIC_KINDS.includes(f.key)),
      workerFatal !== null,
    );

    const finishedAt = new Date().toISOString();

    // --- score-hook (В2/Б5): конец скана → compute + recommend.
    // К-Ф1.1: пригодность — по фактам скана; оценка, рекомендации, флаг
    // пригодности и мета репо — одной транзакцией.
    // В4.8.5 (К8.5.12, С10-1): финальный СТАТУС скана пишется в той же
    // транзакции. Раньше статус коммитился до хука, и упавший хук (BUSY,
    // исключение в compute) или гибель процесса между ними оставляли «скан
    // `ok` без оценки»: задание `done`, тост «Анализ завершен», оценка прежняя.
    // Теперь упавший хук закрывает скан `bad` с причиной `score_failed`, а
    // задание — `failed` с причиной «не удалось посчитать оценку».
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
        // В4.4 (кластер A): скан только что получил оценки — водяной знак
        // батчевого прохода не должен из-за него висеть «недогнанным»
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
        // скан остаётся `running` — его закроет свип сирот (К8.5.2b), задание — failed ниже
        console.error(`[scan ${scanId}] closing after score hook failure failed: ${String((closeError as Error).message).slice(0, 200)}`);
      }
    }

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

/** Мета REST → upsert; видимость без значения не передаётся ключом (Ф1.10). */
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
