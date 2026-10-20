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
 * задачи не ведутся или открытые есть, но не закрыта ни одна (`tracker`
 * изменения). Общая фраза — только если признака нет.
 */
function issuesZero(c: ScoreCategoryChange): string {
  if (c.tracker === "unused") return "задачи не ведутся";
  if (c.tracker === "none-closed") return "ни одна задача не закрыта";
  return "задачи не ведутся или ни одна не закрыта";
}

/**
 * Сдвиг категории без названных показателей. До 2 баллов — сумма мелких
 * изменений (каждое ниже порога в 2 п. п.). Больше — так сдвигает только смена
 * набора показателей: показатель вошел в расчет или выпал из него.
 */
const SUBS_SET_STEP = 2;

/** Пояснение к категории без разбивки по подметрикам: данные появились, пропали или показатели не названы. */
export function categoryNote(c: ScoreCategoryChange): string | null {
  const zeroIssues = c.key === "issues" && c.to !== null && roundScore(c.to) === 0;
  if (c.kind === "appeared") return `появились данные – ${zeroIssues ? issuesZero(c) : `категория учтена в оценке с баллом ${roundScore(c.to ?? 0)}`}`;
  if (c.kind === "gone") return "данных больше нет – категория не учитывается в оценке";
  if (c.subs.length > 0) return null;
  if (zeroIssues) return issuesZero(c);
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

type Sub = ScoreCategoryChange["subs"][number];

/** «1 из 3 дней» → «в один день»: поправка по дням бывает только при 1 или 2 днях. */
const DAYS_WORDS: Record<number, string> = { 1: "в один день", 2: "в два разных дня" };

/**
 * Поправка балла словами — по сырым полям поправки (`was`/`now`): выборка
 * задач, объем кода, уровень потолка; null — поправки нет. Фраза говорит, что
 * сейчас с выборкой или потолком, а не только «лучше/хуже»: поправка
 * появляется и без смены объема кода (когда балл поднялся выше середины шкалы).
 */
function adjustmentPhrase(kind: string, s: Sub): string | null {
  const a = s.was?.adjustment ?? null;
  const b = s.now?.adjustment ?? null;
  if (kind === "small-code") {
    if (b === null) return "кода достаточно для надежной оценки";
    if (a !== null && a.loc !== undefined && b.loc !== undefined && a.loc !== b.loc) return b.loc > a.loc ? "кода стало больше" : "кода стало меньше";
    return "кода мало для надежной оценки";
  }
  if (kind === "small-sample") {
    if (b === null) return "закрытых задач достаточно для надежной оценки";
    if (b.days !== undefined) return `задачи закрывали только ${DAYS_WORDS[b.days] ?? "в немногие дни"}`;
    if (b.n === 0) return "ни одна задача не закрыта";
    if (a !== null && a.days === undefined && a.n !== undefined && b.n !== undefined && a.n !== b.n) return b.n > a.n ? "закрытых задач стало больше" : "закрытых задач стало меньше";
    return "закрытых задач мало для надежной оценки";
  }
  if (kind === "open-findings-cap") {
    if (b === null) return "открытые находки AppSec больше не ограничивают балл";
    return `открытые ${b.level === "critical" ? "критичные находки AppSec" : "находки AppSec высокой важности"} ограничивают балл`;
  }
  return null;
}

/** Конфигурация CI по признакам ci.yaml (`was`/`now`): нет файла, не разобран, без команд, с командами. */
function ciConfigPhrase(s: Sub): string | null {
  const a = s.was?.ci ?? null;
  const b = s.now?.ci ?? null;
  if (b === null) return null;
  const had = a !== null && a.hasCiYaml;
  if (!b.hasCiYaml) return had ? "больше нет ci.yaml" : null;
  if (b.hasSteps === null) return "ci.yaml не удалось разобрать";
  if (b.hasSteps) return had ? "в ci.yaml появились команды" : "появился ci.yaml с командами";
  return had && a.hasSteps === true ? "в ci.yaml больше нет команд" : had ? null : "появился ci.yaml, но без команд";
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
function readmePresence(s: Sub): boolean | null {
  const a = s.was?.present;
  const b = s.now?.present;
  if (b === false && a !== false) return false;
  if (a === false && b === true) return true;
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

/** Род и число имени во фразе: «вошел», «вошла», «вошло», «вошли». */
type Form = "m" | "f" | "n" | "pl";

/**
 * Показатель, вошедший в расчет или выпавший из него, — имя во фразе «в расчет
 * вошли релизы», «время первого ответа больше не учитывается». Все подметрики
 * с весом из `SUBMETRICS`; справочные (без веса) в изменение не попадают.
 */
const COUNTED_NAMES: Record<string, [name: string, form: Form]> = {
  "documentation.readme": ["README", "m"],
  "documentation.license": ["лицензия", "f"],
  "documentation.contributing": ["CONTRIBUTING", "m"],
  "documentation.codeowners": ["CODEOWNERS", "m"],
  "cicd.config": ["настройка CI", "f"],
  "cicd.pass_rate": ["доля успешных запусков CI", "f"],
  "cicd.duration": ["длительность запусков CI", "f"],
  "security.density": ["плотность находок AppSec", "f"],
  "security.resolved": ["доля закрытых находок AppSec", "f"],
  "security.secrets": ["проверка утечек секретов", "f"],
  "security.deps": ["уязвимые зависимости", "pl"],
  "activity.fresh": ["свежесть последнего коммита", "f"],
  "activity.freq": ["частота коммитов", "f"],
  "activity.contributors": ["число авторов", "n"],
  "activity.pulls_90d": ["предложения изменений", "pl"],
  "activity.releases_12m": ["релизы", "pl"],
  "issues.stale": ["доля зависших задач", "f"],
  "issues.close_days": ["время закрытия задач", "n"],
  "issues.resolution": ["доля решенных задач", "f"],
  "issues.first_resp": ["время первого ответа", "n"],
  "code.density": ["плотность TODO/FIXME", "f"],
  "code.old_share": ["доля старых TODO", "f"],
  "code.tests": ["доля тестов", "f"],
  "code.root": ["порядок в корне репозитория", "m"],
};

const ENTERED_VERB: Record<Form, string> = { m: "вошел", f: "вошла", n: "вошло", pl: "вошли" };

/** «в расчет вошли предложения изменений и релизы»; выпавшие — «время первого ответа больше не учитывается». */
function countedPhrase(names: [string, Form][], entered: boolean): string {
  const many = names.length > 1 || names[0]![1] === "pl";
  const list = listWords(names.map((n) => n[0]));
  if (entered) return `в расчет ${many ? "вошли" : ENTERED_VERB[names[0]![1]]} ${list}`;
  return `${list} больше не ${many ? "учитываются" : "учитывается"}`;
}

/**
 * Вошедший или выпавший показатель со своими словами: задачи начали или
 * перестали вести, проверка AppSec, тесты, ci.yaml. null — общие слова
 * («в расчет вошла доля тестов»).
 */
function countedSpecial(c: ScoreCategoryChange, s: Sub): string | null {
  const entered = s.counted === "entered";
  const key = `${c.key}.${s.key}`;
  if (key === "issues.tracker_unused") return entered ? "задачи больше не ведутся" : "в трекере появились задачи";
  if (key === "security.scan_missing") return entered ? "проверка AppSec не запускалась" : "появилась проверка AppSec";
  if (key === "code.tests") {
    const outside = entered ? s.was?.tests : s.now?.tests;
    if (outside === "none") return entered ? "появились тесты" : "тестов больше нет";
    if (outside === "idle") return entered ? "доля тестов теперь повышает балл" : "доля тестов больше не повышает балл";
    return null;
  }
  if (key === "cicd.config") return ciConfigPhrase(s);
  return null;
}

/** Фраза одного показателя; null — показатель не называем (поправка неизвестного вида). */
function subPhrase(c: ScoreCategoryChange, s: Sub): string | null {
  if (s.key.startsWith("adjustment.")) return adjustmentPhrase(s.key.slice("adjustment.".length), s);
  const special = c.key === "cicd" && s.key === "config" ? ciConfigPhrase(s) : null;
  if (special !== null) return special;
  // релизы засчитываются у живого проекта: число то же, балл от засчета
  if (c.key === "activity" && s.key === "releases_12m" && s.now?.releasesIdle !== s.was?.releasesIdle) {
    return s.now?.releasesIdle === true ? "релизы не засчитаны – за год нет коммитов людей" : "релизы снова засчитаны – появились коммиты людей";
  }
  const words = SUB_WORDS[`${c.key}.${s.key}`];
  if (words !== undefined) return words[s.better ? 0 : 1];
  return `показатель «${s.title.replace(/\s*\(.*\)$/, "")}» ${s.better ? "вырос" : "снизился"}`;
}

/**
 * Почему сдвинулась категория — одна фраза без чисел: «появились лицензия и
 * CONTRIBUTING, README подробнее», «в расчет вошли релизы». null — сказать нечего.
 */
export function categoryPhrase(c: ScoreCategoryChange): string | null {
  const note = categoryNote(c);
  if (c.subs.length === 0) return note;
  const appeared: [string, boolean][] = [];
  const gone: [string, boolean][] = [];
  const entered: [string, Form][] = [];
  const left: [string, Form][] = [];
  // фразы по порядку заметности; группы вошедших и выпавших — на месте первого из них
  const rest: (string | "entered" | "left")[] = [];
  // ни одна задача не закрыта — время закрытия и доля решенных уже сказаны этим
  const noneClosed = c.key === "issues" && (c.tracker === "none-closed" || c.subs.some((s) => s.key === "adjustment.small-sample" && s.now?.adjustment?.n === 0 && s.now.adjustment.days === undefined));
  // задачи начали или перестали вести, проверка AppSec появилась или пропала —
  // остальные вошедшие и выпавшие показатели сказаны этим
  const anchor = c.subs.find((s) => s.counted !== undefined && (s.key === "tracker_unused" || s.key === "scan_missing"));
  for (const s of c.subs) {
    const presence = PRESENCE[s.key];
    const readme = c.key === "documentation" && s.key === "readme" ? readmePresence(s) : null;
    if (presence !== undefined && c.key === "documentation") (s.better ? appeared : gone).push(presence);
    else if (readme !== null) (readme ? appeared : gone).push(["README", false]);
    else if (noneClosed && !s.better && (s.key === "close_days" || s.key === "resolution")) continue;
    else if (anchor !== undefined && s !== anchor && (s.counted !== undefined || (anchor.counted === "entered" && s.key.startsWith("adjustment.")))) continue;
    else if (s.counted !== undefined) {
      const special = countedSpecial(c, s);
      const name = COUNTED_NAMES[`${c.key}.${s.key}`] ?? [subInline(s.title), "m"];
      if (special !== null) rest.push(special);
      else if (c.key === "cicd" && s.key === "config") continue;
      else {
        const group = s.counted === "entered" ? entered : left;
        if (group.length === 0) rest.push(s.counted);
        group.push(name);
      }
    } else {
      const phrase = subPhrase(c, s);
      if (phrase !== null) rest.push(phrase);
    }
  }
  const parts = [
    ...(appeared.length > 0 ? [presencePhrase(appeared, true)] : []),
    ...(gone.length > 0 ? [presencePhrase(gone, false)] : []),
    ...rest.map((p) => (p === "entered" ? countedPhrase(entered, true) : p === "left" ? countedPhrase(left, false) : p)),
  ];
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
  // индекс не сдвинулся, а Repo Health Score — да: объясняем вклады полного показателя
  // (иначе у треугольника ▼1 рядом с Repo Health Score не было бы причины)
  const d = pointDeltas(point, fullOpen);
  const byFull = d.index === 0 && d.full !== null && d.full !== 0;
  const parts = c.categories.flatMap((cat) => {
    // категория индекса — вклад в индекс; CI/CD и Безопасность — в Repo Health Score
    const toFull = byFull || cat.index === null;
    const value = toFull ? cat.full : cat.index;
    if (value === null || value === 0) return [];
    const head = `${categoryTitle(cat.key)} ${fmtDelta(value)}${toFull ? " к Repo Health Score" : ""}`;
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
 * Пара по умолчанию — «почему оценка сейчас такая»: до последнего анализа от конца
 * последнего дня, когда оценка была другой. Конец просто предыдущего дня не годится:
 * оценка могла уйти и вернуться (67 → 64 → 67), и пара показала бы «67 → 67». Если
 * такого дня нет (оценка менялась только внутри первого дня) — от анализа прямо
 * перед последним изменением; поле дня покажет его (`pinDays`). null — оценка не
 * менялась ни разу или день всего один.
 */
export function defaultPair(points: HistoryPoint[], fullOpen: boolean): { from: number; to: number } | null {
  const changed = lastChange(points, false) ?? lastChange(points, fullOpen);
  const days = dayOptions(points);
  if (changed === null || changed.change === null || days.length < 2) return null;
  const metric = defaultMetric(points, fullOpen);
  const shownOf = (scanId: number): number | null => {
    const p = points.find((x) => x.scanId === scanId);
    const v = metric === "full" ? p?.repoHealthScore : p?.healthcraftIndex;
    return v === null || v === undefined ? null : roundScore(v);
  };
  const to = days[days.length - 1]!.scanId;
  const now = shownOf(to);
  for (let i = days.length - 2; i >= 0; i--) {
    const v = shownOf(days[i]!.scanId);
    if (v !== null && v !== now) return { from: days[i]!.scanId, to };
  }
  return changed.change.fromScanId === to ? null : { from: changed.change.fromScanId, to };
}

/**
 * Показатель, на котором панель открывается: индекс, а зрителю с правами —
 * Repo Health Score, если индекс не менялся ни разу (иначе панель открылась бы
 * пустой «46 → 46»).
 */
export function defaultMetric(points: HistoryPoint[], fullOpen: boolean): BridgeMetric {
  return fullOpen && lastChange(points, false) === null ? "full" : "index";
}

/**
 * Дни для полей выбора с выбранными анализами на месте своего дня: пара по
 * умолчанию может начинаться не с конца дня, а новый анализ сегодня сдвигает
 * «конец дня» — без подмены выбранного значения не было бы в списке, и поле
 * опустело бы.
 */
export function pinDays(points: HistoryPoint[], pinned: number[]): DayOption[] {
  const dayOf = (scanId: number): string | null => {
    const p = points.find((x) => x.scanId === scanId);
    return p?.finishedAt ? fmtDate(p.finishedAt) : null;
  };
  const pins = new Map(pinned.flatMap((id) => (dayOf(id) === null ? [] : [[dayOf(id)!, id] as const])));
  return dayOptions(points).map((d) => (pins.has(d.day) ? { ...d, scanId: pins.get(d.day)! } : d));
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
