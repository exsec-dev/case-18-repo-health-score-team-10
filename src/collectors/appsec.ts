// Клиент официального AppSec API SourceCraft (docs/SCS-API-1.0.0-draft.pdf,
// docs/api-spec/appsec.openapi.yaml): только GET с Bearer PAT.
// Порядок: REST /repos/{slug}.id → gitRepo → /v1/scans/latest (завершенность
// по timeFinished и isLatest; числовой status не декодируем – таблицы
// соответствия нет) → /v1/defect-groups с явным scanUuid по страницам
// (pageSize ≤ 250) и именованными фильтрами severity – серьезность
// классифицирует платформа, а не мы. Храним только агрегаты и стабильные id
// групп (publicId/uuid; числовой id устарел) – без кода, путей и секретов.
// 401/403 → no-data access; скана нет или он не завершен → no-data no-scan;
// неполный ответ → no-data incomplete: ошибка не должна читаться как
// отсутствие уязвимостей.
import { noDataFact, okFact, type Fact } from "./facts";
import { isRetryableStatus, parseRetryAfter, reserveSlot, retryDelayMs, rhythmKey, type ScClient } from "./http";

export const APPSEC_BASE_URL = "https://appsec.sourcecraft.tech";

export interface AppsecGet {
  status: number;
  json: unknown;
  error?: string;
  /**
   * Сколько HTTP-попыток ушло на этот get: 2 – был повтор после временного
   * сбоя, 0 – бюджет кончился до запроса. Отсутствие читается как 1 попытка
   * (тестовым фейкам поле знать не обязательно).
   */
  attempts?: number;
}

/** Параметры запроса: массив – повтор ключа (`status=OPEN&status=TRIAGED_TP`), как требует спека AppSec. */
export type AppsecParams = Record<string, string | string[]>;

export interface AppsecClient {
  get(path: string, params: AppsecParams): Promise<AppsecGet>;
  requestCount(): number;
}

export function appsecQuery(params: AppsecParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) qs.append(k, item);
    else qs.append(k, v);
  }
  return qs.toString();
}

/**
 * Открытые статусы групп дефектов (`DefectGroupStatus` спеки) – те, что еще
 * требуют работы. Без параметра `status` `/v1/defect-groups` отдает группы
 * всех статусов, и в плотность, признак утекших секретов (потолок 49) и
 * бэклог попали бы закрытые: исправленные, ложные, дубли.
 */
export const APPSEC_OPEN_STATUSES = ["OPEN", "TRIAGE_IN_PROGRESS", "TRIAGED_TP", "FIX_IN_PROGRESS"] as const;

/**
 * Живая платформа отдает статус группы числом – индексом в перечне
 * `DefectGroupStatus` спеки (`docs/api-spec/appsec.openapi.yaml`) в порядке
 * объявления. Число вне диапазона или дробное – неизвестный статус.
 */
export const DEFECT_GROUP_STATUS_ORDER = [
  "OPEN",
  "RESOLVED_FIXED",
  "RESOLVED_FP",
  "RESOLVED_PROJECT_NOT_AFFECTED",
  "RESOLVED_TOLERABLE",
  "RESOLVED_DUPLICATE",
  "TRIAGE_IN_PROGRESS",
  "TRIAGED_TP",
  "FIX_IN_PROGRESS",
  "RESOLVED_AUTOFIXED",
  "UNRECOGNIZED",
] as const;

/** Статус группы строкой спеки: строка – как есть, число – по порядку перечня, иное – без изменений. */
export function defectGroupStatusName(status: unknown): unknown {
  if (typeof status === "number" && Number.isInteger(status) && status >= 0 && status < DEFECT_GROUP_STATUS_ORDER.length) {
    return DEFECT_GROUP_STATUS_ORDER[status];
  }
  return status;
}

export function defectGroupStatusClass(rawStatus: unknown): "open" | "resolved" | "unrecognized" | "unknown" {
  const status = defectGroupStatusName(rawStatus);
  switch (status) {
    case "OPEN":
    case "TRIAGE_IN_PROGRESS":
    case "TRIAGED_TP":
    case "FIX_IN_PROGRESS":
      return "open";
    case "RESOLVED_FIXED":
    case "RESOLVED_FP":
    case "RESOLVED_PROJECT_NOT_AFFECTED":
    case "RESOLVED_TOLERABLE":
    case "RESOLVED_DUPLICATE":
    case "RESOLVED_AUTOFIXED":
      return "resolved";
    case "UNRECOGNIZED":
      return "unrecognized";
    default:
      return "unknown";
  }
}

export interface AppsecClientOptions {
  token: string;
  /** адрес AppSec-хоста (`Config.api.appsecBase`); обязателен по той же причине, что у `makeScClient` */
  baseUrl: string;
  /** интервал между запросами (по умолчанию 100 мс): лимиты частоты в доке не описаны */
  minIntervalMs?: number;
  maxRequests?: number;
  timeoutMs?: number;
  /** потолок ожидания `Retry-After`, мс (по умолчанию – общий потолок http.ts) */
  retryMaxWaitMs?: number;
  /** подмена ожидания в тестах */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Клиент с интервалом, таймаутом и одним повтором при временном сбое
 * (сеть, 429, 5xx). Интервал – общий ритм реестра `http.ts` по (хост AppSec,
 * токен): все AppSec-клиенты одного PAT в процессе делят его. Пауза перед
 * повтором – `Retry-After`, если он есть и не длиннее потолка (длиннее –
 * повтора нет, ответ отдается как есть), иначе 600 мс.
 */
export function makeAppsecClient(opts: AppsecClientOptions): AppsecClient {
  const baseUrl = opts.baseUrl;
  const minInterval = opts.minIntervalMs ?? 100;
  const maxRequests = opts.maxRequests ?? 40;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const key = rhythmKey(baseUrl, opts.token);
  let count = 0;

  const once = async (path: string, params: AppsecParams): Promise<{ get: Omit<AppsecGet, "attempts">; retryAfterMs: number | null }> => {
    const wait = reserveSlot(key, minInterval, Date.now());
    if (wait > 0) await sleep(wait);
    const qs = appsecQuery(params);
    try {
      const res = await fetch(`${baseUrl}${path}${qs ? `?${qs}` : ""}`, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bodyText = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(bodyText);
      } catch {
        /* не JSON – начало тела уйдет в error */
      }
      const retryAfterMs = isRetryableStatus(res.status) ? parseRetryAfter(res.headers.get("retry-after"), Date.now()) : null;
      return { get: { status: res.status, json, error: json === null ? bodyText.slice(0, 120) : undefined }, retryAfterMs };
    } catch (e) {
      return { get: { status: 0, json: null, error: String((e as Error).message ?? e).slice(0, 160) }, retryAfterMs: null };
    }
  };

  return {
    async get(path, params) {
      if (count >= maxRequests) {
        return { status: 0, json: null, error: `budget exhausted: ${maxRequests} requests`, attempts: 0 };
      }
      count++;
      const first = await once(path, params);
      // повторяем только временные сбои: сеть (status 0), 429, 5xx
      const s = first.get.status;
      if (s === 0 || s === 429 || s >= 500) {
        const delay = first.retryAfterMs !== null ? retryDelayMs(first.retryAfterMs, 0, { maxWaitMs: opts.retryMaxWaitMs }) : 600;
        if (delay === null) return { ...first.get, attempts: 1 };
        await sleep(delay);
        const second = await once(path, params);
        count++;
        return { ...second.get, attempts: 2 };
      }
      return { ...first.get, attempts: 1 };
    },
    requestCount: () => count,
  };
}

// ---------- сбор факта ----------

export interface AppsecNoData {
  reason: "access" | "no-scan" | "incomplete";
  detail: string;
  /** корзина или страница, на которой запрос отказал после повтора; видна в status_detail скана и в карточке */
  bucket?: string;
  /** HTTP-попыток на отказавший запрос (клиент повторяет 0/429/5xx один раз) */
  attempts?: number;
}

export interface AppsecCollectOutcome {
  /** ok-факт appsec.findings (в том числе завершенный скан без находок) */
  fact: Fact | null;
  noData: AppsecNoData | null;
}

export interface AppsecCollectOptions {
  now?: Date;
  /** предел страниц defect-groups – защита от бесконечной пагинации */
  pagesCap?: number;
  /** предел id групп в provenance, чтобы факт не разрастался на сотнях групп */
  groupIdsCap?: number;
}

const SEVERITY_BUCKETS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const GROUPS_PAGE_SIZE = 250;
/** Тип движка секретов в спеке AppSec (`type` у /v1/defect-groups). */
export const SECRETS_TYPE = "SECRETS";
/** Тип движка анализа зависимостей в спеке AppSec. */
export const SCA_TYPE = "SCA";
/** Страниц групп SCA на корзину критичности: 2 × 250 пакетов-групп – с запасом для живых репо. */
export const SCA_PAGES_CAP = 2;

export type AppsecScaSeverity = "critical" | "high" | "medium" | "low";

/** Уязвимый пакет по группам SCA: имя и версия – из `codeBlock` вида `name@version`. */
export interface AppsecScaPackage {
  name: string;
  version: string | null;
  /** худшая корзина критичности платформы среди групп пакета */
  severity: AppsecScaSeverity;
  /** число открытых групп (advisories) по пакету, по всем движкам */
  advisories: number;
  /** движки, нашедшие пакет (Trivy, grype) */
  engines: string[];
}

export interface AppsecScaValue {
  packages: AppsecScaPackage[];
  /** открытых групп SCA всего (до дедупликации по пакетам) */
  groups: number;
  /** групп, у которых codeBlock не разобрался как name@version */
  unparsed: number;
  /** страниц больше капа – список пакетов неполный */
  truncated?: true;
}

/** `name@1.2.3`, `@scope/name@1.2.3`, `group:artifact@1.0` → имя и версия; без `@` – только имя. */
export function parseScaPackage(codeBlock: unknown): { name: string; version: string | null } | null {
  if (typeof codeBlock !== "string") return null;
  const s = codeBlock.trim();
  if (s === "" || s.length > 300 || /\s/.test(s)) return null;
  const at = s.lastIndexOf("@");
  if (at <= 0) return { name: s, version: null };
  const name = s.slice(0, at);
  const version = s.slice(at + 1);
  return name === "" ? null : { name, version: version === "" ? null : version };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Значение факта: агрегаты и provenance скана. */
export interface AppsecFindingsFactValue {
  severity_counts: { critical: number; high: number; medium: number; low: number };
  resolved_share: number | null;
  secrets_critical: boolean;
  backlog: {
    open_groups: number;
    open_findings: number | null;
    engines: Record<string, number>;
    /** числовые severity как их отдала платформа – без декодирования, таблицы нет */
    severity_raw_counts: Record<string, number>;
    fetched_groups: number;
    truncated: boolean;
    /** разрез полученных групп по классам статуса */
    status_counts?: Record<string, number>;
  };
  provenance: {
    scan_uuid: string;
    commit_hash: string | null;
    time_finished: string | null;
    is_latest: boolean | null;
    group_ids: { publicId: number | null; uuid: string | null; engine: string | null }[];
    group_ids_note?: string;
  };
  /** уязвимые пакеты SCA; null – корзины SCA не ответили (причина в sca_note), подметрика без данных */
  sca?: AppsecScaValue | null;
  sca_note?: string;
}

/**
 * Сбор Security-факта одного репо. REST нужен только ради gitRepo – это id из
 * GET /repos/{slug}. Любая ошибка – no-data с причиной; скан, завершенный без
 * находок, – ok с нулями.
 */
export async function collectAppsec(
  rest: ScClient,
  appsec: AppsecClient,
  slug: string,
  opts: AppsecCollectOptions = {},
): Promise<AppsecCollectOutcome> {
  const now = opts.now ?? new Date();
  const pagesCap = opts.pagesCap ?? 20;
  const groupIdsCap = opts.groupIdsCap ?? 50;

  // --- gitRepo: внутренний id репозитория (строкой, как требует API) ---
  const repoRes = await rest.get(`/repos/${slug.split("/").map((s) => encodeURIComponent(s)).join("/")}`);
  if (repoRes.status === 401 || repoRes.status === 403) {
    return noData("access", `repo GET ${repoRes.status}`);
  }
  if (repoRes.status === 404) {
    return noData("no-scan", "repository not found");
  }
  if (repoRes.status !== 200) {
    return noData("incomplete", `repo GET ${repoRes.status}${repoRes.error ? `: ${repoRes.error}` : ""}`);
  }
  const gitRepo = (repoRes.json as { id?: unknown } | null)?.id;
  if (typeof gitRepo !== "string" || gitRepo === "") {
    return noData("incomplete", "repo GET: no id in response");
  }

  // --- scans/latest: завершен ли последний скан (числовой status не трогаем) ---
  const latest = await appsec.get("/v1/scans/latest", { gitRepo });
  if (latest.status === 401 || latest.status === 403) {
    return noData("access", `scans/latest ${latest.status}`);
  }
  if (latest.status === 404) {
    return noData("no-scan", "no scan has been run for this repository");
  }
  if (latest.status !== 200) {
    return noData("incomplete", `scans/latest ${latest.status}${latest.error ? `: ${latest.error}` : ""}`);
  }
  const scan = latest.json as Record<string, unknown> | null;
  const scanUuid = typeof scan?.["uuid"] === "string" ? scan.uuid : null;
  const timeFinishedMs = num(scan?.["timeFinished"]);
  if (scanUuid === null) {
    return noData("incomplete", "scans/latest: no uuid in response");
  }
  if (timeFinishedMs === null) {
    // скан есть, но не завершен – это «данных нет», а не «находок нет»
    return noData("no-scan", "latest scan is not finished yet (timeFinished is null)");
  }
  // завершенность = timeFinished и isLatest (обязательное булево поле
  // ScanSummaryDto спеки). Без isLatest скан, упавший с ошибкой или вытесненный
  // более новым, дал бы ok-факт с нулями – «уязвимостей нет» вместо «данных нет»
  if (scan?.["isLatest"] !== true) {
    return noData("no-scan", "latest scan is not current (isLatest is not true)");
  }

  // --- defect-groups по страницам с явным scanUuid, чтобы все запросы видели один скан ---
  const engines: Record<string, number> = {};
  const severityRaw: Record<string, number> = {};
  const groupIds: AppsecFindingsFactValue["provenance"]["group_ids"] = [];
  let openFindings = 0;
  const statusCounts: Record<string, number> = {};
  let skippedResolved = 0;
  let fetched = 0;
  let truncated = false;
  let totalSize: number | null = null;
  let token = "";
  let pages = 0;
  // если платформа вернет тот же курсор, мы бы ходили по кругу и считали
  // одни и те же группы многократно
  const seenTokens = new Set<string>([""]);
  while (pages < pagesCap) {
    const res = await appsec.get("/v1/defect-groups", {
      gitRepo,
      scanUuid,
      status: [...APPSEC_OPEN_STATUSES],
      pageSize: String(GROUPS_PAGE_SIZE),
      pageToken: token,
    });
    if (res.status !== 200) {
      return noData("incomplete", `defect-groups page ${pages + 1} → ${res.status}${res.error ? `: ${res.error}` : ""} (after ${res.attempts ?? 1} attempts)`, { bucket: `page ${pages + 1}`, attempts: res.attempts ?? 1 });
    }
    pages++;
    const body = res.json as { data?: unknown[]; nextPageToken?: unknown; totalSize?: unknown } | null;
    const data = Array.isArray(body?.data) ? body!.data! : [];
    for (const g of data as Record<string, unknown>[]) {
      // если платформа проигнорировала фильтр и отдала закрытую группу, в
      // бэклог она не идет, но попадает в разрез статусов
      const cls = defectGroupStatusClass(g["status"]);
      statusCounts[cls] = (statusCounts[cls] ?? 0) + 1;
      if (cls === "resolved") {
        skippedResolved++;
        continue;
      }
      fetched++;
      const engine = typeof g["engine"] === "string" ? g.engine : null;
      if (engine) engines[engine] = (engines[engine] ?? 0) + 1;
      const sev = g["severity"];
      if (typeof sev === "number" || typeof sev === "string") {
        const key = String(sev);
        severityRaw[key] = (severityRaw[key] ?? 0) + 1;
      }
      openFindings += num(g["findingsCount"]) ?? 0;
      if (groupIds.length < groupIdsCap) {
        groupIds.push({
          publicId: num(g["publicId"]),
          uuid: typeof g["uuid"] === "string" ? g.uuid : null,
          engine,
        });
      }
    }
    if (totalSize === null && num(body?.totalSize) !== null) totalSize = num(body?.totalSize);
    const next = body?.nextPageToken;
    if (typeof next !== "string" || next === "") break;
    if (seenTokens.has(next)) {
      return noData("incomplete", `defect-groups: repeated nextPageToken after page ${pages} (pagination loop)`);
    }
    seenTokens.add(next);
    token = next;
    if (pages === pagesCap) truncated = true;
  }
  if (totalSize === null) totalSize = fetched + skippedResolved;
  // получено больше, чем платформа обещала: страницы пересеклись, и честнее не
  // считать вовсе, чем показать завышенный бэклог
  if (fetched + skippedResolved > totalSize) {
    return noData("incomplete", `defect-groups: fetched ${fetched} groups against totalSize ${totalSize} (overlapping pages)`);
  }
  if (fetched + skippedResolved < totalSize) truncated = true;
  // бэклог – только открытые группы (закрытые, отданные вопреки фильтру, вычитаем)
  totalSize -= skippedResolved;

  // --- серьезность классифицирует платформа (именованные фильтры) ---
  const counts: AppsecFindingsFactValue["severity_counts"] = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const bucket of SEVERITY_BUCKETS) {
    // остальным корзинам нужен только totalSize; CRITICAL берем полной
    // страницей, чтобы заодно увидеть движки критичных групп
    const pageSize = bucket === "CRITICAL" ? String(GROUPS_PAGE_SIZE) : "1";
    // только открытые группы: плотность не должна штрафовать за закрытое
    const res = await appsec.get("/v1/defect-groups", { gitRepo, scanUuid, severity: bucket, status: [...APPSEC_OPEN_STATUSES], pageSize, pageToken: "" });
    if (res.status !== 200) {
      return noData("incomplete", `defect-groups severity=${bucket} → ${res.status}${res.error ? `: ${res.error}` : ""} (after ${res.attempts ?? 1} attempts)`, { bucket: `severity=${bucket}`, attempts: res.attempts ?? 1 });
    }
    const body = res.json as { totalSize?: unknown; data?: unknown[] } | null;
    const size = num(body?.totalSize);
    if (size === null) {
      return noData("incomplete", `defect-groups severity=${bucket}: no totalSize`);
    }
    counts[bucket.toLowerCase() as keyof typeof counts] = size;
  }

  // --- критичные секреты: фильтр платформы `type`, а не догадка по имени движка ---
  // Живые движки называются KICS, Opengrep и т.п., по имени секреты не узнать.
  // Спека AppSec документирует параметр `type` (SECRETS, SCA, SAST, SBOM_*,
  // DAST, AI_AUDIT) – классификация остается на стороне платформы.
  const secretsRes = await appsec.get("/v1/defect-groups", {
    gitRepo,
    scanUuid,
    type: SECRETS_TYPE,
    // исправленный или ложный секрет не должен держать потолок 49
    status: [...APPSEC_OPEN_STATUSES],
    severity: "CRITICAL",
    pageSize: "1",
    pageToken: "",
  });
  if (secretsRes.status !== 200) {
    return noData("incomplete", `defect-groups type=${SECRETS_TYPE} → ${secretsRes.status}${secretsRes.error ? `: ${secretsRes.error}` : ""} (after ${secretsRes.attempts ?? 1} attempts)`, { bucket: `type=${SECRETS_TYPE}`, attempts: secretsRes.attempts ?? 1 });
  }
  const secretsTotal = num((secretsRes.json as { totalSize?: unknown } | null)?.totalSize);
  if (secretsTotal === null) {
    return noData("incomplete", `defect-groups type=${SECRETS_TYPE}: no totalSize`);
  }
  const secretsCritical = secretsTotal > 0;

  // --- уязвимые пакеты SCA: по корзинам критичности платформы (от худшей к лучшей),
  // пакет = codeBlock `name@version`; Trivy и grype находят одни пакеты под разными
  // CVE, поэтому считаем пакеты, а не группы. Сбой корзины SCA – не incomplete
  // всего факта: без списка пакетов подметрика «нет данных», остальная
  // категория считается как раньше
  let sca: AppsecScaValue | null = null;
  let scaNote: string | undefined;
  {
    const byPackage = new Map<string, AppsecScaPackage>();
    let groups = 0;
    let unparsed = 0;
    let scaTruncated = false;
    let failed: string | null = null;
    // открытых групп нет — корзины SCA пусты по построению, 4 запроса не нужны
    for (const bucket of totalSize === 0 ? [] : SEVERITY_BUCKETS) {
      let token = "";
      let pages = 0;
      let fetchedInBucket = 0;
      let bucketTotal: number | null = null;
      const seen = new Set<string>([""]);
      while (pages < SCA_PAGES_CAP) {
        const res = await appsec.get("/v1/defect-groups", {
          gitRepo,
          scanUuid,
          type: SCA_TYPE,
          severity: bucket,
          status: [...APPSEC_OPEN_STATUSES],
          pageSize: String(GROUPS_PAGE_SIZE),
          pageToken: token,
        });
        if (res.status !== 200) {
          failed = `defect-groups type=${SCA_TYPE} severity=${bucket} → ${res.status}${res.error ? `: ${res.error}` : ""}`;
          break;
        }
        pages++;
        const body = res.json as { data?: unknown[]; nextPageToken?: unknown; totalSize?: unknown } | null;
        if (bucketTotal === null) bucketTotal = num(body?.totalSize);
        for (const g of (Array.isArray(body?.data) ? body!.data! : []) as Record<string, unknown>[]) {
          fetchedInBucket++;
          if (defectGroupStatusClass(g["status"]) === "resolved") continue;
          groups++;
          const pkg = parseScaPackage(g["codeBlock"]);
          if (pkg === null) {
            unparsed++;
            continue;
          }
          const key = `${pkg.name}@${pkg.version ?? ""}`;
          const engine = typeof g["engine"] === "string" ? g.engine : null;
          const known = byPackage.get(key);
          if (known) {
            known.advisories++;
            if (engine && !known.engines.includes(engine)) known.engines.push(engine);
          } else {
            byPackage.set(key, { name: pkg.name, version: pkg.version, severity: bucket.toLowerCase() as AppsecScaSeverity, advisories: 1, engines: engine ? [engine] : [] });
          }
        }
        const next = body?.nextPageToken;
        if (typeof next !== "string" || next === "") break;
        if (seen.has(next)) {
          failed = `defect-groups type=${SCA_TYPE} severity=${bucket}: repeated nextPageToken (pagination loop)`;
          break;
        }
        seen.add(next);
        token = next;
        if (pages === SCA_PAGES_CAP) scaTruncated = true;
      }
      if (failed !== null) break;
      // платформа обещала больше групп, чем отдала (пустой курсор раньше totalSize) — список неполный
      if (bucketTotal !== null && fetchedInBucket < bucketTotal) scaTruncated = true;
    }
    if (failed !== null) scaNote = failed;
    else {
      sca = {
        packages: [...byPackage.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? "")),
        groups,
        unparsed,
        ...(scaTruncated ? { truncated: true as const } : {}),
      };
    }
  }

  // --- resolved_share из именованных полей scans/latest ---
  const open = num(scan?.["openDefectGroups"]);
  const total = num(scan?.["totalDefectGroups"]);
  const resolvedShare = open !== null && total !== null && total > 0 ? Math.round((1 - open / total) * 1000) / 1000 : null;

  const value: AppsecFindingsFactValue = {
    severity_counts: counts,
    resolved_share: resolvedShare,
    secrets_critical: secretsCritical,
    backlog: {
      open_groups: totalSize,
      open_findings: truncated ? null : openFindings,
      engines,
      severity_raw_counts: severityRaw,
      fetched_groups: fetched,
      truncated,
      // open | resolved | unrecognized | unknown
      status_counts: statusCounts,
    },
    provenance: {
      scan_uuid: scanUuid,
      commit_hash: typeof scan?.["commitHash"] === "string" ? scan.commitHash : null,
      time_finished: new Date(timeFinishedMs).toISOString(),
      is_latest: scan?.["isLatest"] === true,
      group_ids: groupIds,
      ...(fetched > groupIds.length ? { group_ids_note: `first ${groupIdsCap} of ${fetched} groups` } : {}),
    },
    sca,
    ...(scaNote !== undefined ? { sca_note: scaNote } : {}),
  };
  return { fact: okFact("appsec.findings", value, "appsec:api", now.toISOString()), noData: null };
}

function noData(reason: AppsecNoData["reason"], detail: string, extra: { bucket?: string; attempts?: number } = {}): AppsecCollectOutcome {
  return { fact: null, noData: { reason, detail, ...extra } };
}

/** Факт no-data для сканов без AppSec-канала (например, PAT не сохранен). */
export function appsecNoDataFact(reason: AppsecNoData["reason"], detail: string, now = new Date()): Fact {
  return noDataFact("appsec.findings", reason, "appsec:api", detail, now.toISOString());
}
