// appsec.ts — официальный AppSec API SourceCraft (В4/Б2, решение 16.09
// Екатерина + спецификация docs/SCS-API-1.0.0-draft.pdf — закон):
// read-only GET-клиент appsec.sourcecraft.tech с Bearer PAT.
// Порядок (детерминизм): REST /repos/{slug}.id → gitRepo →
// /v1/scans/latest (детекторы завершённости — timeFinished/isLatest;
// числовой status НЕ декодируем: таблицы соответствия нет) →
// /v1/defect-groups с ЯВНЫМ scanUuid по страницам (data/nextPageToken/
// totalSize, pageSize ≤250) + именованные severity-фильтры платформы
// (severity=CRITICAL|HIGH|MEDIUM|LOW — классификация на стороне
// платформы, не наша). Храним ТОЛЬКО агрегаты и стабильные id групп
// (publicId/uuid; числовой id устарел) — без кода, путей и секретов.
// Tri-state: 401/403/нет права → no-data access; нет/незавершён скан →
// no-data no-scan; неполный ответ → no-data incomplete («не трактовать
// ошибку как отсутствие уязвимостей» — докам вслед, наш закон 2).
import { noDataFact, okFact, type Fact } from "./facts";
import type { ScClient } from "./http";

export const APPSEC_BASE_URL = "https://appsec.sourcecraft.tech";

export interface AppsecGet {
  status: number;
  json: unknown;
  error?: string;
}

export interface AppsecClient {
  get(path: string, params: Record<string, string>): Promise<AppsecGet>;
  requestCount(): number;
}

export interface AppsecClientOptions {
  token: string;
  /** адрес AppSec-хоста (`Config.api.appsecBase`) — ОБЯЗАТЕЛЕН, как у `makeScClient` (М7 круга 2) */
  baseUrl: string;
  /** ≥100мс между запросами (лимиты частоты в доке не определены — бережность наша) */
  minIntervalMs?: number;
  maxRequests?: number;
  timeoutMs?: number;
}

/** Живой клиент: интервал, таймаут, один ретрай на временные сбои (429/5xx/сеть). */
export function makeAppsecClient(opts: AppsecClientOptions): AppsecClient {
  const baseUrl = opts.baseUrl;
  const minInterval = opts.minIntervalMs ?? 100;
  const maxRequests = opts.maxRequests ?? 40;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let count = 0;
  let lastAt = 0;

  const once = async (path: string, params: Record<string, string>): Promise<AppsecGet> => {
    const qs = new URLSearchParams(params).toString();
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
        /* не json — остаётся в error-тексте ниже */
      }
      return { status: res.status, json, error: json === null ? bodyText.slice(0, 120) : undefined };
    } catch (e) {
      return { status: 0, json: null, error: String((e as Error).message ?? e).slice(0, 160) };
    }
  };

  return {
    async get(path, params) {
      if (count >= maxRequests) {
        return { status: 0, json: null, error: `budget exhausted: ${maxRequests} requests` };
      }
      const wait = minInterval - (Date.now() - lastAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
      count++;
      const first = await once(path, params);
      // ретрай только временные: сеть (status 0), 429, 5xx
      if (first.status === 0 || first.status === 429 || first.status >= 500) {
        await new Promise((r) => setTimeout(r, 600));
        const second = await once(path, params);
        count++;
        return second;
      }
      return first;
    },
    requestCount: () => count,
  };
}

// ---------- сбор факта ----------

export interface AppsecNoData {
  reason: "access" | "no-scan" | "incomplete";
  detail: string;
}

export interface AppsecCollectOutcome {
  /** ok-факт appsec.findings (включая пустой завершённый скан) */
  fact: Fact | null;
  noData: AppsecNoData | null;
}

export interface AppsecCollectOptions {
  now?: Date;
  /** кап страниц defect-groups (защита от бесконечной пагинации) */
  pagesCap?: number;
  /** кап стабильных id групп в provenance (факт не пухнет на сотнях групп) */
  groupIdsCap?: number;
}

const SEVERITY_BUCKETS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const GROUPS_PAGE_SIZE = 250;
/** Тип движка секретов в спеке AppSec (`type` у /v1/defect-groups). */
export const SECRETS_TYPE = "SECRETS";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Значение факта: агрегаты + provenance (контракт плана Б2 + формы SCS API). */
export interface AppsecFindingsFactValue {
  severity_counts: { critical: number; high: number; medium: number; low: number };
  resolved_share: number | null;
  secrets_critical: boolean;
  backlog: {
    open_groups: number;
    open_findings: number | null;
    engines: Record<string, number>;
    /** ЧИСЛОВЫЕ severity как отдал платформа — показ без декодирования (таблицы нет) */
    severity_raw_counts: Record<string, number>;
    fetched_groups: number;
    truncated: boolean;
  };
  provenance: {
    scan_uuid: string;
    commit_hash: string | null;
    time_finished: string | null;
    is_latest: boolean | null;
    group_ids: { publicId: number | null; uuid: string | null; engine: string | null }[];
    group_ids_note?: string;
  };
}

/**
 * Сбор Security-факта одного репо. Канал REST нужен только для gitRepo
 * (id из GET /repos/{slug} — подтверждено живьём 17.09). Любая ошибка —
 * no-data с причиной; «скан завершён без находок» = ok с нулями.
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
  const repoRes = await rest.get(`/repos/${slug}`);
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

  // --- scans/latest: завершён ли последний скан (числовой status НЕ трогаем) ---
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
    // скан есть, но не завершён — это «данных нет», не «находок нет»
    return noData("no-scan", "latest scan is not finished yet (timeFinished is null)");
  }
  // Ф2.6 (M8): завершённость = timeFinished И isLatest. Числовой `status` не
  // декодируем (таблицы соответствия нет), но `isLatest` — булево поле спеки
  // (ScanSummaryDto.isLatest, required). Скан, завершившийся с ошибкой или
  // вытесненный более новым, отдавал ok-факт с нулями — то есть «уязвимостей
  // нет» вместо «данных нет» (нарушение закона 2 и прямой риск Score)
  if (scan?.["isLatest"] !== true) {
    return noData("no-scan", "latest scan is not current (isLatest is not true)");
  }

  // --- defect-groups по страницам с ЯВНЫМ scanUuid (детерминизм) ---
  const engines: Record<string, number> = {};
  const severityRaw: Record<string, number> = {};
  const groupIds: AppsecFindingsFactValue["provenance"]["group_ids"] = [];
  let openFindings = 0;
  let fetched = 0;
  let truncated = false;
  let totalSize: number | null = null;
  let token = "";
  let pages = 0;
  // Ф2.6: платформа, вернувшая ТОТ ЖЕ курсор, крутила бы нас по одной
  // странице — счётчики росли бы кратно числу оборотов (двойной счёт)
  const seenTokens = new Set<string>([""]);
  while (pages < pagesCap) {
    const res = await appsec.get("/v1/defect-groups", {
      gitRepo,
      scanUuid,
      pageSize: String(GROUPS_PAGE_SIZE),
      pageToken: token,
    });
    if (res.status !== 200) {
      return noData("incomplete", `defect-groups page ${pages + 1} → ${res.status}${res.error ? `: ${res.error}` : ""}`);
    }
    pages++;
    const body = res.json as { data?: unknown[]; nextPageToken?: unknown; totalSize?: unknown } | null;
    const data = Array.isArray(body?.data) ? body!.data! : [];
    for (const g of data as Record<string, unknown>[]) {
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
  if (totalSize === null) totalSize = fetched;
  // получено БОЛЬШЕ, чем платформа обещала: страницы пересеклись, агрегаты
  // не сходятся — честнее не считать вовсе, чем показать завышенный бэклог
  if (fetched > totalSize) {
    return noData("incomplete", `defect-groups: fetched ${fetched} groups against totalSize ${totalSize} (overlapping pages)`);
  }
  if (fetched < totalSize) truncated = true;

  // --- severity-классификация платформой (именованные фильтры) ---
  const counts: AppsecFindingsFactValue["severity_counts"] = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const bucket of SEVERITY_BUCKETS) {
    // CRITICAL берём страницей побольше: заодно движки критичных групп
    const pageSize = bucket === "CRITICAL" ? String(GROUPS_PAGE_SIZE) : "1";
    const res = await appsec.get("/v1/defect-groups", { gitRepo, scanUuid, severity: bucket, pageSize, pageToken: "" });
    if (res.status !== 200) {
      return noData("incomplete", `defect-groups severity=${bucket} → ${res.status}${res.error ? `: ${res.error}` : ""}`);
    }
    const body = res.json as { totalSize?: unknown; data?: unknown[] } | null;
    const size = num(body?.totalSize);
    if (size === null) {
      return noData("incomplete", `defect-groups severity=${bucket}: no totalSize`);
    }
    counts[bucket.toLowerCase() as keyof typeof counts] = size;
  }

  // --- критичные секреты: ФИЛЬТР платформы, а не догадка по имени движка ---
  // Ф2.6 (M8): было — регулярка /secret/i по полю `engine` первой страницы
  // CRITICAL. Живые движки зовутся KICS/Opengrep, «Secrets Scanner» из
  // тестовой фикстуры выдуман, и кап 49 в проде, вероятно, не срабатывал
  // никогда. Спека AppSec документирует параметр `type` (SECRETS, SCA, SAST,
  // SBOM_*, DAST, AI_AUDIT) — классификация остаётся на стороне платформы.
  const secretsRes = await appsec.get("/v1/defect-groups", {
    gitRepo,
    scanUuid,
    type: SECRETS_TYPE,
    severity: "CRITICAL",
    pageSize: "1",
    pageToken: "",
  });
  if (secretsRes.status !== 200) {
    return noData("incomplete", `defect-groups type=${SECRETS_TYPE} → ${secretsRes.status}${secretsRes.error ? `: ${secretsRes.error}` : ""}`);
  }
  const secretsTotal = num((secretsRes.json as { totalSize?: unknown } | null)?.totalSize);
  if (secretsTotal === null) {
    return noData("incomplete", `defect-groups type=${SECRETS_TYPE}: no totalSize`);
  }
  const secretsCritical = secretsTotal > 0;

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
    },
    provenance: {
      scan_uuid: scanUuid,
      commit_hash: typeof scan?.["commitHash"] === "string" ? scan.commitHash : null,
      time_finished: new Date(timeFinishedMs).toISOString(),
      is_latest: scan?.["isLatest"] === true,
      group_ids: groupIds,
      ...(fetched > groupIds.length ? { group_ids_note: `first ${groupIdsCap} of ${fetched} groups` } : {}),
    },
  };
  return { fact: okFact("appsec.findings", value, "appsec:api", now.toISOString()), noData: null };
}

function noData(reason: AppsecNoData["reason"], detail: string): AppsecCollectOutcome {
  return { fact: null, noData: { reason, detail } };
}

/** Факт no-data для сканов без AppSec-канала (например, PAT не сохранён). */
export function appsecNoDataFact(reason: AppsecNoData["reason"], detail: string, now = new Date()): Fact {
  return noDataFact("appsec.findings", reason, "appsec:api", detail, now.toISOString());
}
