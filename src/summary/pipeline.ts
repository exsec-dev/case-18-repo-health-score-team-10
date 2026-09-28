// Конвейер AI-сводки: факты скана + недоверенный контент → специалисты параллельно
// (side-модель; security — без инструментов, только данные AppSec) → overview (main)
// на их сегментах → валидатор с ретраями → ai_notes.
// Агрегатный кап: ≤ 48 вызовов модели и фуз 6 минут на ВСЮ генерацию.
// Нет фактов роли — вызова нет, причина записывается. Невалидный текст в продукт
// не попадает, роль уходит в failSoft. Конвейер пишет ТОЛЬКО ai_notes: Score считает
// код, LLM его не трогает.
import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallLlm, ChatMessage } from "../llm";
import { LlmError } from "../llm";
import { GENERATION_FUSE_MS, MAX_MODEL_CALLS } from "../config";
// капы генерации живут в config (от фуза зависит оценка худшего времени скана);
// ре-экспорт — для тех, кто импортирует их отсюда
export { GENERATION_FUSE_MS, MAX_MODEL_CALLS };
import { parseFactValue } from "../collectors/facts";
import { MODEL_VERSION } from "../score/model";
import { loadCharter } from "./charters";
import { generateWithTools } from "./agent";
import { makeCalculatorExecutor, makeToolExecutor, sanitizeUntrusted, MAX_PLAIN_READ_BYTES } from "./tools";
import { frameUntrusted, makeNonce } from "./input";
import { validateFlagOutput, validateOutput, type FraudFlag, type FactInput } from "./validator";
import type { SummaryRole } from "./roles";
import { modelTierOf, PUBLIC_CATEGORIES, PUBLIC_SPECIALIST_ROLES, ROLE_FACT_CATEGORIES, SPECIALIST_ROLES, toolsAllowed, type SpecialistRole } from "./roles";
import { categoryOf } from "../collectors/facts";
import { rhythmSignals, RHYTHM_KEY, type RhythmSignals } from "./rhythm";
import { CHANNEL_KINDS } from "../score/compute";
import type { AiAudience } from "../db";

export interface SummaryDeps {
  db: Database;
  org: string;
  repo: string;
  callLlm: CallLlm;
  /** рабочий каталог клона + git-каталог: инструменты и недоверенный контент; null → специалисты без инструментов */
  clone?: { root: string; gitDir: string | null } | null;
  models?: { main: string; side: string };
  budgets?: { maxModelCalls?: number; fuseMs?: number };
  /** бэкофф ретраев цикла (тесты ставят 0) */
  agentBackoffMs?: number;
  /**
   * Кэш по скану: false — регенерация, заметки скана перезаписываются.
   * Воркер ставит false ТОЛЬКО при отладочном куладауне (1 мс снимает обе
   * защиты от дублей); по умолчанию true.
   */
  cache?: boolean;
  log?: (m: string) => void;
}

export interface SummaryRequest {
  scanId: number;
  now?: Date;
  /**
   * Аудитория текста. 'public' — только 4 открытые категории и их
   * факты (без CI/CD и Безопасности), текст видят все; 'full' (дефолт) — все
   * факты скана, текст только зрителю с полным Score.
   */
  audience?: AiAudience;
}

export interface SummaryRoleOutcome {
  role: SummaryRole;
  ok: boolean;
  /** причина честного пропуска (нет фактов) или fail-soft (валидатор/бюджет) */
  reason?: string;
  chars?: number;
  retries?: number;
  /** цифры роли для логов: латентность, вызовы модели, вызовы инструментов */
  ms?: number;
  calls?: number;
  tools?: number;
}

export interface SummaryRunResult {
  scanId: number;
  /** записано строк ai_notes */
  notes: number;
  /** роли, чей текст не доехал (валидатор/бюджет) — «AI-описание не сформировано» */
  failSoft: string[];
  /** роли без фактов своей категории — вызова не было */
  skipped: string[];
  outcomes: SummaryRoleOutcome[];
  /** вызовов модели с ответом; 0 — модель не ответила ни разу (лимит не списывается) */
  answered?: number;
  /** у скана уже есть ai_notes — генерация не запускалась */
  cached?: boolean;
}

interface RunBudget {
  calls: number;
  /** вызовов, на которые модель ОТВЕТИЛА — от них зависит списание лимита */
  answered: number;
  max: number;
  ac: AbortController;
}

function takeCall(budget: RunBudget): void {
  budget.calls++;
  if (budget.calls > budget.max) throw new LlmError("budget", "исчерпан агрегатный бюджет генерации");
}

/** Обёртка callLlm с общим счётчиком и фузом на всю генерацию. */
function budgetedCallLlm(callLlm: CallLlm, budget: RunBudget): CallLlm {
  return async (opts) => {
    takeCall(budget);
    // сигнал раунда и агрегатный фуз связаны: сработать должен любой
    const ac = new AbortController();
    const relay = (): void => ac.abort();
    opts.signal?.addEventListener("abort", relay, { once: true });
    budget.ac.signal.addEventListener("abort", relay, { once: true });
    try {
      const res = await callLlm({ ...opts, signal: ac.signal });
      budget.answered++;
      return res;
    } finally {
      opts.signal?.removeEventListener("abort", relay);
      budget.ac.signal.removeEventListener("abort", relay);
    }
  };
}

/**
 * Ок-факты скана в скоупе роли. Для публичной аудитории — только факты
 * 4 открытых категорий и никаких фактов каналов с правами
 * (CHANNEL_KINDS: конфиги и запуски CI, находки AppSec).
 */
export function scopedFacts(db: Database, scanId: number, role: SummaryRole, audience: AiAudience = "full"): FactInput[] {
  const rows = db.query("SELECT key, value, status FROM facts WHERE scan_id = ?").all(scanId) as {
    key: string;
    value: string;
    status: string;
  }[];
  return rows
    .filter((r) => r.status === "ok")
    .filter((r) => audience === "full" || publicFactKey(r.key))
    .map((r) => ({ key: r.key, value: parseFactValue(r.value) }))
    .filter((f) => roleFactsAllowed(role, f.key))
    .map(capTimelineFact)
    .map((f) => (audience === "public" ? withoutEmails(f) : f));
}

/**
 * Публичный обзор видят анонимы и печатает PDF, поэтому адреса почты
 * авторов и коммиттеров из ленты во вход модели не идут (имена и даты остаются: ритм и
 * авторство видны и без адресов).
 */
function withoutEmails(f: FactInput): FactInput {
  const raw = f.value as { events?: unknown } | null;
  if (f.key !== "activity.git.timeline" || raw === null || typeof raw !== "object" || !Array.isArray(raw.events)) return f;
  const strip = (p: unknown): unknown => {
    if (p === null || typeof p !== "object") return p;
    const { email: _email, ...rest } = p as Record<string, unknown>;
    return rest;
  };
  const events = raw.events.map((e) => {
    if (e === null || typeof e !== "object") return e;
    const ev = e as Record<string, unknown>;
    return { ...ev, author: strip(ev.author), committer: strip(ev.committer) };
  });
  return { ...f, value: { ...(raw as Record<string, unknown>), events } };
}

/** Факт открыт публичной аудитории: категория из 4 открытых и не канал с правами. */
export function publicFactKey(key: string): boolean {
  return !CHANNEL_KINDS.includes(key) && (PUBLIC_CATEGORIES as readonly string[]).includes(categoryOf(key));
}

function roleFactsAllowed(role: SummaryRole, key: string): boolean {
  if (!(SPECIALIST_ROLES as readonly string[]).includes(role)) return key !== "activity.git.timeline"; // overview/trajectory: все, кроме сырой ленты коммитов
  const allowed = ROLE_FACT_CATEGORIES[role as SpecialistRole] ?? [];
  return allowed.includes(categoryOf(key));
}

export interface TrajectoryPoint {
  date: string | null;
  headSha: string | null;
  index: number | null;
  coverage: number;
  categories: Record<string, number | null>;
}

/**
 * Числовые точки для роли динамики: ВСЕ строки scores репо текущей версии
 * модели по возрастанию — дата, коммит, индекс, покрытие, категории. Прошлые
 * LLM-тексты во вход не попадают, чтобы модель не пересказывала сама себя.
 * Без точек роль динамики не запускается.
 */
export function historyPoints(db: Database, scanId: number, audience: AiAudience = "full"): TrajectoryPoint[] {
  const row = db.query("SELECT repo_id FROM scans WHERE id = ?").get(scanId) as { repo_id: number } | null;
  if (!row) return [];
  const rows = db
    .query(
      `SELECT sc.scan_id, sc.healthcraft_index AS idx, sc.index_coverage AS coverage, sc.categories, s.finished_at AS finished_at, s.head_sha AS head_sha
       FROM scores sc JOIN scans s ON s.id = sc.scan_id
       WHERE sc.repo_id = ? AND sc.model_version = ?
       ORDER BY sc.scan_id ASC`,
    )
    .all(row.repo_id, MODEL_VERSION) as { scan_id: number; idx: number | null; coverage: number; categories: string; finished_at: string | null; head_sha: string | null }[];
  return rows.map((r) => {
    // битый categories JSON — точка без категорий, а не падение всего runSummary
    // мимо fail-soft отдельных ролей
    let cats: Record<string, { score: number | null }> = {};
    try {
      const parsed = JSON.parse(r.categories) as Record<string, { score: number | null }> | null;
      if (parsed !== null && typeof parsed === "object") cats = parsed;
    } catch {
      cats = {};
    }
    const categories: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(cats)) {
      // публичной аудитории — баллы только открытых категорий
      if (audience === "public" && !(PUBLIC_CATEGORIES as readonly string[]).includes(key)) continue;
      categories[key] = value?.score ?? null;
    }
    return { date: r.finished_at, headSha: r.head_sha, index: r.idx, coverage: r.coverage, categories };
  });
}

/**
 * Категории в точках — русскими названиями интерфейса, а не ключами: переводя
 * ключи сама, модель путала категории.
 */
export function namedTrajectoryPoints(points: TrajectoryPoint[]): TrajectoryPoint[] {
  return points.map((p) => ({ ...p, categories: Object.fromEntries(Object.entries(p.categories).map(([k, v]) => [(CATEGORY_TITLES as Record<string, string>)[k] ?? k, v])) }));
}
/** Сегменты для overview: тексты специалистов, разбитые на предложения. */
export function segmentsOf(texts: Record<string, string>): { segments: string[]; numbered: Record<string, string> } {
  const segments: string[] = [];
  const numbered: Record<string, string> = {};
  for (const [role, text] of Object.entries(texts)) {
    const parts = text.split(/(?<=[.!?…])\s+/).filter((p) => p.trim().length > 0);
    parts.forEach((p, i) => {
      const id = `sp:${role}:${i + 1}`;
      segments.push(id);
      numbered[id] = p.trim();
    });
  }
  return { segments, numbered };
}

/**
 * Сырая лента обрезается до последних N событий: большой репо иначе отправил бы
 * в промпт мегабайты истории (> 128K токенов). Агрегат (activity.git.summary)
 * остается полным — ритм виден целиком.
 */
export const TIMELINE_EVENTS_CAP = 60;

export function capTimelineFact(f: FactInput): FactInput {
  const raw = f.value as { events?: unknown } | null;
  if (f.key !== "activity.git.timeline" || raw === null || typeof raw !== "object" || !Array.isArray(raw.events)) return f;
  const events = raw.events;
  if (events.length <= TIMELINE_EVENTS_CAP) return f;
  // `git log` отдает события от новых к старым (collectors/git.ts): последние N —
  // это ГОЛОВА массива, а не хвост
  return { ...f, value: { events: events.slice(0, TIMELINE_EVENTS_CAP), capped: true, total: events.length } };
}

function factsDigest(facts: FactInput[]): string {
  return facts.map((f) => `- ${f.key}: ${JSON.stringify(f.value)}`).join("\n");
}

// нормализация типографики — отдельный модуль, его берет и веб-бандл
export { normalizeTypography } from "./typography";
import { normalizeTypography } from "./typography";
import { CATEGORY_TITLES } from "../report/categories";

/**
 * Попыток генерации на роль: ретрай с причинами валидатора просит модель
 * поправиться. Запросы дешевые, а две попытки слишком часто теряли роль
 * из-за одной опечатки.
 */
const ROLE_ATTEMPTS = 3;

/**
 * Одна роль: хартия → вход (факты + nonce-рамки контента) → генерация →
 * валидация → ретрай с припиской причин → итог. Возвращает clean-текст.
 */
async function runRole(
  deps: SummaryDeps,
  budget: RunBudget,
  role: SummaryRole,
  facts: FactInput[],
  contentBlocks: string[],
  extraSegments: { segments: string[]; numbered: Record<string, string> } | null,
): Promise<
  | { ok: true; text: string; clean: string; refs: string[]; retries: number; ms: number; calls: number; tools: number }
  | { ok: false; reason: string }
> {
  const charter = loadCharter(role);
  const nonce = makeNonce();
  const inputBlocks = [...contentBlocks];
  if (extraSegments !== null) {
    // рамка сегментов с nonce: специалист не может напечатать «конец ответов»
    // и подменить контекст overview своими рамками
    inputBlocks.push(
      [
        `=== НАЧАЛО ОТВЕТОВ СПЕЦИАЛИСТОВ (nonce ${nonce}) ===`,
        ...Object.entries(extraSegments.numbered).map(([id, text]) => `{${id}} ${text}`),
        `=== КОНЕЦ ОТВЕТОВ СПЕЦИАЛИСТОВ (nonce ${nonce}) ===`,
      ].join("\n"),
    );
  }
  const userText = [
    "ФАКТЫ СКАНА (числа только из этого списка):",
    factsDigest(facts),
    ...(inputBlocks.length > 0 ? ["", ...inputBlocks] : []),
  ].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: charter.text },
    { role: "user", content: userText },
  ];

  // security живет без файловых инструментов (только данные AppSec), но
  // арифметику долей считает калькулятором, а не в уме
  const executor =
    deps.clone && toolsAllowed(role)
      ? makeToolExecutor({ root: deps.clone.root, gitDir: deps.clone.gitDir }, 12)
      : role === "security"
        ? makeCalculatorExecutor()
        : null;

  let retries = 0;
  let lastReasons: string[] = [];
  for (let attempt = 0; attempt < ROLE_ATTEMPTS; attempt++) {
    const callMessages: ChatMessage[] =
      attempt === 0
        ? messages
        : [
            ...messages,
            { role: "assistant", content: "Понял, готовлю исправленный ответ." },
            {
              role: "user",
              content: `Предыдущий ответ ОТКЛОНЁН валидатором по причинам:\n${lastReasons.map((r) => `- ${r}`).join("\n")}\nИсправь их и выдай новый ответ строго по формату хартии.`,
            },
          ];
    const startedAt = Date.now();
    let text = "";
    let calls = 0;
    let tools = 0;
    try {
      const res = await generateWithTools(
        {
          callLlm: budgetedCallLlm(deps.callLlm, budget),
          role,
          executor: executor === null ? null : { specs: executor.specs, execute: executor.execute, budgetLeft: executor.budgetLeft },
          backoffMs: deps.agentBackoffMs,
          log: deps.log,
        },
        callMessages,
      );
      text = normalizeTypography(res.text);
      calls = res.modelCalls;
      tools = res.toolCalls;
    } catch (e) {
      deps.log?.(
        `[summary] ${deps.org}/${deps.repo} role=${role}: fail ${Date.now() - startedAt}ms модель: ${String((e as Error).message).slice(0, 120)}`,
      );
      return { ok: false, reason: `модель: ${String((e as Error).message).slice(0, 160)}` };
    }
    const ms = Date.now() - startedAt;
    const verdict = validateOutput({ role, text, facts, segments: extraSegments?.segments ?? [] });
    if (verdict.ok) {
      deps.log?.(`[summary] ${deps.org}/${deps.repo} role=${role}: ok ${ms}ms calls=${calls} tools=${tools} chars=${verdict.clean.length}`);
      return { ok: true, text, clean: verdict.clean, refs: verdict.refs, retries, ms, calls, tools };
    }
    const lastTry = attempt === ROLE_ATTEMPTS - 1;
    // полные причины и ПОЛНЫЙ ответ модели в лог, без обрезки: иначе нечем
    // сравнивать попытки и не видно, что именно модель написала
    deps.log?.(
      `[summary] ${deps.org}/${deps.repo} role=${role}: rejected ${ms}ms — ${
        lastTry ? "попытки исчерпаны" : "ретрай"
      }\n[summary] причины: ${verdict.reasons.join("; ")}\n[summary] полный ответ модели: ${JSON.stringify(sanitizeUntrusted(text))}`,
    );
    lastReasons = verdict.reasons;
    retries = attempt + 1;
  }
  return { ok: false, reason: `валидатор: ${lastReasons.join("; ")}` };
}

function writeNote(
  deps: SummaryDeps,
  scanId: number,
  repoId: number,
  role: SummaryRole,
  text: string,
  refs: string[],
  now: Date,
  audience: AiAudience,
): void {
  const model = modelTierOf(role) === "main" ? (deps.models?.main ?? "main") : (deps.models?.side ?? "side");
  deps.db
    .query(
      "INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(repoId, scanId, role, text, JSON.stringify(refs), loadCharter(role).version, model, now.toISOString(), audience);
}

function repoIdOf(deps: SummaryDeps): number {
  const row = deps.db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(deps.org, deps.repo) as
    | { id: number }
    | null;
  if (!row) throw new Error(`repo ${deps.org}/${deps.repo} not found`);
  return row.id;
}

/**
 * Полная генерация для скана. Пишет ТОЛЬКО ai_notes (и ai_fails); Score, категории
 * и рекомендации не трогаются ни при каком исходе.
 */
export async function runSummary(deps: SummaryDeps, req: SummaryRequest): Promise<SummaryRunResult> {
  const now = req.now ?? new Date();
  const repoId = repoIdOf(deps);
  const audience: AiAudience = req.audience ?? "full";
  const roles: readonly SpecialistRole[] = audience === "public" ? PUBLIC_SPECIALIST_ROLES : SPECIALIST_ROLES;
  // Кэш по скану: если заметки уже записаны (например, повтор заявки после падения
  // воркера), вторая генерация не запускается — кредиты не тратятся. Регенерация
  // (cache: false) перезаписывает заметки: у скана всегда не больше одного набора.
  // Проверка на накрутку (flagger) — своя заявка со своим кэшем, здесь не учитывается
  // и не стирается. Кэш и регенерация — в пределах аудитории: публичный и полный
  // обзор одного скана — два разных текста.
  if (deps.cache !== false && deps.db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role != 'flagger' AND audience = ? LIMIT 1").get(req.scanId, audience) !== null) {
    deps.log?.(`[summary] ${deps.org}/${deps.repo} scan ${req.scanId} (${audience}): cached (notes already exist for this scan)`);
    return { scanId: req.scanId, notes: 0, failSoft: [], skipped: [], outcomes: [], answered: 0, cached: true };
  }
  if (deps.cache === false) {
    const gone = deps.db.query("DELETE FROM ai_notes WHERE scan_id = ? AND role != 'flagger' AND audience = ?").run(req.scanId, audience);
    deps.db.query("DELETE FROM ai_fails WHERE scan_id = ? AND role != 'flagger' AND audience = ?").run(req.scanId, audience);
    if (Number(gone.changes) > 0) {
      deps.log?.(`[summary] ${deps.org}/${deps.repo} scan ${req.scanId}: regen — previous notes replaced (${Number(gone.changes)} rows)`);
    }
  }
  const budget: RunBudget = {
    calls: 0,
    answered: 0,
    max: deps.budgets?.maxModelCalls ?? MAX_MODEL_CALLS,
    ac: new AbortController(),
  };
  const fuse = setTimeout(() => budget.ac.abort(), deps.budgets?.fuseMs ?? GENERATION_FUSE_MS);
  deps.log?.(`[summary] ${deps.org}/${deps.repo} scan ${req.scanId} (${audience}): start (budget ${budget.max} calls)`);
  const outcomes: SummaryRoleOutcome[] = [];
  const failSoft: string[] = [];
  const skipped: string[] = [];
  let notes = 0;
  const specialistTexts: Record<string, string> = {};

  try {
    // --- специалисты параллельно (side) ---
    // недоверенный контент: README в nonce-рамке; тексты TODO и коммитов
    // специалисты берут инструментами (grep/git_log), их выдача тоже санитизируется
    const contents: string[] = [];
    const readme = await readReadme(deps);
    if (readme !== null) contents.push(frameUntrusted("README.md", readme, makeNonce()) ?? "");
    const sharedContent = contents.filter((c) => c.length > 0);

    const settled = await Promise.all(
      roles.map(async (role) => {
        const facts = scopedFacts(deps.db, req.scanId, role, audience);
        if (facts.length === 0) {
          return { role, outcome: { role, ok: false, reason: "нет фактов категории — вызова не было" } as SummaryRoleOutcome, text: null };
        }
        try {
          // security НЕ получает README: ее хартия — «только факты AppSec», и
          // лишняя поверхность для инъекций этой роли ни к чему
          const roleContent = role === "security" ? [] : sharedContent;
          const res = await runRole(deps, budget, role, facts, roleContent, null);
          if (!res.ok) return { role, outcome: { role, ok: false, reason: res.reason } as SummaryRoleOutcome, text: null };
          return { role, outcome: { role, ok: true, chars: res.clean.length, retries: res.retries, ms: res.ms, calls: res.calls, tools: res.tools } as SummaryRoleOutcome, text: res };
        } catch (e) {
          return { role, outcome: { role, ok: false, reason: String((e as Error).message).slice(0, 160) } as SummaryRoleOutcome, text: null };
        }
      }),
    );

    for (const s of settled) {
      outcomes.push(s.outcome);
      if (s.text !== null) {
        specialistTexts[s.role] = s.text.clean;
        writeNote(deps, req.scanId, repoId, s.role, s.text.clean, s.text.refs, now, audience);
        notes++;
      } else {
        const reason = s.outcome.reason ?? "";
        (reason.startsWith("нет фактов") ? skipped : failSoft).push(s.role);
      }
    }

    // флаггер в обзор не входит: проверка на накрутку — отдельная заявка
    // runFraudCheck, со своей кнопкой и лимитом

    // --- динамика: числовые точки истории; без точек вызова нет ---
    const points = historyPoints(deps.db, req.scanId, audience);
    if (points.length === 0) {
      skipped.push("trajectory");
      outcomes.push({ role: "trajectory", ok: false, reason: "нет точек истории — вызова не было" });
    } else {
      // категории — русскими названиями (см. namedTrajectoryPoints): с ключами модель
      // писала «Безопасность (категория Issues)» даже в публичной версии, где Безопасности нет
      const trajectoryFacts: FactInput[] = [{ key: "scores.points", value: namedTrajectoryPoints(points) }];
      const res = await runRole(deps, budget, "trajectory", trajectoryFacts, [], null);
      if (res.ok) {
        specialistTexts.trajectory = res.clean;
        writeNote(deps, req.scanId, repoId, "trajectory", res.clean, res.refs, now, audience);
        notes++;
        outcomes.push({ role: "trajectory", ok: true, chars: res.clean.length, retries: res.retries, ms: res.ms, calls: res.calls, tools: res.tools });
      } else {
        failSoft.push("trajectory");
        outcomes.push({ role: "trajectory", ok: false, reason: res.reason });
      }
    }

    // --- overview (main): вход = сегменты специалистов (включая динамику) + факты ---
    const specialistOk = Object.keys(specialistTexts);
    if (specialistOk.length === 0) {
      failSoft.push("overview");
      outcomes.push({ role: "overview", ok: false, reason: "нет ни одного ответа специалистов" });
    } else {
      const segs = segmentsOf(specialistTexts);
      const facts = scopedFacts(deps.db, req.scanId, "overview", audience);
      const res = await runRole(deps, budget, "overview", facts, [], segs);
      if (res.ok) {
        writeNote(deps, req.scanId, repoId, "overview", res.clean, res.refs, now, audience);
        notes++;
        outcomes.push({ role: "overview", ok: true, chars: res.clean.length, retries: res.retries, ms: res.ms, calls: res.calls, tools: res.tools });
      } else {
        failSoft.push("overview");
        outcomes.push({ role: "overview", ok: false, reason: res.reason });
      }
    }
  } finally {
    clearTimeout(fuse);
  }

  deps.log?.(
    `[summary] ${deps.org}/${deps.repo} scan ${req.scanId}: notes=${notes}, calls=${budget.calls}, failSoft=[${failSoft.join(",")}], skipped=[${skipped.join(",")}]`,
  );
  // причина, по которой текст не сформирован, нужна пользователю, а не только
  // в логе: карточка читает ai_fails по последнему скану
  const failInsert = deps.db.query(
    "INSERT INTO ai_fails (repo_id, scan_id, role, reason, created_at, audience) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const o of outcomes) {
    if (o.ok) continue;
    failInsert.run(repoId, req.scanId, o.role, (o.reason ?? "не прошла проверку").slice(0, 200), now.toISOString(), audience);
  }
  // при сбое — строка outcomes с причинами: оператор отличает «провайдер недоступен»
  // (модель: сеть/429/stall) от «не прошло валидацию» (валидатор: ...)
  if (failSoft.length > 0) {
    deps.log?.(
      `[summary] outcomes: ${outcomes
        .map((o) => `${o.role}=${o.ok ? "ok" : `fail: ${(o.reason ?? "").slice(0, 140)}`}`)
        .join("; ")}`,
    );
  }
  return { scanId: req.scanId, notes, failSoft, skipped, outcomes, answered: budget.answered };
}

export interface FraudCheckResult {
  scanId: number;
  /** флаг записан (flag true или false) */
  ok: boolean;
  flag: FraudFlag | null;
  /** признаки ритма, по которым шла проверка; null — ленты нет */
  signals: RhythmSignals | null;
  /** почему флага нет: ленты нет (вызова не было) или отказ модели/валидатора */
  reason?: string;
  /** у скана уже есть проверка — вызова не было */
  cached?: boolean;
  /** вызовов модели с ответом; 0 — модель не ответила (лимит не списывается) */
  answered?: number;
}

/** Бюджет проверки: 1 вызов на попытку × ROLE_ATTEMPTS, с запасом на ретраи провайдера. */
const FRAUD_CHECK_MAX_CALLS = ROLE_ATTEMPTS * 2;
const FRAUD_CHECK_FUSE_MS = 2 * 60_000;

/**
 * Проверка на накрутку (кнопка «Проверить оценку»): один вызов легкой модели по
 * фактам скана из БД — без клона и без инструментов. Вход — признаки ритма
 * `activity.rhythm`, посчитанные кодом по полной ленте (rhythm.ts), и `activity.rest`.
 * Заметка flagger = {flag, factors, signals}: карточка и отчет печатают факторы по тем
 * же признакам, что видела модель. Score не трогается. Нет ленты — нет вызова,
 * причина пишется в ai_fails («не проверялось»).
 */
export async function runFraudCheck(deps: SummaryDeps, req: SummaryRequest): Promise<FraudCheckResult> {
  const now = req.now ?? new Date();
  const repoId = repoIdOf(deps);
  const tag = `[fraud-check] ${deps.org}/${deps.repo} scan ${req.scanId}`;
  if (deps.cache !== false && deps.db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role = 'flagger' LIMIT 1").get(req.scanId) !== null) {
    deps.log?.(`${tag}: cached (check already exists for this scan)`);
    return { scanId: req.scanId, ok: true, flag: null, signals: null, cached: true, answered: 0 };
  }
  deps.db.query("DELETE FROM ai_notes WHERE scan_id = ? AND role = 'flagger'").run(req.scanId);
  deps.db.query("DELETE FROM ai_fails WHERE scan_id = ? AND role = 'flagger'").run(req.scanId);
  const fail = (reason: string, signals: RhythmSignals | null, answered = 0): FraudCheckResult => {
    deps.db
      .query("INSERT INTO ai_fails (repo_id, scan_id, role, reason, created_at, audience) VALUES (?, ?, 'flagger', ?, ?, 'public')")
      .run(repoId, req.scanId, reason.slice(0, 200), now.toISOString());
    deps.log?.(`${tag}: no flag — ${reason.slice(0, 160)}`);
    return { scanId: req.scanId, ok: false, flag: null, signals, reason, answered };
  };

  const rows = deps.db
    .query("SELECT key, value FROM facts WHERE scan_id = ? AND status = 'ok' AND key IN ('activity.git.timeline', 'activity.rest')")
    .all(req.scanId) as { key: string; value: string }[];
  const timeline = rows.find((r) => r.key === "activity.git.timeline");
  const rest = rows.find((r) => r.key === "activity.rest");
  const events = (timeline ? (parseFactValue(timeline.value) as { events?: unknown } | null)?.events : null) ?? null;
  const scan = deps.db.query("SELECT finished_at, started_at FROM scans WHERE id = ?").get(req.scanId) as
    | { finished_at: string | null; started_at: string }
    | null;
  const asOf = new Date(scan?.finished_at ?? scan?.started_at ?? now.toISOString());
  const signals = Array.isArray(events) ? rhythmSignals(events as Parameters<typeof rhythmSignals>[0], asOf) : null;
  if (signals === null) return fail(NO_RHYTHM_REASON, null);

  const facts: FactInput[] = [{ key: RHYTHM_KEY, value: signals }];
  if (rest) facts.push({ key: "activity.rest", value: parseFactValue(rest.value) });
  const budget: RunBudget = { calls: 0, answered: 0, max: deps.budgets?.maxModelCalls ?? FRAUD_CHECK_MAX_CALLS, ac: new AbortController() };
  const fuse = setTimeout(() => budget.ac.abort(), deps.budgets?.fuseMs ?? FRAUD_CHECK_FUSE_MS);
  let res: Awaited<ReturnType<typeof runFlagger>>;
  try {
    res = await runFlagger(deps, budget, facts);
  } finally {
    clearTimeout(fuse);
  }
  if (!res.ok) return fail(res.reason, signals, budget.answered);
  writeNote(
    deps,
    req.scanId,
    repoId,
    "flagger",
    // вход проверки хранится вместе с ней: фактор печатается по тем данным, что видела
    // модель, а не по фактам более нового анализа
    JSON.stringify({ flag: res.flag.flag, factors: res.flag.factors, signals, inputs: rest ? { "activity.rest": parseFactValue(rest.value) } : {} }),
    res.flag.factors.map((f) => f.key),
    now,
    // вход флаггера — только публичные данные активности, поэтому метку видят все
    "public",
  );
  deps.log?.(`${tag}: flag=${res.flag.flag}, factors=[${res.flag.factors.map((f) => f.key).join(",")}], calls=${budget.calls}`);
  return { scanId: req.scanId, ok: true, flag: res.flag, signals, answered: budget.answered };
}

/** Причина «не проверялось»: в скане нет ленты коммитов — вызова модели не было. */
export const NO_RHYTHM_REASON = "нет истории коммитов — проверка не проводилась";

/**
 * Флаг накрутки: до ROLE_ATTEMPTS попыток с причинами отказа в ретрае; вывод —
 * мини-JSON по validateFlagOutput. Флаг — подозрение для человека, оценки
 * и веса у него нет: в Score, категории и дельту он не попадает никогда.
 */
async function runFlagger(
  deps: SummaryDeps,
  budget: RunBudget,
  facts: FactInput[],
): Promise<{ ok: true; flag: FraudFlag } | { ok: false; reason: string }> {
  const charter = loadCharter("flagger");
  const base: ChatMessage[] = [
    { role: "system", content: charter.text },
    { role: "user", content: `ФАКТЫ АКТИВНОСТИ (числа только из этого списка):\n${factsDigest(facts)}` },
  ];
  const keys = new Set(facts.map((f) => f.key));
  let lastReason = "валидатор: флаг не сформирован";
  let lastRaw = "";
  for (let attempt = 0; attempt < ROLE_ATTEMPTS; attempt++) {
    const messages: ChatMessage[] =
      attempt === 0
        ? base
        : [
            ...base,
            { role: "assistant", content: lastRaw },
            // модель брала ключом поле факта (regular_share), поэтому ретрай называет
            // допустимые ключи явно; сами ключи код не чинит
            { role: "user", content: `Предыдущий вывод ОТКЛОНЁН: ${lastReason}. Ключ фактора — только имя факта целиком: ${[...keys].join(", ")}. Исправь и выдай ТОЛЬКО JSON формы {"flag":bool,"factors":[{"key":"...","note":"..."}]}.` },
          ];
    let text: string;
    try {
      const res = await generateWithTools(
        { callLlm: budgetedCallLlm(deps.callLlm, budget), role: "flagger", executor: null, backoffMs: deps.agentBackoffMs },
        messages,
      );
      text = normalizeTypography(res.text);
    } catch (e) {
      return { ok: false, reason: `модель: ${String((e as Error).message).slice(0, 160)}` };
    }
    lastRaw = text;
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    // форма и ключи — validateFlagOutput; текст фактора на карточке и в отчете строит код
    // из признаков (fraudFactorFact), note модели — только запасной вариант
    const verdict = validateFlagOutput(cleaned, keys);
    if (verdict.ok && verdict.flag !== null) return { ok: true, flag: verdict.flag };
    lastReason = verdict.reason ?? "форма не JSON";
  }
  return { ok: false, reason: `валидатор: ${lastReason}` };
}

/** README корня клона (рамку вешает вызывающий). Размер проверяется ДО чтения:
 *  гигантский README не читается вовсе. Только обычный файл: закоммиченный симлинк
 *  (например, на `/app/.env` хоста) не читается – как у инструментов модели. */
export async function readReadme(deps: Pick<SummaryDeps, "clone">): Promise<string | null> {
  if (!deps.clone) return null;
  try {
    const names = readdirSync(deps.clone.root).filter((n) => /^readme(\.|$)/i.test(n));
    const name = names[0];
    if (!name) return null;
    const path = join(deps.clone.root, name);
    // lstat не идет по ссылке: симлинк, каталог и прочее – не README
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_PLAIN_READ_BYTES) return null;
    return st.size > 0 ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}
