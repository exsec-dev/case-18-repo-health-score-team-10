// «Почему изменилась оценка» на карточке: строка под анализом в «Все анализы» и
// плашка «Что изменилось» под графиком истории. Расчет — `summary/score-change`
// (сервер, маршрут /history); здесь только слова и выбор точки.

import type { HistoryPoint, ScoreCategoryChange, ScoreChange } from "../summary/history-contract";
import { CATEGORY_TITLES_RU, MINUS, fmtDate, roundScore } from "./format";

/** Целая разница со знаком: «+9», «−1». */
export function fmtDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `${MINUS}${-delta}` : "0";
}

/** Показанная разница показателя к прошлой точке; null — сравнивать нечего. */
function shownDelta(pair: { from: number | null; to: number | null } | null | undefined): number | null {
  if (!pair || pair.from === null || pair.to === null) return null;
  return roundScore(pair.to) - roundScore(pair.from);
}

/** Разница индекса и полного показателя у точки истории (0 — не менялся, null — не с чем сравнить). */
export function pointDeltas(point: HistoryPoint, fullOpen: boolean): { index: number | null; full: number | null } {
  const c = point.change;
  return { index: shownDelta(c?.index), full: fullOpen ? shownDelta(c?.full) : null };
}

/** Точка изменилась так, что это стоит объяснять: сдвиг показанного числа или особый переход. */
export function pointChanged(point: HistoryPoint, fullOpen: boolean): boolean {
  if (point.change === null) return false;
  if (point.change.special !== null) return true;
  const d = pointDeltas(point, fullOpen);
  return (d.index !== null && d.index !== 0) || (d.full !== null && d.full !== 0);
}

/** Последнее изменение оценки — для плашки «Что изменилось»; null — оценка ни разу не менялась. */
export function lastChange(points: HistoryPoint[], fullOpen: boolean): HistoryPoint | null {
  for (let i = points.length - 1; i >= 0; i--) if (pointChanged(points[i]!, fullOpen)) return points[i]!;
  return null;
}

export function categoryTitle(key: string): string {
  return CATEGORY_TITLES_RU[key] ?? key;
}

/** Вклад строки категории: в индексе — к индексу, CI/CD и Безопасность — к Repo Health Score. */
export function categoryContribution(c: ScoreCategoryChange): { value: number; full: boolean } | null {
  if (c.index !== null) return { value: c.index, full: false };
  if (c.full !== null) return { value: c.full, full: true };
  return null;
}

/**
 * Название подметрики внутри фразы: без уточнения в скобках («README (наличие
 * и качество)» → «README»), со строчной буквы, кроме аббревиатур (CONTRIBUTING, CI).
 */
export function subInline(title: string): string {
  const t = title.replace(/\s*\(.*\)$/, "");
  const first = t.split(/\s/)[0]!;
  return first.length > 1 && first === first.toUpperCase() ? t : t.charAt(0).toLowerCase() + t.slice(1);
}

/**
 * «Задачи» с баллом 0: в трекере нет ни одной засчитанной закрытой задачи —
 * задачи не ведутся (так почти всегда) или открытые есть, но не закрыта ни одна.
 * Подметрик в изменении нет, поэтому фраза называет оба случая.
 */
const ISSUES_ZERO = "задачи не ведутся или ни одна не закрыта";

/**
 * Сдвиг категории без названных показателей. До 2 баллов — сумма мелких
 * изменений (каждое ниже порога в 2 п. п.). Больше — так сдвигает только смена
 * набора показателей: показатель вошел в расчет или выпал из него.
 */
const SUBS_SET_STEP = 2;

/** Пояснение к категории без разбивки по подметрикам: данные появились, пропали или показатели не названы. */
export function categoryNote(c: ScoreCategoryChange): string | null {
  const zeroIssues = c.key === "issues" && c.to !== null && roundScore(c.to) === 0;
  if (c.kind === "appeared") return `появились данные – ${zeroIssues ? ISSUES_ZERO : `категория учтена в оценке с баллом ${roundScore(c.to ?? 0)}`}`;
  if (c.kind === "gone") return "данных больше нет – категория не учитывается в оценке";
  if (c.subs.length > 0) return null;
  if (zeroIssues) return ISSUES_ZERO;
  return Math.abs((c.to ?? 0) - (c.from ?? 0)) < SUBS_SET_STEP ? "небольшие изменения показателей" : "изменился набор учтенных показателей";
}

/** Фраза особого перехода (без разбивки по категориям). */
export function specialText(change: ScoreChange): string | null {
  switch (change.special) {
    case "code-appeared":
      return "В репозитории появился код – пока его не было, оценка по методике была 0.";
    case "code-gone":
      return "В репозитории не осталось кода – по методике оценка 0.";
    case "score-appeared":
      return "Данных стало достаточно для оценки – до этого ее не было.";
    case "score-gone":
      return "Данных не хватило для оценки – часть категорий осталась без данных.";
    default:
      return null;
  }
}

/**
 * Изменение показателя словами — направление без чисел («README подробнее»,
 * «TODO/FIXME в коде встречаются чаще»): числа «было → стало» — в подсказке.
 * Ключ — `<категория>.<показатель>`. Доли названы долями: «доля решенных задач
 * ниже» не спорит с «закрытых задач стало больше» рядом.
 */
const SUB_WORDS: Record<string, [better: string, worse: string]> = {
  "documentation.readme": ["README подробнее", "README менее подробный"],
  "cicd.config": ["настройка CI полнее", "настройка CI менее полная"],
  "cicd.pass_rate": ["больше успешных запусков CI", "больше упавших запусков CI"],
  "cicd.duration": ["запуски CI идут быстрее", "запуски CI идут дольше"],
  "security.density": ["меньше находок AppSec", "больше находок AppSec"],
  "security.resolved": ["доля закрытых находок AppSec выше", "доля закрытых находок AppSec ниже"],
  "security.secrets": ["критичные утечки секретов больше не найдены", "найдены критичные утечки секретов"],
  "security.deps": ["меньше уязвимых зависимостей", "больше уязвимых зависимостей"],
  "activity.fresh": ["последний коммит свежее", "с последнего коммита прошло больше времени"],
  "activity.freq": ["больше коммитов в месяц", "меньше коммитов в месяц"],
  "activity.contributors": ["больше авторов", "меньше авторов"],
  "activity.pulls_90d": ["больше предложений изменений", "меньше предложений изменений"],
  "activity.releases_12m": ["больше релизов", "меньше релизов"],
  "issues.stale": ["меньше зависших задач", "больше зависших задач"],
  "issues.close_days": ["задачи закрывают быстрее", "задачи закрывают медленнее"],
  "issues.resolution": ["доля решенных задач выше", "доля решенных задач ниже"],
  "issues.first_resp": ["на задачи отвечают быстрее", "на задачи отвечают медленнее"],
  "code.density": ["TODO/FIXME в коде встречаются реже", "TODO/FIXME в коде встречаются чаще"],
  "code.old_share": ["доля старых TODO ниже", "доля старых TODO выше"],
  "code.tests": ["больше тестов", "меньше тестов"],
  "code.root": ["в корне репозитория меньше файлов и папок", "в корне репозитория больше файлов и папок"],
};

/** Ведущее целое значения поправки: «43 из 200 строк» → 43, «достаточно» → null. */
function leadNumber(value: string): number | null {
  const m = /^(\d+)\s/.exec(value);
  return m === null ? null : Number(m[1]);
}

/** «1 из 3 дней» → «в один день»: поправка по дням бывает только при 1 или 2 днях. */
const DAYS_WORDS: Record<number, string> = { 1: "в один день", 2: "в два разных дня" };

/**
 * Поправка балла словами. Значения — как в подсказке: «43 из 200 строк»,
 * «5 из 10», «1 из 3 дней», «не выше 40», «достаточно»/«нет». Фраза говорит,
 * что сейчас с выборкой или потолком, а не только «лучше/хуже»: поправка
 * появляется и без смены объема кода (когда балл поднялся выше середины шкалы).
 */
function adjustmentPhrase(kind: string, s: ScoreCategoryChange["subs"][number]): string | null {
  const a = leadNumber(s.from);
  const b = leadNumber(s.to);
  if (kind === "small-code") {
    if (s.to === "достаточно") return "кода достаточно для надежной оценки";
    if (a !== null && b !== null && a !== b) return b > a ? "кода стало больше" : "кода стало меньше";
    return "кода мало для надежной оценки";
  }
  if (kind === "small-sample") {
    if (s.to === "достаточно") return "закрытых задач достаточно для надежной оценки";
    if (s.to.endsWith("дней")) return `задачи закрывали только ${DAYS_WORDS[b ?? 0] ?? "в немногие дни"}`;
    if (b === 0) return "ни одна задача не закрыта";
    if (a !== null && b !== null && a !== b && !s.from.endsWith("дней")) return b > a ? "закрытых задач стало больше" : "закрытых задач стало меньше";
    return "закрытых задач мало для надежной оценки";
  }
  if (kind === "open-findings-cap") {
    if (s.to === "нет") return "открытые находки AppSec больше не ограничивают балл";
    const limit = /(\d+)/.exec(s.to);
    const what = limit !== null && Number(limit[1]) <= 40 ? "критичные находки AppSec" : "находки AppSec высокой важности";
    return `открытые ${what} ограничивают балл`;
  }
  return null;
}

/** Конфигурация CI по значениям подсказки: «нет ci.yaml» / «ci.yaml без команд» / «ci.yaml с командами». */
function ciConfigPhrase(s: ScoreCategoryChange["subs"][number]): string | null {
  const had = s.from !== "нет ci.yaml" && s.from !== "–";
  if (s.to === "нет ci.yaml") return "больше нет ci.yaml";
  if (s.to === "ci.yaml не удалось разобрать") return "ci.yaml не удалось разобрать";
  if (s.to === "ci.yaml с командами") return had ? "в ci.yaml появились команды" : "появился ci.yaml с командами";
  if (s.to === "ci.yaml без команд") return s.from === "ci.yaml с командами" ? "в ci.yaml больше нет команд" : "появился ci.yaml, но без команд";
  return null;
}

/** Файлы «есть/нет»: имя во фразе и род глагола («появилась лицензия», «появился CONTRIBUTING»). */
const PRESENCE: Record<string, [name: string, feminine: boolean]> = {
  license: ["лицензия", true],
  contributing: ["CONTRIBUTING", false],
  codeowners: ["CODEOWNERS", false],
};

/**
 * README появился или пропал — тоже файл «есть/нет» («появились лицензия и
 * README»), а не «подробнее/менее подробный»; null — файл был и остался.
 */
function readmePresence(s: ScoreCategoryChange["subs"][number]): boolean | null {
  if (s.to === "нет файла") return false;
  if (s.from === "нет файла") return true;
  return null;
}

/** Родительный падеж для «больше нет …»: «лицензии», имена файлов не склоняются. */
const PRESENCE_GENITIVE: Record<string, string> = { лицензия: "лицензии" };

function listWords(list: string[]): string {
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} и ${list[list.length - 1]}` : list[0]!;
}

/** «появилась лицензия», «появился CONTRIBUTING», «появились лицензия и CONTRIBUTING»; пропали — «больше нет лицензии и CONTRIBUTING». */
function presencePhrase(names: [string, boolean][], appeared: boolean): string {
  if (!appeared) return `больше нет ${listWords(names.map((n) => PRESENCE_GENITIVE[n[0]] ?? n[0]))}`;
  const verb = names.length > 1 ? "появились" : names[0]![1] ? "появилась" : "появился";
  return `${verb} ${listWords(names.map((n) => n[0]))}`;
}

/** Фраза одного показателя; null — показатель не называем (поправка неизвестного вида). */
function subPhrase(c: ScoreCategoryChange, s: ScoreCategoryChange["subs"][number]): string | null {
  if (s.key.startsWith("adjustment.")) return adjustmentPhrase(s.key.slice("adjustment.".length), s);
  const special = c.key === "cicd" && s.key === "config" ? ciConfigPhrase(s) : null;
  if (special !== null) return special;
  const words = SUB_WORDS[`${c.key}.${s.key}`];
  if (words !== undefined) return words[s.better ? 0 : 1];
  return `показатель «${s.title.replace(/\s*\(.*\)$/, "")}» ${s.better ? "вырос" : "снизился"}`;
}

/**
 * Почему сдвинулась категория — одна фраза без чисел: «появились лицензия и
 * CONTRIBUTING, README подробнее». null — сказать нечего.
 */
export function categoryPhrase(c: ScoreCategoryChange): string | null {
  const note = categoryNote(c);
  if (c.subs.length === 0) return note;
  const appeared: [string, boolean][] = [];
  const gone: [string, boolean][] = [];
  const rest: string[] = [];
  // ни одна задача не закрыта — время закрытия и доля решенных уже сказаны этим
  const noneClosed = c.key === "issues" && c.subs.some((s) => s.key === "adjustment.small-sample" && leadNumber(s.to) === 0);
  for (const s of c.subs) {
    const presence = PRESENCE[s.key];
    const readme = c.key === "documentation" && s.key === "readme" ? readmePresence(s) : null;
    if (presence !== undefined && c.key === "documentation") (s.better ? appeared : gone).push(presence);
    else if (readme !== null) (readme ? appeared : gone).push(["README", false]);
    else if (noneClosed && !s.better && (s.key === "close_days" || s.key === "resolution")) continue;
    else {
      const phrase = subPhrase(c, s);
      if (phrase !== null) rest.push(phrase);
    }
  }
  const parts = [...(appeared.length > 0 ? [presencePhrase(appeared, true)] : []), ...(gone.length > 0 ? [presencePhrase(gone, false)] : []), ...rest];
  return parts.length > 0 ? parts.join(", ") : note;
}

/** Числа за фразой — «было → стало» по показателям, для подсказки. */
export function categoryDetails(c: ScoreCategoryChange): string[] {
  return c.subs.map((s) => `${s.title}: ${s.from} → ${s.to}`);
}

/**
 * Строка под анализом в «Все анализы»: категории с вкладом и главные причины —
 * «Документация +9: появились CONTRIBUTING и CODEOWNERS · Код −1: TODO/FIXME в коде встречаются чаще».
 * null — объяснять нечего.
 */
export function changeLine(point: HistoryPoint, fullOpen: boolean): string | null {
  const c = point.change;
  if (c === null || !pointChanged(point, fullOpen)) return null;
  const special = specialText(c);
  if (special !== null) return special;
  const parts = c.categories.flatMap((cat) => {
    const contrib = categoryContribution(cat);
    if (contrib === null || contrib.value === 0) return [];
    const head = `${categoryTitle(cat.key)} ${fmtDelta(contrib.value)}${contrib.full ? " к Repo Health Score" : ""}`;
    const why = categoryPhrase(cat);
    return [why === null ? head : `${head}: ${why}`];
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ---------- мостик «Что изменилось» между двумя анализами ----------

export type BridgeMetric = "index" | "full";

/** День анализа в поле выбора: последний анализ дня — каким репозиторий был к концу дня. */
export interface DayOption {
  scanId: number;
  day: string;
}

/** Дни истории по порядку: один пункт на день — его последний анализ. Анализы без времени не выбираются. */
export function dayOptions(points: HistoryPoint[]): DayOption[] {
  const out: DayOption[] = [];
  for (const p of points) {
    if (p.finishedAt === null) continue;
    const day = fmtDate(p.finishedAt);
    if (out.length > 0 && out[out.length - 1]!.day === day) out[out.length - 1] = { scanId: p.scanId, day };
    else out.push({ scanId: p.scanId, day });
  }
  return out;
}

/**
 * Пара по умолчанию: от конца дня перед последним изменением оценки до
 * последнего анализа — панель сразу отвечает «почему оценка сейчас такая».
 * null — оценка не менялась ни разу или день всего один.
 */
export function defaultPair(points: HistoryPoint[], fullOpen: boolean): { from: number; to: number } | null {
  // панель открывается на индексе — берем последнее изменение индекса; полный
  // показатель — только если индекс не менялся ни разу
  const changed = lastChange(points, false) ?? lastChange(points, fullOpen);
  const days = dayOptions(points);
  if (changed === null || changed.finishedAt === null || days.length < 2) return null;
  const changeDay = days.findIndex((d) => d.day === fmtDate(changed.finishedAt));
  return { from: days[Math.max(0, changeDay - 1)]!.scanId, to: days[days.length - 1]!.scanId };
}

export interface BridgeStep {
  change: ScoreCategoryChange;
  value: number;
  /** итог до и после ступени */
  before: number;
  after: number;
}

export interface Bridge {
  from: number;
  to: number;
  steps: BridgeStep[];
}

/**
 * Ступени мостика: от показанного итога «с» через вклады категорий к итогу «по».
 * Для индекса — 4 открытые категории, для Repo Health Score — все с вкладом в него.
 * null — итога с одной из сторон нет или переход особый (появился код и т. п.).
 */
export function bridgeOf(change: ScoreChange, metric: BridgeMetric): Bridge | null {
  const pair = metric === "index" ? change.index : change.full;
  if (!pair || pair.from === null || pair.to === null || change.special !== null) return null;
  if (metric === "full" && change.fullCapped) return null;
  let run = roundScore(pair.from);
  const steps: BridgeStep[] = [];
  for (const c of change.categories) {
    const value = metric === "index" ? c.index : c.full;
    if (value === null || value === 0) continue;
    steps.push({ change: c, value, before: run, after: run + value });
    run += value;
  }
  steps.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  // порядок — по величине вклада, итоги ступеней пересчитаны по этому порядку
  run = roundScore(pair.from);
  for (const s of steps) {
    s.before = run;
    s.after = run + s.value;
    run = s.after;
  }
  return { from: roundScore(pair.from), to: roundScore(pair.to), steps };
}
