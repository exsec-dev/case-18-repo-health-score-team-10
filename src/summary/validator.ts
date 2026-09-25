// validator.ts — механический валидатор LLM-вывода (спека В5 §3.7, закон 4):
// (1) форма и длина; (2) привязка — каждое утверждение несёт {f:ключ} из
// входа (для overview/trajectory — плюс сегменты специалистов sp:<роль>:<n>);
// (3) числовой коридор — число либо из фактов/дельт, либо отклонение;
// (4) запрет новых сущностей (пути файлов, CVE); (5) для прозы — запрет
// markdown-ссылок, картинок и сырых URL. Невалидно → ретрай с припиской
// причин (конвейер) → fail-soft; невалидированный текст в продукт не едет.
// Чистая функция на каждый вызов.
import { categoryOf } from "../collectors/facts";
import type { SummaryRole } from "./roles";
import { ROLE_FACT_CATEGORIES, SPECIALIST_ROLES } from "./roles";

/** Кап длины прозы: специалисты/флаггер короче, овервью просторнее. */
export function maxCharsOf(role: SummaryRole): number {
  return role === "overview" ? 2000 : 1200;
}

export const MIN_CHARS = 20;

export interface FactInput {
  key: string;
  value: unknown;
}

export interface ValidateInput {
  role: SummaryRole;
  text: string;
  facts: FactInput[];
  /** доступные сегменты специалистов (sp:<роль>:<порядковый>) */
  segments?: string[];
  /**
   * В5.1 (Ищейка-С2): числа вне фактов, но легальные для роли — числа из
   * текстов сегментов специалистов (для overview) и точки/дельты trajectory.
   * Коридор остаётся закрытым: пополняется только тем, что реально было
   * во входе роли.
   */
}

export interface ValidateResult {
  ok: boolean;
  reasons: string[];
  /** порядок ссылок f-маркеров (уникальный, как в тексте) */
  refs: string[];
  /** сегменты sp-ссылок (уникальный) */
  segmentsUsed: string[];
  /** текст без маркеров — для показа; валиден только при ok */
  clean: string;
}

// 23.09 (Алексей): односимвольные скобки {f:ключ} вместо [[f:ключ]] —
// модели рвут двойные квадратные скобки (привычка к массивам)
const F_MARKER = /\{f:([a-z0-9._@-]+)\}/g;
const SP_MARKER = /\{sp:([a-z0-9-]+):(\d+)\}/g;
const FILE_TOKEN = /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|h|cpp|cs|swift|sh|md|ya?ml|json|toml|xml|ini|cfg|conf)\b/gi;
// В5.1 (К1 bugs): без флага g — .test() не мутирует lastIndex, валидатор
// снова чистая функция на каждый вызов (CVE_TOKEN через matchAll — там g нужен)
const CVE_TOKEN = /\bCVE-\d{4}-\d{4,}\b/gi;
const URL_TOKEN = /https?:\/\/|www\./i;
const MD_LINK = /\[[^\]\n]*\]\([^)\n]*\)/;
const MD_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/;

/**
 * В5.1 (Ищейка-З3): битые/опечатанные маркеры — «{f:текст опечатка,
 * {f:}}, вложенные {{f:key}}} — отклоняются целиком: в clean
 * пользовательского текста мусор не едет.
 */
function brokenMarkerFragment(text: string): string | null {
  let at = text.indexOf("{");
  while (at >= 0) {
    const rest = text.slice(at);
    if (!/^\{f:[a-z0-9._@-]+\}/.test(rest) && !/^\{sp:[a-z0-9-]+:\d+\}/.test(rest)) {
      return rest.slice(0, 30);
    }
    at = text.indexOf("{", at + 1);
  }
  return null;
}

/** Числа, встречающиеся в значениях фактов (строковое представление целиком). */
export function extractRefs(text: string): { refs: string[]; segments: string[] } {
  const refs: string[] = [];
  for (const m of text.matchAll(F_MARKER)) if (!refs.includes(m[1]!)) refs.push(m[1]!);
  const segments: string[] = [];
  for (const m of text.matchAll(SP_MARKER)) {
    const id = `sp:${m[1]}:${m[2]}`;
    if (!segments.includes(id)) segments.push(id);
  }
  return { refs, segments };
}

/** Текст без маркеров и прилипших двойных пробелов — то, что видит читатель. */
export function stripMarkers(text: string): string {
  return text
    .replace(F_MARKER, "")
    .replace(SP_MARKER, "")
    .replace(/ {2,}/g, " ")
    .replace(/ +([,.!?;:])/g, "$1")
    .trim();
}

function scopeCheckOk(role: SummaryRole, keys: string[]): boolean {
  if (!(SPECIALIST_ROLES as readonly string[]).includes(role)) return true; // overview/trajectory/flagger — по факту входа
  const allowed = ROLE_FACT_CATEGORIES[role as keyof typeof ROLE_FACT_CATEGORIES] ?? [];
  return keys.every((key) => allowed.includes(categoryOf(key)));
}

/**
 * Темы чужих категорий — тоже «новая сущность» (спека §3.7 п.4): специалист,
 * рассуждающий о чужой зоне без чужого факта, отбрасывается. Ключевые слова
 * намеренно узкие (срабатывание = ретрай, а не штраф), у своей категории
 * слов нет: activity-специалисту слово «коммит» разрешено.
 */
const FOREIGN_TOPIC_WORDS: Partial<Record<string, string[]>> = {
  documentation: ["активност", "коммит", "commits", "уязвимост", "cve", "пайплайн", "pipeline", "тикет", "todo", "fixme"],
  code: ["активност", "коммит", "commits", "уязвимост", "cve", "пайплайн", "тикет"],
  activity: ["уязвимост", "cve", "пайплайн", "todo", "fixme", "readme", "документац", "лиценз"],
  issues: ["уязвимост", "cve", "коммит", "readme", "todo", "fixme"],
  cicd: ["активност", "коммит", "уязвимост", "cve", "readme", "документац"],
  security: ["коммит", "активност", "readme", "документац", "todo", "fixme", "пайплайн"],
};

function foreignTopic(role: SummaryRole, text: string): string | null {
  const words = FOREIGN_TOPIC_WORDS[role];
  if (words === undefined) return null;
  const lower = text.toLowerCase();
  return words.find((w) => lower.includes(w)) ?? null;
}

/**
 * Валидация прозы одного вызова. Все проверки механические; причина отказа
 * едет в ретрай-промпт (конвейер) и в лог — не в интерфейс пользователя.
 */
export function validateOutput(input: ValidateInput): ValidateResult {
  const reasons: string[] = [];
  const { role, text } = input;
  const factKeys = new Set(input.facts.map((f) => f.key));
  const segments = new Set(input.segments ?? []);

  // (1) форма и длина
  if (typeof text !== "string" || text.trim().length < MIN_CHARS) {
    reasons.push("текст отсутствует или короче минимального");
  }
  if (text.length > maxCharsOf(role)) {
    reasons.push(`текст длиннее капа роли (${text.length} > ${maxCharsOf(role)})`);
  }
  // В5.1 (Security-З1): полоса управляющих расширена bidi/zero-width (RLO,
  // ZWSP, BOM и пр.) — визуальный спуфинг в пользовательских поверхностях
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(text)) {
    reasons.push("в тексте контрольные символы");
  }
  // В5.1 (Ищейка-З3): битые маркеры — отклонение, в clean не едут
  const broken = brokenMarkerFragment(text);
  if (broken !== null) {
    reasons.push(`в тексте битый маркер: ${broken}`);
  }

  // (5) LLM-текст: ссылки, картинки, сырые URL — запрещены всегда
  if (MD_LINK.test(text) || MD_IMAGE.test(text)) reasons.push("markdown-ссылки и картинки запрещены");
  if (URL_TOKEN.test(text)) reasons.push("внешние адреса в тексте запрещены");

  // (2) привязка; 23.09 (Алексей): старый формат {f:...} — учим новым скобками
  if (/\[\[(f|sp):/.test(text)) {
    reasons.push("маркеры в старом формате [[..]] – используй {f:ключ} / {sp:роль:N}");
  }
  const { refs, segments: segsUsed } = extractRefs(text);
  if (refs.length === 0 && segsUsed.length === 0) {
    reasons.push("ни одного факта или сегмента не привязано ({f:ключ} обязателен)");
  }
  const unknownRefs = refs.filter((r) => !factKeys.has(r));
  if (unknownRefs.length > 0) {
    reasons.push(`привязки вне входа роли: ${unknownRefs.join(", ")}`);
  }
  const unknownSegs = segsUsed.filter((s) => !segments.has(s));
  if (unknownSegs.length > 0) {
    reasons.push(`сегменты специалистов вне входа: ${unknownSegs.join(", ")}`);
  }
  // чужая зона: у специалистов ключи только своих категорий (механическая ограда)
  if (refs.length > 0 && !scopeCheckOk(role, refs)) {
    reasons.push("затронута чужая зона: факты другой категории в выводе специалиста");
  }
  // темы чужих категорий без чужого факта — та же ограда по словарю
  const topic = foreignTopic(role, stripMarkers(text));
  if (topic !== null) {
    reasons.push(`затронута чужая зона: тема «${topic}» не принадлежит роли`);
  }

  // (3) числовой коридор УДАЛЁН (23.09, решение Алексея: «убрать валидатор
  // чисел, цифры это нормально, это должно быть заложено в хартии; пройдут
  // они пару раз, неприятно, но не критично»). Дисциплина чисел — в
  // хартиях и тон-гайде; цифра вне фактов больше не роняет текст.

  // (4) новые сущности: пути файлов и CVE
  const factRaw = input.facts.map((f) => JSON.stringify(f.value) ?? "").join(" ");
  const badFiles = [...stripMarkers(text).matchAll(FILE_TOKEN)]
    .map((m) => m[0])
    .filter((f) => !factRaw.includes(f))
    .slice(0, 5);
  if (badFiles.length > 0) reasons.push(`упомянуты файлы вне фактов: ${badFiles.join(", ")}`);
  // В5.1 (Ищейка-З2): CVE из фактов разрешён (сверка с factRaw, как у файлов)
  const badCves = [...stripMarkers(text).matchAll(CVE_TOKEN)]
    .map((m) => m[0])
    .filter((c) => !factRaw.includes(c))
    .slice(0, 5);
  if (badCves.length > 0) reasons.push(`упомянуты CVE вне фактов: ${badCves.join(", ")}`);

  return {
    ok: reasons.length === 0,
    reasons,
    refs,
    segmentsUsed: segsUsed,
    clean: stripMarkers(text),
  };
}

// ---------- флаг фрода: строгий мини-JSON, не проза (К5.10) ----------

export interface FraudFlag {
  flag: boolean;
  factors: Array<{ key: string; note: string }>;
}

export interface FlagValidateResult {
  ok: boolean;
  reason: string | null;
  flag: FraudFlag | null;
}

/**
 * Вывод флаггера — только `{"flag":bool,"factors":[{"key","note"}]}`:
 * ключи — из входа, note — строка без адресов. Ни одного числа в note вне
 * входных фактов (числа живут в фактах, не в подозрении): набор легальных
 * чисел входа — `allowed` (В5.1, Ищейка-З1); без него числа запрещены вовсе.
 */
export function validateFlagOutput(raw: string, factKeys: Set<string>): FlagValidateResult {
  const fail = (reason: string): FlagValidateResult => ({ ok: false, reason, flag: null });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("вывод флаггера не является JSON");
  }
  const obj = parsed as { flag?: unknown; factors?: unknown } | null;
  if (obj === null || typeof obj !== "object") return fail("форма флага не объект");
  if (typeof obj.flag !== "boolean") return fail("поле flag не boolean");
  if (!Array.isArray(obj.factors)) return fail("поле factors не массив");
  const factors: FraudFlag["factors"] = [];
  for (const f of obj.factors) {
    const item = f as { key?: unknown; note?: unknown } | null;
    if (item === null || typeof item !== "object") return fail("элемент factors не объект");
    if (typeof item.key !== "string" || !factKeys.has(item.key)) return fail(`ключ фактора вне входа: ${String(item.key).slice(0, 40)}`);
    if (typeof item.note !== "string" || item.note.length === 0 || item.note.length > 200) return fail("note фактора пуста или длиннее 200");
    if (/https?:\/\/|www\./i.test(item.note)) return fail("note содержит адрес");
    // аудит безопасности М8: управляющие и bidi-символы в note — как в прочих текстах модели
    if (/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(item.note)) return fail("note содержит управляющие символы");
    factors.push({ key: item.key, note: item.note });
  }
  return { ok: true, reason: null, flag: { flag: obj.flag, factors } };
}
