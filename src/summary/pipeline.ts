// pipeline.ts — конвейер AI-summary (спека В5 §3, К5.2-К5.4): факты скана +
// скоупированный недоверенный контент → специалисты параллельно (side;
// security — без инструментов, закон 5) → овервью (main) на их сегментах →
// валидатор (один ретрай с припиской причин) → ai_notes (append).
// Агрегатный кап: ≤ 48 вызовов модели и wall-clock фуз 6 минут на ВСЮ
// генерацию (спека §3.3). Tri-state: нет фактов роли — вызова нет, честная
// причина. Fail-soft: невалидный текст в продукт не едет, роль попадает в
// failSoft. Score трогать запрещено: конвейер пишет ТОЛЬКО ai_notes.
import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CallLlm, ChatMessage } from "../llm";
import { LlmError, makeLlm } from "../llm";
import type { Config } from "../config";
import { GENERATION_FUSE_MS, loadConfig, MAX_MODEL_CALLS } from "../config";
// Капы генерации живут в config (В5.1: формула худшего скана включает фуз);
// ре-экспорт держит прежний импорт-контракт модуля
export { GENERATION_FUSE_MS, MAX_MODEL_CALLS };
import { parseFactValue } from "../collectors/facts";
import { MODEL_VERSION } from "../score/model";
import { loadCharter } from "./charters";
import { generateWithTools } from "./agent";
import { makeCalculatorExecutor, makeToolExecutor, materializeWorktree, removeWorktree, sanitizeUntrusted, MAX_PLAIN_READ_BYTES } from "./tools";
import { frameUntrusted, makeNonce } from "./input";
import { validateFlagOutput, validateOutput, type FraudFlag, type FactInput } from "./validator";
import type { SummaryRole } from "./roles";
import { modelTierOf, PUBLIC_CATEGORIES, PUBLIC_SPECIALIST_ROLES, ROLE_FACT_CATEGORIES, SPECIALIST_ROLES, toolsAllowed, type SpecialistRole } from "./roles";
import { anySummaryAuto } from "./optin";
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
   * Кэш по скану (23.09): false — регенерация, заметки скана перезаписываются.
   * Процессворкер ставит false ТОЛЬКО при дебаг-куладауне (1 мс снимает оба
   * антидубля — решение Алексея); дефолт true — прод-поведение В5.1.
   */
  cache?: boolean;
  log?: (m: string) => void;
}

export interface SummaryRequest {
  scanId: number;
  now?: Date;
  /**
   * В5.2 (Б2): аудитория текста. 'public' — только 4 открытые категории и их
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
  /** 23.09: смоук-цифры роли — латентность, вызовы модели, вызовы инструментов */
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
  /** роли без фактов своей категории — вызова не было (tri-state) */
  skipped: string[];
  outcomes: SummaryRoleOutcome[];
  /** В5.1 (Ищейка-С1): у скана уже есть ai_notes — генерация не запускалась */
  cached?: boolean;
}

interface RunBudget {
  calls: number;
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
      return await callLlm({ ...opts, signal: ac.signal });
    } finally {
      opts.signal?.removeEventListener("abort", relay);
      budget.ac.signal.removeEventListener("abort", relay);
    }
  };
}

/**
 * Ок-факты скана, скоупированные по категории роли. В5.2 (Б2): для публичной
 * аудитории — только факты 4 открытых категорий и никаких фактов каналов с
 * правами (CHANNEL_KINDS: конфиги и запуски CI, находки AppSec).
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
    .map(capTimelineFact);
}

/** Факт открыт публичной аудитории: категория из 4 открытых и не канал с правами. */
export function publicFactKey(key: string): boolean {
  return !CHANNEL_KINDS.includes(key) && (PUBLIC_CATEGORIES as readonly string[]).includes(categoryOf(key));
}

function roleFactsAllowed(role: SummaryRole, key: string): boolean {
  if (!(SPECIALIST_ROLES as readonly string[]).includes(role)) return key !== "activity.git.timeline"; // overview/trajectory: всё кроме сырого сырья
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
 * Числовые точки истории динамики (К5.16, Б4): ВСЕ строки scores репо
 * текущей версии модели по возрастанию — дата, коммит, индекс, покрытие,
 * категории. Прошлые LLM-тексты в точках не участвуют по построению
 * (самореференция исчезает). Без точек роль динамики не запускается.
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
    // В5.1 (баги-мелочь): битый categories JSON — честная точка без категорий,
    // а не падение всего runSummary мимо пер-ролевого fail-soft
    let cats: Record<string, { score: number | null }> = {};
    try {
      const parsed = JSON.parse(r.categories) as Record<string, { score: number | null }> | null;
      if (parsed !== null && typeof parsed === "object") cats = parsed;
    } catch {
      cats = {};
    }
    const categories: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(cats)) {
      // В5.2 (Б2): публичной аудитории — баллы только открытых категорий
      if (audience === "public" && !(PUBLIC_CATEGORIES as readonly string[]).includes(key)) continue;
      categories[key] = value?.score ?? null;
    }
    return { date: r.finished_at, headSha: r.head_sha, index: r.idx, coverage: r.coverage, categories };
  });
}

/** Сегменты специалистов для овервью: предложения чистых текстов. */
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
 * В5.1 (LLM-инженер §5.1): сырой timeline каппируется последними N событиями
 * (robot-флаги в событиях сохраняются) — большой репо иначе гонит в промпт
 * мегабайты истории (blowup > 128K токенов) и email-ы всех авторов наружу.
 * Агрегат (activity.git.summary) остаётся полным — ритм виден целиком.
 */
export const TIMELINE_EVENTS_CAP = 60;

export function capTimelineFact(f: FactInput): FactInput {
  const raw = f.value as { events?: unknown } | null;
  if (f.key !== "activity.git.timeline" || raw === null || typeof raw !== "object" || !Array.isArray(raw.events)) return f;
  const events = raw.events;
  if (events.length <= TIMELINE_EVENTS_CAP) return f;
  // В5.2 (Б1): `git log` отдает события от новых к старым (collectors/git.ts) —
  // последние N это ГОЛОВА массива; прежний `slice(-N)` отдавал самые старые
  return { ...f, value: { events: events.slice(0, TIMELINE_EVENTS_CAP), capped: true, total: events.length } };
}

function factsDigest(facts: FactInput[]): string {
  return facts.map((f) => `- ${f.key}: ${JSON.stringify(f.value)}`).join("\n");
}

/**
 * Попыток генерации на роль: ретрай с причинами валидатора — «попросить
 * модель поправиться» (23.09, Алексей: запросы дешёвые, отказ — только после
 * трёх попыток; прежний лимит 2 молча топил роли на одной опечатке).
 */
const ROLE_ATTEMPTS = 3;

/** Числа из текстов сегментов — легальный коридор овервью (В5.1, Ищейка-С2: спека §3.7 «сущности из ответов специалистов»). */
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
    // В5.1 (Security-М5/Ищейка-З6): рамка сегментов с nonce (мёртвый nonce
    // задействован) — специалист не может напечатать «конец ответов» и
    // сменить контекст овервью своими рамками
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

  // 23.09 (Алексей): security живёт без файловых инструментов (закон 5), но
  // арифметику долей считает инструментом-калькулятором, а не в уме
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
      text = res.text;
      calls = res.modelCalls;
      tools = res.toolCalls;
    } catch (e) {
      // 23.09: построльные строки stdout — живой прогресс и смоук-цифры
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
    // 23.09 (Алексей): полные причины и ПОЛНЫЙ ответ модели в лог, без обрезки —
    // иначе нечем сравнивать попытки и не видно, что именно модель написала
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
 * Полная генерация для скана. Пишет ТОЛЬКО ai_notes; Score, категории и
 * рекомендации не трогаются ни при каком исходе (К5.6 — прямой тест).
 */
export async function runSummary(deps: SummaryDeps, req: SummaryRequest): Promise<SummaryRunResult> {
  const now = req.now ?? new Date();
  const repoId = repoIdOf(deps);
  const audience: AiAudience = req.audience ?? "full";
  const roles: readonly SpecialistRole[] = audience === "public" ? PUBLIC_SPECIALIST_ROLES : SPECIALIST_ROLES;
  // В5.1 (Ищейка-С1, кэш по скану): заметки этого скана уже записаны (авто-
  // генерация, повтор claim после падения воркера) — вторая генерация того
  // же скана не запускается: кредиты и append-лог чисты.
  // 23.09 (Алексей): дебаг-куладаун снимает и ЭТОТ кэш — регенерация
  // перезаписывает заметки скана (у скана всегда ≤1 набор, все читатели —
  // карточка, ai-notes, эволюция — остаются верны без правок)
  // В5.2 (Б1): проверка на накрутку — своя заявка со своим кэшем (runFraudCheck);
  // ее заметка не делает обзор «уже сформированным», и регенерация обзора ее не стирает.
  // В5.2 (Б2): кэш и регенерация — в пределах аудитории: публичный и полный обзор
  // одного скана — два разных текста
  if (deps.cache !== false && deps.db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role != 'flagger' AND audience = ? LIMIT 1").get(req.scanId, audience) !== null) {
    deps.log?.(`[summary] ${deps.org}/${deps.repo} scan ${req.scanId} (${audience}): cached (notes already exist for this scan)`);
    return { scanId: req.scanId, notes: 0, failSoft: [], skipped: [], outcomes: [], cached: true };
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
    // недоверенный контент: README через nonce-рамку; тексты TODO и коммитов
    // специалисты берут инструментами (grep/git_log) — их отдача санитайзится
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
          // В5.1 (LLM-инженер 1.5): security НЕ получает README/контент —
          // хартия обещает «только факты AppSec», и инъекционная поверхность
          // роли, не предупреждённой о недоверенных данных, лишняя
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

    // флаггер в обзор не входит (В5.2, Б1): проверка на накрутку — отдельная
    // заявка runFraudCheck, со своей кнопкой и лимитом

    // --- динамика (Б4, К5.16): числовые точки истории; без точек вызова нет ---
    const points = historyPoints(deps.db, req.scanId, audience);
    if (points.length === 0) {
      skipped.push("trajectory");
      outcomes.push({ role: "trajectory", ok: false, reason: "нет точек истории — вызова не было" });
    } else {
      const trajectoryFacts: FactInput[] = [{ key: "scores.points", value: points }];
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

    // --- овервью (main): вход = сегменты специалистов + публичные факты ---
    // (динамика входит в его вход наравне с доменными специалистами, §3.2)
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
  // 23.09 (Алексей): причина несформирования — ДЛЯ ПОЛЬЗОВАТЕЛЯ, не только в
  // лог; карточка читает ai_fails по последнему скану
  const failInsert = deps.db.query(
    "INSERT INTO ai_fails (repo_id, scan_id, role, reason, created_at, audience) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const o of outcomes) {
    if (o.ok) continue;
    failInsert.run(repoId, req.scanId, o.role, (o.reason ?? "не прошла проверку").slice(0, 200), now.toISOString(), audience);
  }
  // В5.1 (Прод-С3): при частичном или полном фейле — строка outcomes с причинами:
  // оператор различает «провайдер недоступен» (модель: сеть/429/stall) от
  // «ни один блок не прошёл валидацию» (валидатор: ...)
  if (failSoft.length > 0) {
    deps.log?.(
      `[summary] outcomes: ${outcomes
        .map((o) => `${o.role}=${o.ok ? "ok" : `fail: ${(o.reason ?? "").slice(0, 140)}`}`)
        .join("; ")}`,
    );
  }
  return { scanId: req.scanId, notes, failSoft, skipped, outcomes };
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
}

/** Бюджет проверки: 1 вызов на попытку × ROLE_ATTEMPTS, с запасом на ретраи провайдера. */
const FRAUD_CHECK_MAX_CALLS = ROLE_ATTEMPTS * 2;
const FRAUD_CHECK_FUSE_MS = 2 * 60_000;

/**
 * Проверка на накрутку (В5.2, Б1; кнопка «Проверить оценку»): один вызов лёгкой
 * модели по фактам скана из БД — без клона и без инструментов. Вход — признаки
 * ритма `activity.rhythm`, посчитанные кодом по полной ленте (rhythm.ts), и
 * `activity.rest`. Заметка flagger = {flag, factors, signals}: карточка и отчет
 * печатают факторы по тем же признакам, что видела модель. Score не трогается.
 * Tri-state: ленты нет — вызова нет, причина в ai_fails («не проверялось»).
 */
export async function runFraudCheck(deps: SummaryDeps, req: SummaryRequest): Promise<FraudCheckResult> {
  const now = req.now ?? new Date();
  const repoId = repoIdOf(deps);
  const tag = `[fraud-check] ${deps.org}/${deps.repo} scan ${req.scanId}`;
  if (deps.cache !== false && deps.db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role = 'flagger' LIMIT 1").get(req.scanId) !== null) {
    deps.log?.(`${tag}: cached (check already exists for this scan)`);
    return { scanId: req.scanId, ok: true, flag: null, signals: null, cached: true };
  }
  deps.db.query("DELETE FROM ai_notes WHERE scan_id = ? AND role = 'flagger'").run(req.scanId);
  deps.db.query("DELETE FROM ai_fails WHERE scan_id = ? AND role = 'flagger'").run(req.scanId);
  const fail = (reason: string, signals: RhythmSignals | null): FraudCheckResult => {
    deps.db
      .query("INSERT INTO ai_fails (repo_id, scan_id, role, reason, created_at, audience) VALUES (?, ?, 'flagger', ?, ?, 'public')")
      .run(repoId, req.scanId, reason.slice(0, 200), now.toISOString());
    deps.log?.(`${tag}: no flag — ${reason.slice(0, 160)}`);
    return { scanId: req.scanId, ok: false, flag: null, signals, reason };
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
  const budget: RunBudget = { calls: 0, max: deps.budgets?.maxModelCalls ?? FRAUD_CHECK_MAX_CALLS, ac: new AbortController() };
  const fuse = setTimeout(() => budget.ac.abort(), deps.budgets?.fuseMs ?? FRAUD_CHECK_FUSE_MS);
  let res: Awaited<ReturnType<typeof runFlagger>>;
  try {
    res = await runFlagger(deps, budget, facts);
  } finally {
    clearTimeout(fuse);
  }
  if (!res.ok) return fail(res.reason, signals);
  writeNote(
    deps,
    req.scanId,
    repoId,
    "flagger",
    JSON.stringify({ flag: res.flag.flag, factors: res.flag.factors, signals }),
    res.flag.factors.map((f) => f.key),
    now,
    // вход флаггера — только публичные данные активности: метку видят все (§2 п.2)
    "public",
  );
  deps.log?.(`${tag}: flag=${res.flag.flag}, factors=[${res.flag.factors.map((f) => f.key).join(",")}], calls=${budget.calls}`);
  return { scanId: req.scanId, ok: true, flag: res.flag, signals };
}

/** Причина «не проверялось»: в скане нет ленты коммитов — вызова модели не было. */
export const NO_RHYTHM_REASON = "нет истории коммитов — проверка не проводилась";

/**
 * Флаг фрода (К5.10): один вызов + один ретрай с припиской причин; вывод —
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
            { role: "user", content: `Предыдущий вывод ОТКЛОНЁН: ${lastReason}. Исправь и выдай ТОЛЬКО JSON формы {"flag":bool,"factors":[{"key":"...","note":"..."}]}.` },
          ];
    let text: string;
    try {
      const res = await generateWithTools(
        { callLlm: budgetedCallLlm(deps.callLlm, budget), role: "flagger", executor: null, backoffMs: deps.agentBackoffMs },
        messages,
      );
      text = res.text;
    } catch (e) {
      return { ok: false, reason: `модель: ${String((e as Error).message).slice(0, 160)}` };
    }
    lastRaw = text;
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    // В5.1 (Ищейка-З1): числа в note — только из входных фактов
    const verdict = validateFlagOutput(cleaned, keys);
    if (verdict.ok && verdict.flag !== null) return { ok: true, flag: verdict.flag };
    lastReason = verdict.reason ?? "форма не JSON";
  }
  return { ok: false, reason: `валидатор: ${lastReason}` };
}

/** Недоверенный контент из клона: README корня (рамку вешает вызывающий).
 *  В5.1 (Прод-З3): кап размера ДО чтения — гигантский README не читается вовсе. */
async function readReadme(deps: SummaryDeps): Promise<string | null> {
  if (!deps.clone) return null;
  try {
    const names = readdirSync(deps.clone.root).filter((n) => /^readme(\.|$)/i.test(n));
    const name = names[0];
    if (!name) return null;
    const buf = Bun.file(join(deps.clone.root, name));
    if (buf.size > MAX_PLAIN_READ_BYTES) return null;
    return buf.size > 0 ? await buf.text() : null;
  } catch {
    return null;
  }
}

// ---------- авто-генерация в окне скана (спека §3.4, оп-ин) ----------

export interface AutoSummaryCtx {
  db: Database;
  repoId: number;
  scanId: number;
  org: string;
  repo: string;
  cloneDir: string;
}

/** Канал CI или AppSec в скане закрыт токену (факт no-data с причиной `access`). */
export function scanChannelDenied(db: Database, scanId: number): boolean {
  const rows = db
    .query("SELECT value FROM facts WHERE scan_id = ? AND key IN ('cicd.runs', 'appsec.findings') AND status = 'no-data'")
    .all(scanId) as { value: string }[];
  return rows.some((r) => {
    const v = parseFactValue(r.value) as { reason?: unknown } | null;
    return v !== null && typeof v === "object" && v.reason === "access";
  });
}

/**
 * Фабрика хука автозапуска (вызывается раннером в конце скана при открытом
 * окне клона): оп-ин есть → worktree из bare-клона → runSummary → уборка.
 * Любая ошибка — fail-soft в лог: генерация не роняет собранный скан.
 * В5.1 (Прод-С3): deps.log подключён — строка итога и outcomes с причинами
 * уходят в консоль процесса, отказ LLM-слоя больше не невидим оператору.
 */
export function makeAutoSummary(
  config: Pick<Config, "llm">,
): (ctx: AutoSummaryCtx) => Promise<void> {
  const callLlm = makeLlm({ ...loadConfig(), llm: config.llm } as Config);
  return async (ctx: AutoSummaryCtx): Promise<void> => {
    const slug = `${ctx.org}/${ctx.repo}`;
    if (!anySummaryAuto(ctx.db, slug)) return;
    // ревью В5.3 (25.09): оп-ин мог быть включен до гейта полных прав — обзор по скану, где
    // токену закрыт CI или AppSec, не генерируется (текст виден только при полном Score)
    if (scanChannelDenied(ctx.db, ctx.scanId)) return;
    const wt = await materializeWorktree(ctx.cloneDir);
    try {
      await runSummary(
        {
          db: ctx.db,
          org: ctx.org,
          repo: ctx.repo,
          callLlm,
          clone: { root: wt.root, gitDir: wt.gitDir },
          models: { main: config.llm.mainModel, side: config.llm.sideModel },
          log: (m) => console.log(m),
        },
        { scanId: ctx.scanId },
      );
    } finally {
      await removeWorktree(wt.root, wt.gitDir);
    }
  };
}
