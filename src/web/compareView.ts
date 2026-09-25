// compareView.ts — view-модель раздела «Сравнение» (В5.3 круг 4, К-1).
//
// Все, что раздел утверждает о наборе, считается здесь, а не в разметке: лидер
// строки, «по N категориям из 4», заметки сопоставимости, видимость строк
// полной оценки, разбор адреса набора. Числа приходят с сервера (карточка
// зрителя, `src/api/compare.ts`), здесь — только презентация над ними; новых
// баллов (разница, «индекс по общим категориям») нет — решение 25.09.
// Модуль чистый: без React и uikit, его импортирует `bun test`.
import type { CompareCard, CompareItem } from "../api/compare";
import { COMPARE_MAX } from "../api/compare";
import { parseFavoriteInput } from "../api/slug-input";
import { analysisDate } from "../report/sections";
import { plural } from "../report/submetrics";
import type { IndexCategoryKey } from "../score/model";
import { fmtCount, fmtDate, middleEllipsis, roundScore } from "./format";

export { COMPARE_MAX };

/** Категории HealthCraft Index в порядке методики. */
export const INDEX_KEYS: IndexCategoryKey[] = ["documentation", "activity", "issues", "code"];

/** Разрыв дат анализа, с которого сравнение «Активности» оговаривается (решение 25.09: 30 дней; константа интерфейса, не методика). */
export const DATE_GAP_DAYS = 30;

// ---------- адрес набора ----------

/** `?r=org/a&r=org/b` → слаги в порядке первого вхождения, дубли схлопнуты, не больше 3; мусор отброшен. */
export function compareSlugsOf(search: string): string[] {
  const out: string[] = [];
  for (const raw of new URLSearchParams(search).getAll("r")) {
    const p = parseFavoriteInput(raw);
    if (p === null || raw.includes("://")) continue;
    const slug = `${p.org}/${p.repo}`;
    if (!out.includes(slug) && out.length < COMPARE_MAX) out.push(slug);
  }
  return out;
}

/** Адрес раздела для набора: слеш слага остается читаемым. */
export function compareHref(slugs: string[]): string {
  if (slugs.length === 0) return "/compare";
  return `/compare?${slugs.map((s) => `r=${s.split("/").map(encodeURIComponent).join("/")}`).join("&")}`;
}

/** Запрос API для набора (тот же вид, что адрес раздела). */
export function compareApiUrl(slugs: string[]): string {
  return `/api/compare?${slugs.map((s) => `r=${s.split("/").map(encodeURIComponent).join("/")}`).join("&")}`;
}

// ---------- столбцы ----------

/** Столбец с оценкой: элемент `ok` и оценка есть. Прочие столбцы в лидерах и заметках не участвуют. */
export function scoredCard(item: CompareItem): CompareCard | null {
  return item.status === "ok" && item.card.score !== null ? item.card : null;
}

/** «по N категориям из 4»: число категорий индекса с баллом (NULL — нет данных, не 0). */
export function indexCategoriesCounted(card: CompareCard): number {
  const cats = card.score?.categories;
  if (!cats) return 0;
  return INDEX_KEYS.filter((k) => cats[k] !== undefined && cats[k]!.score !== null).length;
}

export function categoriesCountedText(n: number, of: number): string {
  return `по ${n} ${n === 1 ? "категории" : "категориям"} из ${of}`;
}

// ---------- лидер строки ----------

/**
 * Значение ячейки для лидерства: число, «нет данных» (`null`) или «закрыто
 * зрителю» (`"closed"`). Столбец без оценки передается `undefined` — он в
 * строке не участвует вовсе.
 */
export type LeaderInput = number | null | "closed" | undefined;

/**
 * Лидер строки (решение 25.09, продуктовый е1): по показанному целому; нужно
 * ≥ 2 числа; закрытая зрителю ячейка — лидера нет (его нельзя честно
 * назначить); ничья наверху — отмечены все делящие первое место, если это не
 * все числа (все равны — лидера нет); «нет данных» не проигрывает и не
 * выигрывает.
 */
export function rowLeaders(values: LeaderInput[]): boolean[] {
  const none = values.map(() => false);
  if (values.includes("closed")) return none;
  const shown = values.map((v) => (typeof v === "number" ? roundScore(v) : null));
  const numbers = shown.filter((v): v is number => v !== null);
  if (numbers.length < 2) return none;
  const top = Math.max(...numbers);
  const atTop = numbers.filter((v) => v === top).length;
  if (atTop === numbers.length) return none;
  return shown.map((v) => v === top);
}

/**
 * Балл подметрики для лидерства — ТО ЖЕ целое, что на экране (`fmtSubmetric`:
 * `Math.round(score * 100)`). Ревью 25.09: сравнение по `score * 100` через
 * `roundScore` расходилось с показанным на половинках (0,285 → на экране 28,
 * в лидерстве 29) — стрелка стояла у одного из двух одинаковых «28».
 */
export function submetricLeaderValue(score: number | null | undefined): number | null {
  return score === null || score === undefined ? null : Math.round(score * 100);
}

// ---------- реквизиты столбца ----------

/**
 * Место в рейтинге: «#N» и размер выборки (на телефоне при общем размере — в
 * подписи строки); без места — причина по видимости: публичный без индекса —
 * «индекс не выставлен», прочие (internal/private/unknown) — «не в публичном рейтинге».
 */
export function rankCell(card: CompareCard, sharedTotal: number | null): { rank: string; total: string | null } | { none: string } {
  const s = card.score;
  if (s && s.rank !== null && s.rankedTotal !== null) return { rank: `#${fmtCount(s.rank)}`, total: sharedTotal === null ? ` из ${fmtCount(s.rankedTotal)}` : null };
  return { none: card.repo.visibility === "public" ? "без места – индекс не выставлен" : "не в публичном рейтинге" };
}

/** Подпись строки реквизита (Д8 Б, Д9 на телефоне: общий год и общий размер рейтинга — в подписи). */
export function metaRowLabel(key: "language" | "rank" | "date", year: number | null, sharedTotal: number | null): string {
  if (key === "language") return "Язык";
  if (key === "rank") return sharedTotal !== null ? `Место из ${fmtCount(sharedTotal)}` : "Место в рейтинге";
  return year !== null ? `Анализ, ${year}` : "Анализ";
}

// ---------- заметки сопоставимости ----------

/** Слаг в заметке: длинное имя — многоточием в середине, хвост виден (дизайн §4.10); полный — в шапке столбца. */
function noteSlug(c: CompareCard): string {
  return `${c.repo.org}/${middleEllipsis(c.repo.repo, 40, 12)}`;
}

/**
 * Заметки о наборе над таблицей. Нет расхождений — пустой список: утверждения
 * «все сопоставимо» раздел не печатает (продуктовый П10).
 */
export function comparabilityNotes(items: CompareItem[]): string[] {
  const cards = items.map(scoredCard).filter((c): c is CompareCard => c !== null);
  const notes: string[] = [];

  // Т16: разная основа индекса — только у столбцов, где индекс выставлен перевзвешиванием;
  // у пустого репо индекс 0 по правилу методики, не взвешен — в заметку не идет (ревью 25.09)
  const indexed = cards.filter((c) => c.score!.healthcraftIndex !== null && !c.markers.codeEmpty);
  const counts = indexed.map(indexCategoriesCounted);
  if (new Set(counts).size > 1) {
    const by = (n: number) => categoriesCountedText(n, 4).replace(/ из 4$/, "");
    const odd = counts.findIndex((n) => counts.filter((m) => m === n).length === 1);
    const oneOff = indexed.length >= 3 && new Set(counts).size === 2 && odd !== -1;
    // аудит Д11 (§2.11): без повтора «категориям» и без двух тире в одной фразе
    const head = oneOff
      ? `Индекс ${noteSlug(indexed[odd]!)} посчитан ${by(counts[odd]!)} из 4, остальных – по ${counts[(odd + 1) % counts.length]!}`
      : `Индексы посчитаны по разному числу категорий: ${indexed.map((c, i) => `${noteSlug(c)} – ${by(counts[i]!)}`).join(", ")}`;
    notes.push(`${head}. Вес категории без данных переходит к остальным, поэтому точнее сравнивать по категориям.`);
  }

  // Т17: разнесенные даты анализа — «Активность» считается на дату анализа
  const dated = cards.map((c) => ({ c, at: analysisDate(c) })).filter((d): d is { c: CompareCard; at: string } => d.at !== null && !Number.isNaN(Date.parse(d.at)));
  if (dated.length >= 2) {
    const sorted = [...dated].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const days = Math.floor((Date.parse(last.at) - Date.parse(first.at)) / 86_400_000);
    if (days >= DATE_GAP_DAYS) {
      notes.push(`Анализы разнесены на ${days} ${plural(days, "день", "дня", "дней")} (${fmtDate(first.at)} и ${fmtDate(last.at)}): «Активность» считается на дату анализа.`);
    }
  }

  // Т20: нет кода — индекс 0 означает «проекта нет», а не плохой код
  for (const c of cards) {
    if (c.markers.codeEmpty) notes.push(`В ${noteSlug(c)} нет кода – его оценка 0 означает, что оценивать пока нечего.`);
  }
  return notes;
}

// ---------- полная оценка ----------

export type FullKey = "repoHealthScore" | "cicd" | "security";

/**
 * Видимость строк блока «Полная оценка» (решение 25.09, Б3): строка есть,
 * только если показатель открыт зрителю у ВСЕХ столбцов с оценкой (ячейки
 * «закрыто» в таблице нет). `partial` — открыт хотя бы у одного, но не у всех:
 * тогда под таблицей одна строка-пояснение (Т21).
 */
export function fullRows(items: CompareItem[]): { rows: FullKey[]; partial: boolean } {
  const cards = items.map(scoredCard).filter((c): c is CompareCard => c !== null);
  if (cards.length === 0) return { rows: [], partial: false };
  const open: Record<FullKey, (c: CompareCard) => boolean> = {
    repoHealthScore: (c) => c.score!.fullLocked === false,
    cicd: (c) => c.score!.categories.cicd !== undefined && c.score!.categories.cicd.locked === undefined,
    security: (c) => c.score!.categories.security !== undefined && c.score!.categories.security.locked === undefined,
  };
  const keys: FullKey[] = ["repoHealthScore", "cicd", "security"];
  const rows = keys.filter((k) => cards.every(open[k]));
  const partial = keys.some((k) => cards.some(open[k]) && !cards.every(open[k]));
  return { rows, partial };
}

// ---------- тексты раздела (правило языка: `–` в прозе, без «ё», цифры) ----------

export const COMPARE_TITLE = "Сравнение репозиториев";
/** Описание раздела под заголовком — одной фразой, как у «Рейтинга» и «Избранного» (§2 25.09). */
export const COMPARE_LEAD = "Сравнивайте до 3 репозиториев по оценке, категориям и показателям – публичные из рейтинга и свои закрытые.";
export const COMPARE_LIMIT_TEXT = "Сравнить можно до 3 репозиториев – уберите один, чтобы добавить другой.";
/** Д4 А (§2 25.09): при 3 из 3 вместо выключенного поля — строка под заголовком. */
export const COMPARE_FULL_LINE = "В сравнении 3 из 3 – уберите репозиторий, чтобы добавить другой.";
export const COMPARE_ADD = "Добавить репозиторий";
/** Д10: одна формулировка с MD/PDF (`src/report/build.ts`). */
export const COMPARE_REFERENCE = "Справочно, в балл не входит";

/** Д7: столбец-исключение на телефоне — короткая метка в шапке, полный текст под таблицей. */
export function exceptionLabel(kind: "noscore" | "unavailable" | "check_failed" | "token_rejected"): string {
  switch (kind) {
    case "noscore":
      return "оценки нет";
    case "unavailable":
      return "не найден";
    case "check_failed":
      return "нет ответа";
    case "token_rejected":
      return "токен отклонен";
  }
}

/** Д8 Б: год всех дат анализа, если он один; иначе null (тогда дата — с годом в ячейке). */
export function commonYear(isos: (string | null)[]): number | null {
  const years = new Set(isos.filter((i): i is string => i !== null && !Number.isNaN(Date.parse(i))).map((i) => new Date(i).getFullYear()));
  return years.size === 1 ? [...years][0]! : null;
}
export const COMPARE_ONE_TEXT = "Добавьте еще 1 или 2 репозитория, чтобы сравнить.";
export const COMPARE_DUPLICATE_TEXT = "Этот репозиторий уже в сравнении.";
export const COMPARE_BAD_INPUT_TEXT = "Не похоже на адрес репозитория: нужен вид org/repo или ссылка SourceCraft.";
export const COMPARE_UNAVAILABLE_TITLE = "Репозиторий не найден или недоступен";
export const COMPARE_LEADER_LEGEND = "Отмечен лучший балл строки среди репозиториев с данными.";
export const COMPARE_FULL_PARTIAL = "Repo Health Score, CI/CD и Безопасность сравниваются, когда они видны вам у всех выбранных репозиториев.";
export const COMPARE_FOOTER = "Оценки посчитаны по текущей методике; CI/CD и Безопасность в HealthCraft Index не входят.";
export const COMPARE_PLACEHOLDER = "Название, org/repo или ссылка на репозиторий";

/** Т9а/Т9б: что делать с недоступным — по состоянию ЗРИТЕЛЯ, не репозитория (иначе текст раскрыл бы существование). */
export function unavailableText(viewerHasPat: boolean): string {
  return viewerHasPat
    ? "Проверьте адрес: репозитория нет в каталоге сервиса или ваш токен не дает к нему доступа."
    : "Проверьте адрес. Закрытые и внутренние репозитории видны после входа через Я ID и добавления персонального токена доступа SourceCraft.";
}

/** Т10: сбой проверки прав у зрителя с доказанными правами — текст сервера карточки (`cardOrRefusal`) с именем репозитория. */
export function checkFailedText(slug: string): string {
  return `SourceCraft сейчас не отвечает – не удалось проверить доступ к ${slug}, попробуйте позже.`;
}
