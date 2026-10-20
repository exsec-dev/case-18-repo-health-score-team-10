// Механический валидатор LLM-вывода:
// (1) форма и длина; (2) привязка — каждое утверждение несет {f:ключ} из входа
// (для overview/trajectory — еще сегменты специалистов {sp:роль:n});
// (4) запрет новых сущностей (пути файлов, CVE); (5) запрет markdown-ссылок,
// картинок и сырых URL; (6) язык читателя — без латинских внутренних ключей,
// сырых долей и жаргона методики. Пункта (3) нет: числового коридора сознательно
// нет, дисциплину чисел держат хартии. Невалидно → конвейер повторяет запрос
// с причинами → fail-soft; невалидированный текст в продукт не попадает.
import { categoryOf, KINDS } from "../collectors/facts";
import { CATEGORY_TITLES } from "../report/categories";
import { SUBMETRICS } from "../report/submetrics";
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

// фигурные скобки {f:ключ}, а не [[f:ключ]]: двойные квадратные модели рвут
// (привычка к массивам)
const F_MARKER = /\{f:([a-z0-9._@-]+)\}/g;
const SP_MARKER = /\{sp:([a-z0-9-]+):(\d+)\}/g;
const FILE_TOKEN = /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|h|cpp|cs|swift|sh|md|ya?ml|json|toml|xml|ini|cfg|conf)\b/gi;
// регулярки для .test() — без флага g: иначе lastIndex переживает вызов и валидатор
// перестает быть чистой функцией (CVE_TOKEN идет через matchAll, там g обязателен)
const CVE_TOKEN = /\bCVE-\d{4}-\d{4,}\b/gi;
const URL_TOKEN = /https?:\/\/|www\./i;
const MD_LINK = /\[[^\]\n]*\]\([^)\n]*\)/;
const MD_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/;

/**
 * Битые маркеры («{f:текст с опечаткой», «{f:}», вложенные «{{f:key}}») отклоняют
 * текст целиком: иначе мусор остался бы в clean, который видит пользователь.
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

/** Уникальные ссылки на факты и сегменты в порядке появления в тексте. */
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
    // маркеры через запятую («обновляется{sp:a:1},{sp:a:2}.») оставляют «обновляется,,.»:
    // запятые перед концом фразы снимаются, серия запятых схлопывается в одну
    .replace(/[,;]+(?=[.!?])/g, "")
    .replace(/,{2,}/g, ",")
    .trim();
}

function scopeCheckOk(role: SummaryRole, keys: string[]): boolean {
  if (!(SPECIALIST_ROLES as readonly string[]).includes(role)) return true; // overview/trajectory/flagger — по факту входа
  const allowed = ROLE_FACT_CATEGORIES[role as keyof typeof ROLE_FACT_CATEGORIES] ?? [];
  return keys.every((key) => allowed.includes(categoryOf(key)));
}

/**
 * Темы чужих категорий — тоже «новая сущность»: специалист, рассуждающий
 * о чужой зоне без чужого факта, отбрасывается. Ключевые слова
 * намеренно узкие (срабатывание = ретрай, а не штраф), у своей категории
 * слов нет: activity-специалисту слово «коммит» разрешено.
 */
const FOREIGN_TOPIC_WORDS: Partial<Record<string, string[]>> = {
  documentation: ["активност", "коммит", "commits", "уязвимост", "cve", "пайплайн", "pipeline", "тикет", "todo", "fixme"],
  code: ["активност", "коммит", "commits", "уязвимост", "cve", "пайплайн", "тикет"],
  // activity пересказывает темы коммитов, а коммиты законно бывают «про README»,
  // «про пайплайн» и «про уязвимость»: слова чужих зон ей не запрещены, выдуманные
  // CVE и файлы ловят отдельные проверки
  activity: ["cve"],
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

// ---------- (6) язык читателя: утечки внутренней кухни ----------
//
// В прозу модели протекали латинские ключи («documentation поднялась»), сырые
// доли («53,29%», «на уровне 1») и жаргон методики («якорных файлов»). Цифры
// сами по себе законны — запрещается только ФОРМА записи. Все три проверки узкие:
// срабатывание = ретрай с причиной, а ложный отказ на нормальном тексте хуже пропуска.

/** Префиксы ключей фактов (категории + префиксы kinds) — для составных `a.b`. */
const KEY_PREFIXES: ReadonlySet<string> = new Set([
  ...Object.keys(CATEGORY_TITLES),
  ...Object.keys(KINDS).map((k) => k.split(".")[0]!),
  "scores", // факт динамики scores.points
]);

/**
 * Словарь внутренних ключей из кода: ключи категорий, ключи подметрик и их
 * хвосты, ключи kinds и их хвосты, snake_case-поля форм значений kinds, поля
 * точек динамики. Сверка — отдельное слово латиницей в нижнем регистре.
 */
const LEAK_KEYS: ReadonlySet<string> = (() => {
  const out = new Set<string>(Object.keys(CATEGORY_TITLES));
  const withTails = (key: string) => {
    const parts = key.split(".");
    for (let i = 0; i < parts.length; i++) {
      const tail = parts.slice(i).join(".");
      // одиночный средний сегмент («git» из activity.git.timeline) — обычное слово, не ключ
      if (i > 0 && i < parts.length - 1 && !tail.includes(".")) continue;
      out.add(tail);
    }
  };
  for (const key of Object.keys(SUBMETRICS)) withTails(key);
  for (const key of Object.keys(KINDS)) withTails(key);
  for (const shape of Object.values(KINDS) as string[]) {
    for (const m of shape.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g)) out.add(m[0]);
  }
  // поля точек динамики (pipeline.historyPoints) и доля зависших из модели
  for (const k of ["index", "coverage", "categories", "stale_share"]) out.add(k);
  // обычные имена каталогов репозитория (специалист кода видит дерево и через
  // инструменты, не только через факты) — одиночным словом не ключ; составные
  // code.tests / code.root остаются в словаре
  for (const k of ["git", "tests", "config", "configs", "root"]) out.delete(k);
  return out;
})();

/** camelCase-поля входа, которые тоже не должны звучать в прозе. */
const LEAK_CAMEL: ReadonlySet<string> = new Set(["headSha"]);

const FILE_EXT = /\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|h|cpp|cs|swift|sh|md|ya?ml|json|toml|xml|ini|cfg|conf|txt|lock)$/i;

/** Все строковые листья значений фактов: имена каталогов и файлов из фактов — законны. */
function factStrings(facts: FactInput[]): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof v === "string") {
      out.add(v);
      out.add(v.replace(/\/+$/, ""));
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v !== null && typeof v === "object") {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  for (const f of facts) walk(f.value, 0);
  return out;
}

/**
 * (а) Латинские внутренние ключи в прозе. Текст — уже без маркеров {f:…}.
 * Слово с заглавной буквой (README, CODEOWNERS, CI/CD, HealthCraft) — имя из
 * интерфейса, не ключ; путь со слэшем и имя файла с расширением — не ключ;
 * строка, которая есть среди значений фактов (каталог `tests` в корне), — данные.
 */
export function internalKeyLeaks(clean: string, facts: FactInput[]): string[] {
  const values = factStrings(facts);
  const found: string[] = [];
  for (const m of clean.matchAll(/(?<![\p{L}\p{N}_./@-])[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*(?![\p{L}\p{N}_/@-])/gu)) {
    const token = m[0];
    const after = clean[m.index! + token.length];
    if (after === "/") continue;
    if (FILE_EXT.test(token)) continue;
    if (values.has(token)) continue;
    // «каталог coverage», «папка docs» — имя каталога, названное как каталог
    if (/(?:каталог|папк|директори)[а-я]*(?:[\s,A-Za-z0-9_.-]|и(?=\s)){0,40}$/iu.test(clean.slice(Math.max(0, m.index! - 60), m.index!))) continue;
    let leak = false;
    if (LEAK_CAMEL.has(token)) leak = true;
    else if (token === token.toLowerCase()) {
      if (LEAK_KEYS.has(token)) leak = true;
      else if (token.includes(".") && KEY_PREFIXES.has(token.split(".")[0]!)) leak = true;
    }
    if (leak && !found.includes(token)) found.push(token);
  }
  return found.slice(0, 5);
}

/**
 * (б) Сырые числа. Число с 2+ знаками после запятой или точки («53,29%»,
 * «0,4512»); версии и даты «27.09.2026» не в счет (соседние разделители), как и
 * дата «25.09» (день.месяц). Доля без процентов: «на уровне 0/1», дробь 0,xx
 * рядом со словом «доля/покрытие/уровень».
 */
export function rawNumberLeaks(clean: string): string[] {
  const found: string[] = [];
  // одно число — одна причина: позиция числа уже названа более широким совпадением
  const seen = new Set<number>();
  const push = (s: string, numberAt: number) => {
    if (seen.has(numberAt)) return;
    seen.add(numberAt);
    const t = s.trim();
    if (!found.includes(t)) found.push(t);
  };
  const UNIT = String.raw`(?!\s*(?:%|процент|балл|дн|дня|дней|день|ч(?!\p{L})|час|мин|сек|с(?!\p{L})|раз|из(?!\p{L})|пункт|месяц|недел|год|лет|автор|коммит|задач|запуск|файл|строк))`;
  // дробь 0,xx рядом со словом «доля/покрытие/уровень» (без других чисел между)
  const near = new RegExp(String.raw`(?:дол[яеиюь]|покрыти[а-я]*|уров[а-я]*)[^.!?\n\d]{0,40}?(?<![\d.,])(0[.,]\d+)(?![.,]?\d)${UNIT}`, "giu");
  for (const m of clean.matchAll(near)) push(m[0], m.index! + m[0].length - m[1]!.length);
  // «на уровне 1», «уровень 0,85» — доля, названная числом, без процентов
  const level = new RegExp(String.raw`уров[а-я]*\s+([01](?:[.,]\d+)?)(?![.,]?\d)${UNIT}`, "giu");
  for (const m of clean.matchAll(level)) push(m[0], m.index! + m[0].length - m[1]!.length);
  for (const m of clean.matchAll(/(?<!\d|\d[.,])(\d+)([.,])(\d{2,})(?![.,]?\d)/g)) {
    const [, whole, sep, frac] = m;
    // «25.09» — дата день.месяц, не доля
    if (sep === "." && frac!.length === 2 && Number(whole) >= 1 && Number(whole) <= 31 && Number(frac) >= 1 && Number(frac) <= 12) continue;
    push(m[0], m.index!);
  }
  return found.slice(0, 5);
}

/** (в) Жаргон методики: читателю не нужны внутренние слова оценки. */
const JARGON: Array<{ re: RegExp; word: string }> = [
  { re: /якорн[а-я]*/iu, word: "якорн*" },
  { re: /подметрик[а-я]*/iu, word: "подметрик*" },
  { re: /перенормир[а-я]*/iu, word: "перенормир*" },
  { re: /сжат[а-я]*\s+к\s+минимуму/iu, word: "сжат* к минимуму" },
];

export function jargonLeaks(clean: string): string[] {
  const out: string[] = [];
  for (const { re, word } of JARGON) {
    const m = clean.match(re);
    if (m) out.push(`«${m[0]}» (${word})`);
  }
  return out;
}

/** Порог «Почините CI» (`recommend.ts`): ниже — рядом с текстом стоит критичная рекомендация. */
const CI_PASS_MIN = 0.9;

/**
 * Оценочное слово о CI против числа: «CI стабилен» при доле успешных запусков ниже
 * порога спорит с «Почините CI · Критично» на той же карточке. Доля — с учетом
 * свежести, как в показателе. null — противоречия нет.
 */
export function ciStabilityClaim(text: string, facts: FactInput[]): string | null {
  const runs = facts.find((f) => f.key === "cicd.runs")?.value as { weighted_success_rate?: unknown; success_rate?: unknown } | undefined;
  const rate = typeof runs?.weighted_success_rate === "number" ? runs.weighted_success_rate : typeof runs?.success_rate === "number" ? runs.success_rate : null;
  if (rate === null || rate >= CI_PASS_MIN) return null;
  const sentences = text.split(/(?<=[.!?])\s+/);
  // утверждение «стабилен» — без отрицаний («нестабильно», «не всегда проходит») и без
  // названия показателя «Стабильность CI…»: честный текст о плохом CI отклонять нельзя
  const praise = /(?<![а-я\u0451])(стабильн(?:о|ый|ая|ое|ы|ен|на)|надежн(?:о|ый|ая|ое|ы|ен|на)|без сбоев|успешно проход\S*)(?![а-я\u0451])/i;
  const negation = /(?<![а-я\u0451])не(?![а-я\u0451])|нестабил|ненадеж|сбо[ий]|пада|ошиб|красн/i;
  const claim = sentences.find((t) => /(CI|сборк|пайплайн|автоматизац)/i.test(t) && praise.test(t) && !negation.test(t));
  return claim === undefined
    ? null
    : `CI назван стабильным, а успешны ${Math.round(rate * 100)}% запусков с учетом свежести (нужно не меньше 90%) – опиши долю как есть`;
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
  // bidi/zero-width (RLO, ZWSP, BOM) — тоже отказ: визуальный спуфинг в интерфейсе
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(text)) {
    reasons.push("в тексте контрольные символы");
  }
  const broken = brokenMarkerFragment(text);
  if (broken !== null) {
    reasons.push(`в тексте битый маркер: ${broken}`);
  }

  // (5) ссылки, картинки, сырые URL
  if (MD_LINK.test(text) || MD_IMAGE.test(text)) reasons.push("markdown-ссылки и картинки запрещены");
  if (URL_TOKEN.test(text)) reasons.push("внешние адреса в тексте запрещены");

  // (2) привязка; маркеры в старом формате [[..]] отклоняются с подсказкой нового
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

  // (3) числового коридора нет: дисциплина чисел — в хартиях и тон-гайде,
  // цифра вне фактов текст не роняет

  // (4) новые сущности: пути файлов и CVE
  const factRaw = input.facts.map((f) => JSON.stringify(f.value) ?? "").join(" ");
  const badFiles = [...stripMarkers(text).matchAll(FILE_TOKEN)]
    .map((m) => m[0])
    .filter((f) => !factRaw.includes(f))
    .slice(0, 5);
  if (badFiles.length > 0) reasons.push(`упомянуты файлы вне фактов: ${badFiles.join(", ")}`);
  // CVE из фактов разрешен (сверка с factRaw, как у файлов)
  const badCves = [...stripMarkers(text).matchAll(CVE_TOKEN)]
    .map((m) => m[0])
    .filter((c) => !factRaw.includes(c))
    .slice(0, 5);
  if (badCves.length > 0) reasons.push(`упомянуты CVE вне фактов: ${badCves.join(", ")}`);

  // (6) язык читателя: ключи, сырые доли, жаргон методики
  const readerText = stripMarkers(text);
  const keys = internalKeyLeaks(readerText, input.facts);
  if (keys.length > 0) {
    reasons.push(
      `внутренние ключи латиницей в тексте: ${keys.join(", ")} – называй по-русски, как в интерфейсе (Документация, CI/CD, Безопасность, Активность, Задачи, Состояние кода; файлы – README, CONTRIBUTING, CODEOWNERS, LICENSE)`,
    );
  }
  const raw = rawNumberLeaks(readerText);
  if (raw.length > 0) {
    reasons.push(`сырые числа: ${raw.map((r) => `«${r}»`).join(", ")} – доли пиши целыми процентами («65%»), дробные – не больше 1 знака после запятой, баллы – целыми`);
  }
  const jargon = jargonLeaks(readerText);
  if (jargon.length > 0) {
    reasons.push(`жаргон методики: ${jargon.join(", ")} – скажи словами читателя (например, «обязательные файлы», «показатели»)`);
  }

  const ci = ciStabilityClaim(readerText, input.facts);
  if (ci !== null) reasons.push(ci);

  return {
    ok: reasons.length === 0,
    reasons,
    refs,
    segmentsUsed: segsUsed,
    clean: stripMarkers(text),
  };
}

// ---------- флаг накрутки: строгий мини-JSON, не проза ----------

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
 * ключи — из входа, note — короткая строка без адресов и управляющих символов.
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
    // управляющие и bidi-символы в note — отказ, как в прочих текстах модели
    if (/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(item.note)) return fail("note содержит управляющие символы");
    factors.push({ key: item.key, note: item.note });
  }
  // флаг без улик и улики без флага — не вердикт: карточка показала бы флаг с пустым списком
  if (obj.flag && factors.length === 0) return fail("flag true без factors");
  if (!obj.flag && factors.length > 0) return fail("factors при flag false");
  return { ok: true, reason: null, flag: { flag: obj.flag, factors } };
}
