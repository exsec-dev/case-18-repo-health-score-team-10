// AI-блоки и история на карточке репозитория: признаки накрутки в подвале плашки
// HealthCraft Index, AI-обзор, AI-разбор в категориях, история оценки и бейдж для README.
// `card.ai` приходит только зрителю с правами на полный Score; без прав этих блоков нет вовсе.
import { ArrowRight, ArrowUpArrowDown, ArrowsRotateRight, Check, ChevronDown, CircleExclamation, ClockArrowRotateLeft, Flag, SealCheck, Shield, ShieldCheck, SparklesFill, TriangleDownFill, TriangleUpFill } from "@gravity-ui/icons";
import {
  ActionTooltip,
  Alert,
  Button,
  Card,
  ClipboardButton,
  Dialog,
  Disclosure,
  Flex,
  HelpMark,
  Icon,
  Label,
  Popover,
  SegmentedRadioGroup,
  Select,
  Skeleton,
  Spin,
  Text,
  TextInput,
  useToaster,
} from "@gravity-ui/uikit";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { RepoCard } from "./api";
import { dataOf, fetchJson, useJson, useLatest, useVisible } from "./api";
import { Collapse, TIP_TARGET } from "./ui";
import { scrollBehavior } from "./prefs";
import { plural } from "../report/submetrics";
import {
  AI_SECTION_TITLE,
  CHECK_EXPLAIN,
  FRAUD_EXPLAIN,
  FRAUD_TITLE,
  aiModelName,
  aiNotesStale,
  aiParagraphs,
  aiRoleTitle,
  fmtDate,
  fmtDateTime,
  fmtTime,
  jobErrorText,
  fmtScore,
  fraudFactorFact,
  fraudFactorValue,
  fraudNoteText,
  fraudCheckStale,
  fraudStaleText,
  AI_NOTE_SHORT, AI_OVERVIEW_REJECTED,
  quotaBlockedText,
  scoreTheme,
  quotaCounter,
  counterText,
  withCounter,
  errorText,
  type AiQuotaView,
  type QuotaCounter,
} from "./format";
import { announceJobStarted, announceJobsChanged, useAnalysisFinished, useSession } from "./session";
import { bridgeOf, categoryDetails, categoryPhrase, categoryTitle, changeLine, defaultMetric, defaultPair, pinDays, fmtDelta, pointDeltas, specialText, type Bridge, type BridgeMetric } from "./scoreChangeView";
import { BADGE_CHIPS, SLOT_EMPTY, aiNotesCaption, badgeCode, historyByTime, historyDomain, scoreHistoryView, type BadgeChip, type BadgeFormat } from "./slots";
import type { AiNoteHistoryItem, AiNotesResponse, HistoryPoint, HistoryResponse, ScoreChange } from "../summary/history-contract";
import { evolutionTooEarly } from "../summary/history-contract";

type Card = RepoCard;
type CardAi = NonNullable<Card["ai"]>;
type AiNote = NonNullable<CardAi["overview"]>;

const apiBase = (org: string, repo: string): string => `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;

// ---------- общая метка модели ----------

/** Метка модели — одна форма на всех экранах: официальное имя на серой плашке, без иконки. */
export function AiModelLabel({ model }: { model: string }) {
  return (
    <Label theme="unknown" size="xs">
      {aiModelName(model)}
    </Label>
  );
}

/** Абзацы текста модели – та же разбивка, что в отчете. */
function AiText({ text }: { text: string }) {
  return (
    <>
      {aiParagraphs(text).map((p, i) => (
        <Text key={i} as="p" variant="body-1" color="complementary">
          {p}
        </Text>
      ))}
    </>
  );
}

// ---------- открытие категории по ссылке (фрод → «Активность», обзор → категории) ----------

export const OPEN_CATEGORY_EVENT = "rh:open-category";
export const categoryAnchor = (key: string): string => `rh-category-${key}`;

export function openCategory(key: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_CATEGORY_EVENT, { detail: key }));
  requestAnimationFrame(() => document.getElementById(categoryAnchor(key))?.scrollIntoView({ block: "center", behavior: scrollBehavior() }));
}

// ---------- флаг накрутки ----------

// ---------- AI-обзор ----------

/** Причина конвейера «нет фактов категории» — не ошибка: у категории нет данных, модели нечего пояснять. */
function isNoFacts(reason: string): boolean {
  return reason.startsWith("нет фактов");
}

/** Период опроса статуса AI-заявок, мс. */
const AI_STATUS_POLL_MS = 15_000;

/**
 * Один опрос на обе AI-заявки (обзор и проверка): пока `active`, раз в 15 с
 * читается легкий `/ai-status` (без прав и без лимита карточки); как только
 * обе заявки неактивны – один вызов onDone, и карточка перечитывается.
 * Следующий запрос – после ответа, в скрытой вкладке опрос стоит; сетевая
 * ошибка не останавливает опрос.
 */
function useAiJobPolling(org: string, repo: string, active: boolean, onDone: () => void): void {
  const visible = useVisible();
  const done = useLatest(onDone);
  useEffect(() => {
    if (!active || !visible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const st = await fetchJson<{ summaryActive: boolean; checkActive: boolean }>(`${apiBase(org, repo)}/ai-status`);
        if (stopped) return;
        if (!st.summaryActive && !st.checkActive) {
          done.current();
          return;
        }
      } catch {
        // сеть или 429 – просто следующий тик
      }
      if (!stopped) timer = setTimeout(() => void tick(), AI_STATUS_POLL_MS);
    };
    timer = setTimeout(() => void tick(), AI_STATUS_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [org, repo, active, visible, done]);
}

/** Длинный текст: затухание после ~6 строк и кнопка «Показать полностью». */
function Collapsible({ children, resetKey }: { children: React.ReactNode; resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // полная высота текста — цель анимации раскрытия (max-height до нее)
  const [full, setFull] = useState(0);
  useEffect(() => setOpen(false), [resetKey]);
  // Полная высота (scrollHeight не зависит от max-height) сравнивается с лимитом
  // 6 строк; хвост до полутора строк показывается целиком — иначе затухание гасило бы
  // последнюю строку без кнопки «Показать полностью»
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = (): void => {
      const line = parseFloat(getComputedStyle(el).getPropertyValue("--g-text-body-1-line-height")) || 18;
      setOverflows(el.scrollHeight > line * 7.5);
      setFull(el.scrollHeight);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    // абзацы — тоже: у раскрытого высота ограничена max-height, и рост текста
    // при сужении окна сам блок не меняет
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [resetKey]);
  const clamped = overflows && !open;
  return (
    <Flex direction="column" gap={1} alignItems="flex-start">
      <div
        ref={ref}
        className={`rh-ai-text${overflows ? " rh-ai-text_fold" : ""}${clamped ? " rh-ai-text_clamped" : ""}`}
        style={overflows ? ({ "--rh-ai-full": `${full}px` } as React.CSSProperties) : undefined}
      >
        {children}
      </div>
      {overflows && (
        // без полей — начало строки совпадает с абзацем
        <button type="button" className="rh-ai-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Свернуть" : "Показать полностью"}
          <Icon data={ChevronDown} size={14} style={open ? { transform: "rotate(180deg)" } : undefined} />
        </button>
      )}
    </Flex>
  );
}

/**
 * Тост отказа: исчерпанный лимит — штатное состояние, поэтому желтый «Лимит исчерпан»
 * с текстом сервера и временем; красным — только настоящие сбои.
 */
function refusalToast(error: { code?: string; message?: string; until?: string } | undefined, status: number, failTitle: string): { theme: "warning" | "danger"; title: string; content: string } {
  const message = errorText({ status, code: error?.code ?? null, message: error?.message ?? null });
  if (error?.code?.startsWith("quota_")) {
    const tail = error.code === "quota_hour" && error.until ? `. Следующий запуск – после ${fmtDateTime(error.until)}` : "";
    return { theme: "warning", title: "Лимит исчерпан", content: `${message}${tail}` };
  }
  // «недавно формировался» — пауза, а не сбой: желтым и со временем следующего запуска
  if (error?.code === "cooldown") {
    const when = error.until ? `Следующий запуск – после ${fmtDateTime(error.until)}.` : "Следующий запуск будет доступен позже.";
    return { theme: "warning", title: "AI-обзор недавно формировался", content: when };
  }
  return { theme: "danger", title: failTitle, content: message };
}

/**
 * Остаток лимитов AI зрителя: один запрос на карточку и только для вошедшего
 * (аноним не шлет запрос — 401 в консоли не нужен). `reload` — после постановки
 * заявки и по итогу задания.
 */
export function useAiQuota(loggedIn: boolean): { quota: AiQuotaView | null; reload: () => void } {
  const [quota, setQuota] = useState<AiQuotaView | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!loggedIn) {
      setQuota(null);
      return;
    }
    const ctrl = new AbortController();
    fetch("/api/me/ai-quota", { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<AiQuotaView>) : null))
      .then((q) => setQuota(q))
      .catch(() => {});
    return () => ctrl.abort();
  }, [loggedIn, tick]);
  useAnalysisFinished(() => setTick((t) => t + 1));
  return { quota, reload: () => setTick((t) => t + 1) };
}

function useSummaryActions(org: string, repo: string, onChanged: () => void) {
  const toaster = useToaster();
  const [sending, setSending] = useState(false);
  const start = async (): Promise<void> => {
    setSending(true);
    try {
      const res = await fetch(`${apiBase(org, repo)}/summary`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { jobId?: number | null; cached?: boolean; scanQueued?: boolean; error?: { code?: string; message?: string; until?: string } } | null;
      if (!res.ok) {
        toaster.add({ name: `summary-fail:${org}/${repo}`, ...refusalToast(body?.error, res.status, "Обзор не запущен") });
        return;
      }
      // объявленное задание получит тост об итоге, даже если опрос застанет его уже завершенным
      const cached = body?.cached === true;
      const scanQueued = body?.scanQueued === true;
      announceJobStarted(body?.jobId ?? undefined);
      if (!cached) announceJobsChanged();
      onChanged();
      toaster.add({
        name: `summary-ok:${org}/${repo}`,
        theme: "success",
        title: cached ? "Обзор этого анализа уже готов" : scanQueued ? "Анализ и обзор в очереди" : "Обзор формируется",
        content: cached
          ? "Новый обзор появится после нового анализа репозитория."
          : scanQueued
            ? "Сначала соберутся свежие данные, затем обзор обновится."
            : "Обзор появится здесь после проверки фактами.",
      });
    } catch {
      toaster.add({ name: `summary-fail:${org}/${repo}`, theme: "danger", title: "Обзор не запущен", content: "Сервер не ответил – проверьте соединение и попробуйте еще раз." });
    } finally {
      setSending(false);
    }
  };
  return { sending, start };
}

/**
 * Подпись под скелетоном обзора по фазе. «Обновить обзор» у владельца — сначала
 * анализ, потом текст; подпись говорит, какой из двух шагов идет сейчас.
 */
export function aiProgressText(analysisRunning: boolean, ownFullCycle: boolean): string {
  if (analysisRunning) return "Идет анализ – затем обзор обновится сам.";
  if (ownFullCycle) return "Анализ готов, обзор дописывается – раздел обновится сам.";
  return "Обзор формируется – раздел обновится сам.";
}

/** «Проверить активность»: постановка проверки на искусственную активность. */
function useCheckAction(org: string, repo: string, onChanged: () => void) {
  const toaster = useToaster();
  const [sending, setSending] = useState(false);
  const start = async (): Promise<void> => {
    setSending(true);
    try {
      const res = await fetch(`${apiBase(org, repo)}/check`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { jobId?: number | null; cached?: boolean; error?: { code?: string; message?: string; until?: string } } | null;
      if (!res.ok) {
        toaster.add({ name: `check-fail:${org}/${repo}`, ...refusalToast(body?.error, res.status, "Проверка не запущена") });
        return;
      }
      announceJobStarted(body?.jobId ?? undefined);
      if (body?.cached !== true) announceJobsChanged();
      onChanged();
      toaster.add({
        name: `check-ok:${org}/${repo}`,
        theme: "success",
        title: body?.cached === true ? "Этот анализ уже проверен" : "Проверка запущена",
        content: body?.cached === true ? "Результат – в карточке. Новая проверка станет доступна после нового анализа." : "Результат появится в карточке через несколько секунд.",
      });
    } catch {
      toaster.add({ name: `check-fail:${org}/${repo}`, theme: "danger", title: "Проверка не запущена", content: "Сервер не ответил – проверьте соединение и попробуйте еще раз." });
    } finally {
      setSending(false);
    }
  };
  return { sending, start };
}

/** Состояние проверки оценки для плашки: вид (иконка и тексты — `checkCardText`), дата, кнопка. */
export interface FraudCheckState {
  kind: "none" | "active" | "clean" | "flagged" | "failed" | "nothing" | "stale";
  date: string | null;
  button: "Проверить активность" | "Повторить проверку" | null;
}

/**
 * 7 состояний проверки оценки. Имя действия везде одно — «проверка оценки»;
 * «нет истории коммитов» — факт, а не сбой; флаг прошлого анализа несет желтая
 * плашка подвала с пометкой «по прошлому анализу».
 */
export function fraudCheckState(ai: CardAi, loggedIn: boolean): FraudCheckState {
  const { check, fraud } = ai;
  const stale = fraudCheckStale(check);
  const date = check.checkedAt ? fmtDateTime(check.checkedAt) : null;
  if (check.active) return { kind: "active", date: null, button: null };
  if (check.failure !== null && !check.retryable) return { kind: "nothing", date: null, button: null };
  const run = loggedIn && check.latestScanId !== null;
  if (check.failure !== null) {
    return {
      kind: "failed",
      date: null,
      button: run ? "Повторить проверку" : null,
    };
  }
  // при флаге подвал показывает сами признаки (FraudFlagMessage), здесь — только статус
  if (fraud !== null && fraud.flag) return { kind: "flagged", date, button: run && stale ? "Проверить активность" : null };
  if (fraud !== null && stale) return { kind: "stale", date, button: run ? "Проверить активность" : null };
  if (fraud !== null) return { kind: "clean", date, button: null };
  return {
    kind: "none",
    date: null,
    button: run ? "Проверить активность" : null,
  };
}

const CHECK_ICON: Record<FraudCheckState["kind"], { data: typeof Shield; color: string } | null> = {
  none: { data: Shield, color: "var(--g-color-text-secondary)" },
  active: null,
  clean: { data: ShieldCheck, color: "var(--g-color-text-positive)" },
  // флажок — тот же знак, что у строки рейтинга
  flagged: { data: Flag, color: "var(--g-color-text-warning)" },
  failed: { data: CircleExclamation, color: "var(--g-color-text-secondary)" },
  nothing: { data: Shield, color: "var(--g-color-text-secondary)" },
  stale: { data: ClockArrowRotateLeft, color: "var(--g-color-text-secondary)" },
};

/**
 * Тексты плашки проверки (вариант A1, 19.10.2026): статус крупно, внизу – только
 * кнопка, «устарела» или пояснение. Дата проверки – в подсказке у знака вопроса
 * вместе с тем, что такое проверка; почему устарела – в подсказке у «устарела».
 * `reason` – причина сбоя отдельной строкой: она длинная и бывает редко.
 */
export function checkCardText(st: FraudCheckState, ai: CardAi, loggedIn: boolean): { title: string; meta: string | null; reason: string | null } {
  switch (st.kind) {
    case "none":
      return { title: "Не проверялась", meta: loggedIn ? null : "Запускает вошедший пользователь", reason: null };
    case "active":
      return { title: "Идет проверка", meta: null, reason: null };
    case "clean":
      return { title: "Признаков искусственной активности нет", meta: null, reason: null };
    case "stale":
      return { title: "Признаки не были обнаружены", meta: null, reason: null };
    case "flagged":
      return { title: FRAUD_TITLE, meta: null, reason: null };
    case "failed":
      return { title: "Не сформировалась", meta: null, reason: loggedIn && ai.check.failure !== null ? sentenceOf(jobErrorText(ai.check.failure)) : null };
    case "nothing":
      return { title: "Проверять нечего", meta: "В анализе нет истории коммитов", reason: null };
  }
}

/**
 * Статус под оценками, где подписи «Проверка активности» нет: короткое «Не
 * проверялась» без нее непонятно, поэтому — полной фразой. Флаг и так полный.
 */
const CHECK_WIDE_TITLE: Partial<Record<FraudCheckState["kind"], string>> = {
  none: "Активность не проверялась",
  active: "Идет проверка активности",
  clean: "Признаков искусственной активности нет",
  stale: "Признаков искусственной активности не было",
  failed: "Проверка активности не сформировалась",
  nothing: "Проверять активность нечего",
};

/** Подпись кнопки: о какой проверке речь, говорят подпись или статус; полное имя – в aria-label. */
const CHECK_BUTTON_TEXT: Record<NonNullable<FraudCheckState["button"]>, string> = {
  "Проверить активность": "Проверить",
  "Повторить проверку": "Повторить",
};

function sentenceOf(text: string): string {
  const t = text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Признаки накрутки строками — один фактор проверки, одна строка (как пункт MD-отчета):
 * перечень чисел после «; » — пояснение того же фактора, а не второй признак. Текст строит
 * код из факта, формулировка модели — запасной вариант, без маркеров фактов и машинных
 * ключей (`fraudNoteText`).
 */
function fraudLines(card: Card): string[] {
  const fraud = card.ai?.fraud;
  if (fraud === undefined || fraud === null || fraud.flag !== true) return [];
  const factOf = (key: string): unknown => fraudFactorValue(key, fraud.signals, card.evidence, fraud.inputs);
  return fraud.factors
    .map((f) => fraudFactorFact(f.key, factOf(f.key)) ?? fraudNoteText(f.note))
    .filter((l) => l !== "")
    // с заглавной — только русская фраза: неизвестный ключ остается как есть
    .map((l) => (/^[а-яё]/.test(l) ? l[0]!.toUpperCase() + l.slice(1) : l));
}

/**
 * Плашка «Проверка активности» (вариант 1, 19.10.2026) – как плашка оценки: подпись
 * со знаком вопроса сверху, статус значком и словами крупно, внизу кнопка.
 * У чужого репозитория стоит на месте закрытого Repo Health Score и тянется на высоту
 * HealthCraft Index (низ – на уровне полосы вклада). У своего – полосой на всю ширину
 * под плашками оценок: без подписи, статус полной фразой и тише, знак вопроса после
 * него, признаки свернуты; кнопка или «устарела» справа у нижнего края. Без подложки
 * (вариант A1, 19.10.2026): найденные признаки несут желтый флажок и список вторичным
 * цветом, дата проверки – в подсказке у знака вопроса. Статус меняется опросом, поэтому
 * `aria-live`; причина неактивной кнопки и причина сбоя – подписью внизу.
 */
export function ActivityCheckCard({
  card,
  org,
  repo,
  onChanged,
  loggedIn,
  quota,
  onQuota,
  signIn,
  wide = false,
}: {
  card: Card;
  org: string;
  repo: string;
  onChanged: () => void;
  loggedIn: boolean;
  quota: AiQuotaView | null;
  onQuota: () => void;
  /** кнопка входа для гостя */
  signIn?: ReactNode;
  /** на всю ширину под плашками оценок */
  wide?: boolean;
}) {
  const ai = card.ai;
  const action = useCheckAction(org, repo, () => {
    onChanged();
    onQuota();
  });
  // под оценками признаки свернуты (вариант A, 19.10.2026): полоса не растет по высоте
  const [signsOpen, setSignsOpen] = useState(false);
  // опрос живой проверки – общий с обзором (useAiJobPolling в AiOverviewSection)
  if (ai === undefined || ai === null) return null;
  const st = fraudCheckState(ai, loggedIn);
  const { title, meta, reason } = checkCardText(st, ai, loggedIn);
  const counter = quotaCounter(quota?.check);
  const blocked = counter !== null && counter.left === 0 && quota !== null ? quotaBlockedText("check", quota.check, counter) : null;
  const icon = CHECK_ICON[st.kind];
  const flagged = st.kind === "flagged";
  const lines = flagged ? fraudLines(card) : [];
  const action_ =
    st.button !== null ? (
      <Button view="outlined" size="m" loading={action.sending} disabled={blocked !== null} onClick={() => void action.start()} aria-label={withCounter(st.button, counter)}>
        <CountedLabel label={CHECK_BUTTON_TEXT[st.button]} counter={counter} />
      </Button>
    ) : !loggedIn && st.kind === "none" && signIn !== undefined ? (
      signIn
    ) : null;
  const why = [reason, st.button !== null ? blocked : null].filter((t): t is string => t !== null);
  const foldSigns = wide && lines.length > 0;
  const stale = st.kind === "stale" || (flagged && fraudCheckStale(ai.check));
  const help = (
    <HelpMark iconSize="s" aria-label="Что такое проверка активности">
      {flagged ? FRAUD_EXPLAIN : CHECK_EXPLAIN}
      {st.date !== null && <span className="rh-check-help__date">{`Проверка от ${st.date}.`}</span>}
    </HelpMark>
  );
  // метка того же вида, что «Устарел» у AI-обзора; почему устарела – в подсказке
  const staleMark = stale ? (
    <ActionTooltip title="Проверка устарела" description={fraudStaleText(ai.check, st.date)}>
      <span className="rh-ai-stale" {...TIP_TARGET}>
        <Label theme="unknown" size="xs">
          Устарело
        </Label>
      </span>
    </ActionTooltip>
  ) : null;
  const signsId = `rh-check-signs-${org}-${repo}`;
  const list = lines.length > 0 && (
    <ul className="rh-check-card__list" id={foldSigns ? undefined : signsId}>
      {lines.map((l) => (
        <li key={l}>
          <Text color="secondary">{l}</Text>
        </li>
      ))}
    </ul>
  );
  const cls = ["rh-score-band", "rh-check-card", wide ? "rh-check-card_wide" : ""].filter(Boolean).join(" ");
  return (
    <Card view="outlined" className={cls}>
      <div className="rh-check-card__main" aria-live="polite">
        {/* под оценками подписи сверху нет — статус говорит сам за себя, (?) — сразу после него */}
        {!wide && (
          <Flex gap={1} alignItems="center">
            <Text color="secondary">Проверка активности</Text>
            {help}
          </Flex>
        )}
        <Flex gap={2} alignItems="center" wrap className="rh-check-card__status">
          {/* значок и статус не разрываются: длинный статус переносится внутри, значок — по первой строке */}
          <span className="rh-check-card__head">
            <span className="rh-check-card__icon">{icon === null ? <Spin size="xs" /> : <Icon data={icon.data} size={16} style={{ color: icon.color }} />}</span>
            {/* под оценками статус тише: 13px, средняя жирность — главные там цифры оценок */}
            <Text variant={wide ? "subheader-1" : "subheader-2"}>{wide ? CHECK_WIDE_TITLE[st.kind] ?? title : title}</Text>
          </span>
          {wide && help}
          {foldSigns && (
            <button type="button" className="rh-check-card__toggle" aria-expanded={signsOpen} aria-controls={signsId} onClick={() => setSignsOpen((o) => !o)}>
              {`${lines.length} ${plural(lines.length, "признак", "признака", "признаков")}`}
              <Icon data={ChevronDown} size={14} className={signsOpen ? "rh-check-card__chev rh-check-card__chev_open" : "rh-check-card__chev"} />
            </button>
          )}
        </Flex>
        {foldSigns ? (
          <Collapse open={signsOpen} id={signsId}>
            {list}
          </Collapse>
        ) : (
          list
        )}
      </div>
      {(action_ !== null || staleMark !== null || meta !== null || why.length > 0) && (
        <div className="rh-check-card__foot">
          {action_}
          {staleMark}
          {meta !== null && <Text color="secondary">{meta}</Text>}
          {why.map((t) => (
            <Text key={t} variant="caption-2" color="secondary" as="p" className="rh-check-foot__why">
              {t}
            </Text>
          ))}
        </div>
      )}
    </Card>
  );
}

export function AiOverviewSection({ card, org, repo, onChanged, loggedIn, quota, onQuota }: { card: Card; org: string; repo: string; onChanged: () => void; loggedIn: boolean; quota: AiQuotaView | null; onQuota: () => void }) {
  const ai = card.ai;
  const own = card.viewer?.own === true;
  // обзор публичного репо запускает любой вошедший, закрытого — только владелец
  const canRun = loggedIn && (own || card.repo.visibility === "public");
  const publicVersion = ai?.audience === "public";
  const actions = useSummaryActions(org, repo, () => {
    onChanged();
    onQuota();
  });
  // остаток — в тексте кнопки; при нуле кнопка неактивна, причина видна подписью
  const counter = quotaCounter(quota?.overview);
  const quotaBlocked = counter !== null && counter.left === 0 && quota !== null ? quotaBlockedText("overview", quota.overview, counter) : null;

  // Пока идет обзор или проверка, опрашивается легкий статус заявок (не карточка):
  // карточка перечитывается один раз, когда заявка закончилась
  useAiJobPolling(org, repo, ai !== undefined && ai !== null && (ai.jobActive || ai.check.active), onChanged);
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => j.slug === `${org}/${repo}`)) onChanged();
  });

  // без прав на полный Score текста нет — и раздела нет
  if (ai === undefined) return null;

  // обзора нет и он не формируется — заглушка в духе закрытого Repo Health Score
  // (рамка без заливки, заголовок-состояние, одно основное действие)
  const empty = ai === null || (ai.overview === null && ai.specialists.length === 0 && !ai.jobActive);
  if (empty) {
    const cooldown = ai?.cooldownUntil != null && Date.parse(ai.cooldownUntil) > Date.now();
    return (
      <section className="rh-ai-section rh-ai-section_empty" aria-labelledby="rh-ai-title" data-slot="aiSummary">
        <Flex direction="column" gap={1} alignItems="flex-start">
          {/* заголовок раздела — тот же, что у заполненного (17px); состояние — строкой ниже */}
          <Text variant="subheader-3" id="rh-ai-title" as="h2">
            {AI_SECTION_TITLE}
          </Text>
          {/* отказы проверки фактами API отдает только по анализу с заметками
              (buildCardAi в api/repos.ts), а такой анализ пустым не бывает: если
              не прошел ни один блок, итог виден в «Очереди» текстом заявки
              (AI_REJECTED_ERRORS), здесь – «пока нет» */}
          <Text variant="subheader-2">Обзора пока нет</Text>
          <Text variant="body-1" color="complementary">
            {canRun
              ? publicVersion
                ? "Модель коротко перескажет оценку по 4 открытым категориям. На оценку не влияет."
                : "Модель коротко перескажет оценку и разберет каждую категорию. На оценку не влияет."
              : card.repo.visibility === "public"
                ? "Обзор может сформировать любой вошедший пользователь. На оценку не влияет."
                : "Обзор запускает владелец репозитория. На оценку не влияет."}
          </Text>
          {canRun && (
            <div className="rh-score-band__signin">
              <Button view="action" size="m" loading={actions.sending} disabled={cooldown || quotaBlocked !== null} onClick={() => void actions.start()} aria-label={withCounter("Сформировать обзор", counter)}>
                <Button.Icon side="start">
                  <Icon data={SparklesFill} size={16} className="rh-ai-button-icon" />
                </Button.Icon>
                <CountedLabel label="Сформировать обзор" counter={counter} />
              </Button>
            </div>
          )}
          {canRun && (cooldown || quotaBlocked !== null) && (
            <Text variant="caption-2" color="secondary">
              {quotaBlocked ?? `Следующий запуск – после ${fmtDateTime(ai!.cooldownUntil)}`}
            </Text>
          )}
        </Flex>
      </section>
    );
  }

  const specialists = (ai?.specialists ?? []).filter((n) => n.role !== "trajectory");
  const model = ai?.overview?.model ?? ai?.specialists[0]?.model ?? null;
  const cooldownActive = ai?.cooldownUntil != null && Date.parse(ai.cooldownUntil) > Date.now();
  const jobActive = ai?.jobActive === true;
  const hasOverview = ai?.overview != null;
  const failures = (ai?.failures ?? []).filter((f) => f.role !== "trajectory" && !isNoFacts(f.reason));

  // Не-владельцу кнопка обновления нужна, только если после обзора был новый анализ,
  // иначе запуск вхолостую ответит «уже готов»
  const newerAnalysis = aiNotesStale(ai);
  // иконка обновления с подсказкой; у выключенной причина — в подсказке на обертке
  const runText = withCounter(hasOverview ? "Обновить обзор" : "Сформировать обзор", counter);
  const runDisabled = jobActive || cooldownActive || actions.sending || quotaBlocked !== null;
  const runReason = jobActive
    ? "Обзор уже формируется"
    : cooldownActive
      ? `Следующий запуск – после ${fmtDateTime(ai!.cooldownUntil)}`
      : quotaBlocked ?? runText;
  const runButton = (
    <Button view="flat-secondary" size="m" aria-label={runText} loading={actions.sending} disabled={runDisabled} onClick={() => void actions.start()}>
      <Icon data={ArrowsRotateRight} size={18} />
    </Button>
  );
  const ownerActions = canRun && ai !== null && (own || newerAnalysis) && (
    <Flex gap={2} alignItems="center" className="rh-ai-section__actions">
      {/* «Следующий запуск – после …» чуть длиннее 280px: перенос оставлял справа пустое поле — одной строкой */}
      <ActionTooltip title={runDisabled ? runReason : runText} className={runDisabled && cooldownActive && !jobActive ? "rh-tip-oneline" : undefined}>{runDisabled ? <span className="rh-disabled-tip" tabIndex={0} aria-label={`${runText}: ${runReason}`}>{runButton}</span> : runButton}</ActionTooltip>
    </Flex>
  );

  const stamp =
    ai !== null && ai.generatedAt !== null && !jobActive ? (
      <Text variant="caption-2" color="secondary">
        {`Обзор от ${fmtDateTime(ai.generatedAt)}.`}
        {cooldownActive ? ` Следующий запуск – после ${fmtDateTime(ai.cooldownUntil)}.` : ""}
        {canRun && quotaBlocked !== null ? ` ${quotaBlocked}.` : ""}
      </Text>
    ) : null;

  return (
    // рамка градиента движется, только пока обзор формируется
    <section className={jobActive ? "rh-ai-section rh-ai-section_live" : "rh-ai-section"} aria-labelledby="rh-ai-title" aria-busy={jobActive} data-slot="aiSummary">
      <Flex direction="column" gap={3}>
        {/* заголовок и оговорка о модели — одной группой: оговорка прижата к заголовку */}
        <Flex direction="column" gap={1}>
          <Flex gap={2} alignItems="center" wrap className="rh-ai-section__head">
            <span className="rh-ai-section__spark" aria-hidden="true">
              <Icon data={SparklesFill} size={16} />
            </span>
            <Text variant="subheader-3" as="h2" id="rh-ai-title">
              {AI_SECTION_TITLE}
            </Text>
            {/* оговорка о модели — подсказкой у заголовка, а не строкой под ним */}
            <HelpMark iconSize="s" aria-label="Что это за обзор">
              {AI_NOTE_SHORT}
            </HelpMark>
            {hasOverview && newerAnalysis && <AiStaleMark card={card} blockedReason={canRun && runDisabled ? runReason : null} />}
            {model !== null && <AiModelLabel model={model} />}
            {/* объем публичной версии — меткой в заголовке, пояснение в подсказке внутри плашки */}
            {publicVersion && hasOverview && (
              <Label theme="unknown" size="xs" className="rh-open-data">
                <span className="rh-open-data__text">
                  По открытым данным
                  <HelpMark iconSize="s" aria-label="Что значит «по открытым данным»">
                    4 категории: документация, состояние кода, активность, задачи. CI/CD и Безопасность не входят – их видят участники репозитория.
                  </HelpMark>
                </span>
              </Label>
            )}
            <span style={{ flex: 1 }} />
            {ownerActions}
          </Flex>
        </Flex>

        {jobActive ? (
          // без обещания времени: длительность генерации заранее не известна
          <Flex direction="column" gap={2}>
            <Skeleton style={{ height: 18, width: "100%" }} />
            <Skeleton style={{ height: 18, width: "92%" }} />
            <Skeleton style={{ height: 18, width: "60%" }} />
            <Text variant="caption-2" color="secondary">
              {aiProgressText(card.job !== null, own && ai?.audience === "full")}
            </Text>
          </Flex>
        ) : ai === null || (!hasOverview && specialists.length === 0) ? (
          <Text variant="body-1" color="complementary">
            {canRun ? "Обзора пока нет." : card.repo.visibility === "public" ? "Обзора пока нет – его может сформировать любой вошедший пользователь." : "Обзора пока нет – его запускает владелец репозитория."}
          </Text>
        ) : hasOverview ? (
          <Collapsible resetKey={`${ai.scanId}`}>
            <AiText text={ai.overview!.text} />
          </Collapsible>
        ) : (
          <Flex direction="column" gap={1}>
            <Text variant="body-1" color="complementary">
              {AI_OVERVIEW_REJECTED}
            </Text>
          </Flex>
        )}

        {/* строки о непрошедших проверку разборах — до строки с датой: дата закрывает блок */}
        {failures.length > 0 && (
          <Flex direction="column" gap={1}>
            {failures.map((f) => (
              <Text key={f.role} variant="caption-2" color="secondary">
                {`Разбор «${aiRoleTitle(f.role)}»: ${f.reason}.`}
              </Text>
            ))}
          </Flex>
        )}

        {stamp}
      </Flex>
    </section>
  );
}

// ---------- AI-разбор в категории ----------

/**
 * Заметка специалиста для категории; роли совпадают с ключами категорий. В пустом
 * репозитории разборов нет: оценивать нечего, а прежний обзор писался по коду, которого уже нет.
 */
export function categoryAiNote(card: Card, key: string): AiNote | null {
  if (card.markers.codeEmpty) return null;
  return card.ai?.specialists.find((n) => n.role === key) ?? null;
}

/**
 * Отметка-искра в строке категории: AI-разбор есть — откройте категорию.
 * Нет разбора, нет прав (`card.ai` undefined) или у категории нет данных — отметки нет.
 */
export function CategoryAiMark({ card, categoryKey, hasData }: { card: Card; categoryKey: string; hasData: boolean }) {
  if (card.ai === undefined || !hasData || categoryAiNote(card, categoryKey) === null) return null;
  const title = "Есть AI-разбор – откройте категорию";
  // подсказка Gravity вместо title: нативная появлялась через секунду; знак стоит
  // внутри кнопки строки, поэтому сам не фокусируется — имя есть у скринридера
  return (
    <ActionTooltip title={title}>
      <span className="rh-cat-ai__mark rh-cat-ai__mark_ready" aria-label={title} role="img">
        <Icon data={SparklesFill} size={14} />
      </span>
    </ActionTooltip>
  );
}

/** Знак AI-разбора у заголовка «Категории» — разбор есть у каждой категории. */
export function CategoryAiGlyph() {
  const title = "AI-разбор есть у каждой категории – откройте любую";
  return (
    <ActionTooltip title={title}>
      <span className="rh-cat-ai__mark rh-cat-ai__mark_ready" role="img" aria-label={title} tabIndex={0}>
        <Icon data={SparklesFill} size={16} />
      </span>
    </ActionTooltip>
  );
}

/**
 * Знак «текст устарел» у всех AI-плашек — сразу после заголовка: метка «Устарел»
 * того же вида, что метка модели; подробности и призыв обновить — в подсказке.
 */
export function AiStaleMark({ card, blockedReason = null }: { card: Card; blockedReason?: string | null }) {
  // призыв «Обновите» — только тому, кто может запустить (то же правило, что `canRun` раздела обзора)
  const me = dataOf(useSession().me);
  const loggedIn = me !== null && me.login !== null;
  const own = card.viewer?.own === true;
  // запуск сейчас недоступен — причина вместо призыва
  const tail =
    blockedReason !== null
      ? `${blockedReason.replace(/\.$/, "")}.`
      : loggedIn && (own || card.repo.visibility === "public")
      ? "Обновите обзор."
      : card.repo.visibility === "public"
        ? "Обновить может любой вошедший пользователь."
        : "Обновить может владелец репозитория.";
  return (
    <ActionTooltip title="Обзор устарел" description={`Сделан по прошлому анализу – после него был новый, цифры в тексте могут не совпадать с карточкой. ${tail}`}>
      <span className="rh-ai-stale" {...TIP_TARGET}>
        <Label theme="unknown" size="xs">
          Устарел
        </Label>
      </span>
    </ActionTooltip>
  );
}

/** Текст модели в категории и разбор динамики: info-плашка без метки модели (она уже в заголовке обзора). */
export function AiNotePlate({ title, text, staleFor = null }: { title: string; text: string; staleFor?: Card | null }) {
  return (
    <Alert
      theme="info"
      view="filled"
      size="s"
      className="rh-ai-plate"
      icon={<Icon data={SparklesFill} size={16} />}
      title={
        staleFor !== null ? (
          <span className="rh-ai-plate__title">
            {title}
            <AiStaleMark card={staleFor} />
          </span>
        ) : (
          title
        )
      }
      message={
        <div className="rh-ai-plate__text">
          <AiText text={text} />
        </div>
      }
    />
  );
}

export function CategoryAiNote({ note, card }: { note: AiNote; card: Card }) {
  return (
    <div className="rh-cat-ai">
      <AiNotePlate title="AI-разбор категории" text={note.text} staleFor={aiNotesStale(card.ai) ? card : null} />
    </div>
  );
}

/**
 * Подпись кнопки с остатком лимита — как счетчик у кнопок SourceCraft: число
 * вторичным цветом отдельным элементом («Сформировать обзор 2»), расшифровка — в
 * подсказке. Дробь «2/2» читалась как прогресс, «· осталось 2» удлиняла кнопку.
 */
function CountedLabel({ label, counter }: { label: string; counter: QuotaCounter | null }) {
  if (counter === null) return <>{label}</>;
  return (
    <>
      {label}
      {/* имя для скринридера — aria-label кнопки (withCounter): у span без роли он не озвучивается */}
      <span className="rh-btn-count" title={counterText(counter)}>
        {counter.left}
      </span>
    </>
  );
}

// ---------- история оценки и описания по анализам ----------

const CHART_H = 180;
// слева — подписи шкалы, справа — названия линий у их концов
// подписи шкалы стоят от левого края карточки — под текстом заголовка; поле
// слева — по ширине самой длинной подписи и зазор до сетки
const TICK_GAP = 8;
const PAD_T = 20;
const PAD_B = 22;
// ширина символа подписи 11px (латиница, даты) — для места справа и проверки
// столкновений подписей; с запасом, чтобы рамки не касались
const LABEL_CH = 6.6;
// ширина цифры чисел у точек: 12px и последней точки 13px жирным
const NUM_CH = 7.2;
const NUM_CH_LAST = 8.2;
const END_GAP = 8;

/** Цвет линии и точек — зона последней оценки, те же заливки, что у полос. */
const ZONE_FILL: Record<ReturnType<typeof scoreTheme>, string> = {
  success: "var(--g-color-base-positive-medium)",
  warning: "var(--g-color-base-warning-medium)",
  danger: "var(--g-color-base-danger-medium)",
  misc: "var(--g-color-text-secondary)",
};

/** Ширина контейнера графика: viewBox равен реальной ширине — график на всю колонку без искажения точек и подписей. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setWidth(Math.max(240, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Цвет точки HealthCraft Index — ее зона; у пустого репо (0 — «оценивать нечего»,
 * не зона риска) — нейтральный.
 */
function pointColor(p: HistoryPoint): string {
  return p.codeEmpty ? ZONE_FILL.misc : ZONE_FILL[scoreTheme(p.healthcraftIndex)];
}

/** Индекс последнего непустого значения ряда (−1 — пусто). */
function lastIndex(values: (number | null)[]): number {
  return values.reduce<number>((acc, v, i) => (v !== null ? i : acc), -1);
}

/**
 * Точки графика — от первой до последней оценки с числом: анализы без индекса по
 * краям тянули ось за собой (линия занимала треть ширины, у последнего значения
 * не было места для числа). Пропуски внутри ряда остаются разрывом линии.
 */
function chartSpan(points: HistoryPoint[], fullOpen: boolean): HistoryPoint[] {
  const has = (p: HistoryPoint): boolean => p.healthcraftIndex !== null || (fullOpen && p.repoHealthScore !== null);
  const first = points.findIndex(has);
  if (first < 0) return points;
  let last = points.length - 1;
  while (last > first && !has(points[last]!)) last--;
  return points.slice(first, last + 1);
}

function HistoryChart({ points: all, fullOpen }: { points: HistoryPoint[]; fullOpen: boolean }) {
  const [wrapRef, CHART_W] = useWidth();
  const points = chartSpan(all, fullOpen);
  const hci = points.map((p) => p.healthcraftIndex);
  const rhs = fullOpen ? points.map((p) => p.repoHealthScore) : null;
  const hLast = lastIndex(hci);
  const rLast = rhs === null ? -1 : lastIndex(rhs);
  // у конца каждой линии — текущее значение и название линии вместо легенды
  // («69 HealthCraft Index»): справа от последней точки пусто, а над ней число
  // перекрывали скачок линии и сгусток точек последних дней
  const ends = [
    ...(hLast >= 0 ? [{ name: "HealthCraft Index", i: hLast, v: hci[hLast]!, color: "var(--g-color-text-complementary)", valueColor: "var(--g-color-text-primary)" }] : []),
    ...(rhs !== null && rLast >= 0 ? [{ name: "Repo Health Score", i: rLast, v: rhs[rLast]!, color: "var(--g-color-text-secondary)", valueColor: "var(--g-color-text-secondary)" }] : []),
  ];
  // ширина подписи конца: число жирным, пробел, название
  const endW = (e: (typeof ends)[number]): number => fmtScore(e.v).length * NUM_CH_LAST + 4 + e.name.length * LABEL_CH;
  const PAD_R = END_GAP + Math.ceil(Math.max(0, ...ends.map(endW))) + 4;
  const times = points.map((p) => (p.finishedAt === null ? NaN : Date.parse(p.finishedAt)));
  const known = times.filter((t) => Number.isFinite(t));
  const t0 = Math.min(...known);
  const t1 = Math.max(...known);
  // шкала — по данным (historyDomain), цвет линии — зона последней оценки
  const drawn = [...hci, ...(rhs ?? [])].filter((v): v is number => v !== null);
  const domain = historyDomain(drawn);
  // поле слева — по самой длинной подписи шкалы: «100» шире «40»
  const PAD_L = Math.ceil(Math.max(...domain.ticks.map((g) => String(g).length)) * LABEL_CH) + TICK_GAP;
  // ось X — время анализа; без разброса времени — точки равномерно
  const xOf = (i: number): number => {
    const t = times[i]!;
    const span = CHART_W - PAD_L - PAD_R;
    if (!Number.isFinite(t) || t1 === t0) return PAD_L + (points.length <= 1 ? span / 2 : (i * span) / (points.length - 1));
    return PAD_L + ((t - t0) / (t1 - t0)) * span;
  };
  const path = (values: (number | null)[]): string => {
    let d = "";
    let open = false;
    values.forEach((v, i) => {
      if (v === null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)} `;
      open = true;
    });
    return d.trim();
  };
  const yOf = (v: number): number => PAD_T + (1 - (Math.max(domain.lo, Math.min(domain.hi, v)) - domain.lo) / (domain.hi - domain.lo)) * (CHART_H - PAD_T - PAD_B);
  // отрезок между соседними оценками — цвета зоны левой точки: 65 → 70 желтый, 70 → 80
  // зеленый; переход зоны виден на самой линии. Пропуск данных разрывает линию
  const segments = hci.flatMap((v, i) => {
    const next = hci[i + 1];
    return v !== null && next !== null && next !== undefined ? [{ i, from: v, to: next, color: pointColor(points[i]!) }] : [];
  });
  // подписи у концов линий: по высоте своей точки; близкие — разводятся на
  // строку, большее значение выше (при равных Index выше Score)
  const LINE = 15;
  const endY = ends.map((e) => yOf(e.v) + 4);
  if (ends.length === 2 && Math.abs(endY[0]! - endY[1]!) < LINE) {
    const mid = (endY[0]! + endY[1]!) / 2;
    const indexUp = ends[0]!.v >= ends[1]!.v;
    endY[0] = mid + (indexUp ? -LINE / 2 : LINE / 2);
    endY[1] = mid + (indexUp ? LINE / 2 : -LINE / 2);
  }
  // у кромки графика (оба значения 0 или 100) пара сдвигается целиком: прижатые
  // по одной, подписи снова легли бы друг на друга
  const yMin = 12;
  const yMax = CHART_H - PAD_B;
  const shift = Math.max(0, yMin - Math.min(...endY)) - Math.max(0, Math.max(...endY) - yMax);
  const endLabels = ends.map((e, k) => ({ ...e, x: xOf(e.i) + END_GAP, y: Math.min(yMax, Math.max(yMin, endY[k]! + shift)) }));
  // числа у прошлых точек Index — пока оценок немного, от последней к первой.
  // Число встает над точкой, а если там занято (или у верхней кромки) — под ней;
  // задевшее уже поставленную подпись в обоих местах пропускается — значение
  // остается в подсказке точки
  type Box = [number, number, number, number];
  const hit = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const placed: Box[] = endLabels.map((e) => [e.x - 3, e.y - 12, e.x + endW(e) + 3, e.y + 3]);
  type PointLabel = { key: string; x: number; y: number; text: string; anchor: "start" | "middle" | "end"; color: string };
  const pointLabels: PointLabel[] = [];
  const place = (key: string, i: number, v: number, color: string): void => {
    const text = fmtScore(v);
    const size = 12;
    const w = text.length * NUM_CH;
    const x = xOf(i);
    const anchor = points.length > 1 && i === 0 ? "start" : points.length > 1 && i === points.length - 1 ? "end" : "middle";
    const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
    const above = yOf(v) - 9;
    const below = yOf(v) + size + 6;
    for (const y of above - size < 2 ? [below, above] : [above, below]) {
      const box: Box = [x0 - 3, y - size, x0 + w + 3, y + 3];
      if (placed.some((b) => hit(box, b))) continue;
      placed.push(box);
      pointLabels.push({ key, x, y, text, anchor, color });
      return;
    }
  };
  if (hci.filter((v) => v !== null).length <= 6) {
    for (let i = hLast - 1; i >= 0; i--) {
      const v = hci[i];
      if (v !== null && v !== undefined) place(`h${i}`, i, v, "var(--g-color-text-complementary)");
    }
  }
  // подписи оси: за короткий период (меньше 36 ч) — время, иначе дата. Кандидаты —
  // последняя, первая, средняя; подпись, которая ближе 12px к уже поставленной
  // (по ее ширине и привязке: первая — вправо от точки, средняя — по центру),
  // пропускается. Прежний порог «90 px между точками» склеивал «16 сент. 202621 сент.»
  const short = Number.isFinite(t1 - t0) && t1 - t0 < 36 * 3600_000;
  const axisText = (iso: string | null): string => (short ? fmtTime(iso) : fmtDate(iso));
  const axisAnchor = (i: number): "start" | "middle" | "end" => (i === 0 ? "start" : i === points.length - 1 ? "end" : "middle");
  const axisSpan = (i: number): [number, number] => {
    const w = axisText(points[i]!.finishedAt).length * LABEL_CH;
    const x = xOf(i);
    const a = axisAnchor(i);
    return a === "start" ? [x, x + w] : a === "end" ? [x - w, x] : [x - w / 2, x + w / 2];
  };
  const candidates = [...new Set(points.length <= 2 ? points.map((_, i) => points.length - 1 - i) : [points.length - 1, 0, Math.floor((points.length - 1) / 2)])];
  const labelIdx: number[] = [];
  for (const i of candidates) {
    const [a0, a1] = axisSpan(i);
    const free = labelIdx.every((j) => {
      const [b0, b1] = axisSpan(j);
      return a1 + 12 <= b0 || b1 + 12 <= a0;
    });
    if (free) labelIdx.push(i);
  }
  return (
    <div ref={wrapRef} className="rh-history__chart-wrap">
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width={CHART_W} height={CHART_H} role="img" aria-label={`HealthCraft Index по датам анализов, шкала ${domain.lo}-${domain.hi}`} className="rh-history__chart">
      {/* шкала слева: сплошные линии делений, пунктир — пороги зон внутри шкалы */}
      {domain.ticks.map((g) => (
        <g key={`t${g}`}>
          <line x1={PAD_L} x2={CHART_W - PAD_R} y1={yOf(g)} y2={yOf(g)} stroke="var(--g-color-line-generic)" />
          <text x={0} y={yOf(g) + 4} fontSize={11} fill="var(--g-color-text-secondary)">
            {g}
          </text>
        </g>
      ))}
      {/* порог, совпавший с делением, подписан делением — второй раз число не печатается */}
      {domain.thresholds.map((g) => (
        <g key={`z${g}`}>
          <line x1={PAD_L} x2={CHART_W - PAD_R} y1={yOf(g)} y2={yOf(g)} stroke="var(--g-color-line-generic-active)" strokeDasharray="4 4" />
          {!domain.ticks.includes(g) && (
            <text x={0} y={yOf(g) + 4} fontSize={11} fill="var(--g-color-text-secondary)">
              {g}
            </text>
          )}
        </g>
      ))}
      {/* Repo Health Score — сплошной серой линией с полыми точками: пунктир не
          читался как вторая оценка */}
      {rhs !== null && <path d={path(rhs)} fill="none" stroke="var(--g-color-text-secondary)" strokeWidth={1.5} />}
      {rhs !== null &&
        rhs.map((v, i) => (v === null ? null : <circle key={`r${i}`} cx={xOf(i)} cy={yOf(v)} r={3} fill="var(--g-color-base-background)" stroke="var(--g-color-text-secondary)" strokeWidth={1.5} />))}
      {segments.map((s) => (
        <line key={`s${s.i}`} x1={xOf(s.i)} y1={yOf(s.from)} x2={xOf(s.i + 1)} y2={yOf(s.to)} stroke={s.color} strokeWidth={2} strokeLinecap="round" />
      ))}
      {points.map((p, i) =>
        p.healthcraftIndex === null ? null : (
          <circle key={p.scanId} cx={xOf(i)} cy={yOf(p.healthcraftIndex)} r={3.5} fill={pointColor(p)}>
            <title>
              {/* системная подсказка точки — строками, без разделителей */}
              {[
                fmtDateTime(p.finishedAt),
                `HealthCraft Index ${fmtScore(p.healthcraftIndex)}`,
                rhs !== null ? `Repo Health Score ${fmtScore(p.repoHealthScore)}` : null,
                p.headSha ? `коммит ${p.headSha.slice(0, 7)}` : null,
                p.codeEmpty ? "нет кода" : null,
              ]
                .filter((x) => x !== null)
                .join("\n")}
            </title>
          </circle>
        ),
      )}
      {/* значения у точек — над точкой (если занято — под ней); обводка цветом
          фона отделяет цифры от линий, проходящих рядом */}
      {pointLabels.map((l) => (
        <text key={l.key} x={l.x} y={l.y} fontSize={12} fill={l.color} textAnchor={l.anchor} stroke="var(--g-color-base-background)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
          {l.text}
        </text>
      ))}
      {/* у конца каждой линии — текущее значение жирным и название вместо легенды */}
      {endLabels.map((e) => (
        <text key={e.name} x={e.x} y={e.y} fontSize={11} fill={e.color}>
          <tspan fontSize={13} fontWeight={600} fill={e.valueColor}>
            {fmtScore(e.v)}
          </tspan>
          {` ${e.name}`}
        </text>
      ))}
      {labelIdx.map((i) => (
        <text key={i} x={xOf(i)} y={CHART_H - 6} fontSize={11} fill="var(--g-color-text-secondary)" textAnchor={axisAnchor(i)}>
          {axisText(points[i]!.finishedAt)}
        </text>
      ))}
    </svg>
    </div>
  );
}

/**
 * Строка анализа — как строка списка коммитов SourceCraft: дата главной строкой,
 * коммит (и пометка пустого репо) — второй строкой мелко; баллы — колонками общей
 * сетки списка (subgrid), иконка описания модели — в своей колонке справа.
 */
/**
 * Разница к прошлому анализу у числа — как изменение индекса в «Моих
 * репозиториях»: направление треугольником, величина тише; 0 не печатается.
 */
function DeltaMark({ value }: { value: number | null }) {
  if (value === null || value === 0) return null;
  const up = value > 0;
  return (
    <span className="rh-delta" role="img" aria-label={`${up ? "выросла" : "снизилась"} на ${Math.abs(value)}`}>
      <span className={up ? "rh-rank__arrow rh-rank__arrow_up" : "rh-rank__arrow rh-rank__arrow_down"} aria-hidden="true">
        <Icon data={up ? TriangleUpFill : TriangleDownFill} size={10} />
      </span>
      <span aria-hidden="true">{Math.abs(value)}</span>
    </span>
  );
}

function AnalysisRow({ point, fullOpen, overview, aiColumn }: { point: HistoryPoint; fullOpen: boolean; overview: AiNoteHistoryItem | null; aiColumn: boolean }) {
  const delta = pointDeltas(point, fullOpen);
  // почему изменилась оценка — строкой под анализом на всю ширину
  const why = changeLine(point, fullOpen);
  return (
    <li className="rh-history__row">
      <div className="rh-history__when">
        <Text variant="body-1">{fmtDateTime(point.finishedAt)}</Text>
        {(point.headSha || point.codeEmpty) && (
          <span className="rh-history__meta">
            {point.headSha && (
              <>
                <Text variant="caption-2" color="secondary">
                  {"коммит "}
                  <span className="rh-history__sha">{point.headSha.slice(0, 7)}</span>
                </Text>
                <ClipboardButton text={point.headSha} size="xs" view="flat-secondary" tooltipInitialText="Скопировать хеш коммита" tooltipSuccessText="Скопировано" />
              </>
            )}
            {point.codeEmpty && (
              <Label theme="normal" size="xs">
                нет кода
              </Label>
            )}
          </span>
        )}
      </div>
      <Text variant="body-1" color="complementary" className="rh-history__val">
        {"HealthCraft Index "}
        <span className="rh-history__num">{fmtScore(point.healthcraftIndex)}</span>
        <DeltaMark value={delta.index} />
      </Text>
      {fullOpen && (
        <Text variant="body-1" color="complementary" className="rh-history__val">
          {"Repo Health Score "}
          <span className="rh-history__num">{fmtScore(point.repoHealthScore)}</span>
          <DeltaMark value={delta.full} />
        </Text>
      )}
      {/* описание на момент анализа — иконкой в своей колонке, текст в поповере;
          колонки нет, если описаний нет ни у одного анализа */}
      {aiColumn && (
        <span className="rh-history__ai">
          {overview !== null && (
            <Popover
              placement={["left", "bottom-end", "top-end"]}
              content={
                <div className="rh-history__note">
                  <AiModelLabel model={overview.model} />
                  <AiText text={overview.text} />
                </div>
              }
            >
              <span className="rh-history__note-mark" role="button" tabIndex={0} aria-label="AI-обзор на момент анализа">
                <Icon data={SparklesFill} size={16} />
              </span>
            </Popover>
          )}
        </span>
      )}
      {why !== null && (
        <Text variant="caption-2" color="secondary" className="rh-history__why">
          {why}
        </Text>
      )}
    </li>
  );
}

/**
 * «Что изменилось» — блок истории под AI-разбором динамики: почему оценка между
 * двумя днями стала такой. По умолчанию — от дня перед последним изменением
 * оценки до последнего анализа; дни и показатель выбирают сами. Вклады целые,
 * их сумма равна разнице оценок. Без изменений оценки блока нет.
 */
function ScoreBridge({ points, fullOpen, org, repo }: { points: HistoryPoint[]; fullOpen: boolean; org: string; repo: string }) {
  const fallback = defaultPair(points, fullOpen);
  const [picked, setPicked] = useState<{ from: number; to: number } | null>(null);
  // выбранный анализ мог пропасть из истории (смена модели) — тогда пара по умолчанию
  const known = (id: number): boolean => points.some((p) => p.scanId === id);
  const pair = picked !== null && known(picked.from) && known(picked.to) ? picked : fallback;
  // индекс ни разу не менялся — зритель с правами сразу видит Repo Health Score
  const [metric, setMetric] = useState<BridgeMetric>(() => defaultMetric(points, fullOpen));
  if (pair === null) return null;
  return (
    <div className="rh-scorediff" role="group" aria-labelledby="rh-scorediff-title" data-slot="scoreChange">
      <ScoreBridgeBody points={points} fullOpen={fullOpen} org={org} repo={repo} pair={pair} onPair={setPicked} metric={fullOpen ? metric : "index"} onMetric={setMetric} />
    </div>
  );
}

type DiffState = { kind: "idle" | "loading" } | { kind: "ok"; data: ScoreChange } | { kind: "error"; message: string };

/**
 * Разница двух несоседних анализов с сервера; url null — запрос не нужен (разница
 * уже в истории). Результат помнит свой адрес: при смене пары числа прошлой не
 * мелькают до эффекта — пока ответа на новый адрес нет, это «загрузка».
 */
function useDiff(url: string | null): DiffState {
  const [state, setState] = useState<{ url: string; value: DiffState } | null>(null);
  useEffect(() => {
    if (url === null) return;
    const ctrl = new AbortController();
    fetchJson<ScoreChange>(url, ctrl.signal)
      .then((data) => setState({ url, value: { kind: "ok", data } }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setState({ url, value: { kind: "error", message: e instanceof Error ? e.message : String(e) } });
      });
    return () => ctrl.abort();
  }, [url]);
  if (url === null) return { kind: "idle" };
  return state !== null && state.url === url ? state.value : { kind: "loading" };
}

function ScoreBridgeBody({
  points,
  fullOpen,
  org,
  repo,
  pair,
  onPair,
  metric,
  onMetric,
}: {
  points: HistoryPoint[];
  fullOpen: boolean;
  org: string;
  repo: string;
  pair: { from: number; to: number };
  onPair: (pair: { from: number; to: number }) => void;
  metric: BridgeMetric;
  onMetric: (metric: BridgeMetric) => void;
}) {
  const toIdx = points.findIndex((p) => p.scanId === pair.to);
  // соседние анализы — разница уже пришла с историей, запрос не нужен
  const adjacent = points[toIdx]?.change?.fromScanId === pair.from ? points[toIdx]!.change : null;
  const state = useDiff(adjacent !== null ? null : `${apiBase(org, repo)}/history/diff?from=${pair.from}&to=${pair.to}`);
  const change = adjacent ?? (state.kind === "ok" ? state.data : null);
  // в полях — только дни: один пункт на день, его последний анализ; новые сверху
  const days = pinDays(points, [pair.from, pair.to]);
  const dayAt = (scanId: number): number => days.findIndex((d) => d.scanId === scanId);
  const options = (lo: number, hi: number) =>
    days
      .flatMap((d, i) => (i >= lo && i <= hi ? [{ value: String(d.scanId), content: d.day }] : []))
      .reverse();
  const bridge = change === null ? null : bridgeOf(change, metric);
  const special = change === null ? null : specialText(change);
  return (
    <Flex direction="column" gap={3}>
      <div className="rh-scorediff__head">
        <Flex gap={2} alignItems="center" className="rh-scorediff__title">
          {/* нейтральный значок — пара к искре AI-разбора выше: здесь факты, а не текст модели */}
          <Icon data={ArrowUpArrowDown} size={16} className="rh-scorediff__icon" />
          <Text variant="subheader-2" as="h3" id="rh-scorediff-title">
            Что изменилось
          </Text>
          <HelpMark iconSize="s" aria-label="Как читать">
            На сколько баллов каждая категория сдвинула оценку между выбранными днями. Вклады целые и в сумме дают разницу оценок.
          </HelpMark>
        </Flex>
        <Select
          size="m"
          value={[String(pair.from)]}
          options={options(0, dayAt(pair.to) - 1)}
          onUpdate={(v) => onPair({ from: Number(v[0]), to: pair.to })}
          aria-label="С какого дня"
          popupClassName="rh-scorediff__popup"
          popupPlacement="bottom-start"
        />
        <Icon data={ArrowRight} size={16} className="rh-scorediff__arrow" />
        <Select
          size="m"
          value={[String(pair.to)]}
          options={options(dayAt(pair.from) + 1, days.length - 1)}
          onUpdate={(v) => onPair({ from: pair.from, to: Number(v[0]) })}
          aria-label="По какой день"
          popupClassName="rh-scorediff__popup"
          popupPlacement="bottom-start"
        />
        {/* показатель — зрителю с правами на Repo Health Score: у полного свои вклады и CI/CD с Безопасностью */}
        {fullOpen && (
          <SegmentedRadioGroup size="m" value={metric} onUpdate={(v) => onMetric(v === "full" ? "full" : "index")} aria-label="Показатель">
            <SegmentedRadioGroup.Option value="index">HealthCraft Index</SegmentedRadioGroup.Option>
            <SegmentedRadioGroup.Option value="full">Repo Health Score</SegmentedRadioGroup.Option>
          </SegmentedRadioGroup>
        )}
      </div>
      {change === null ? (
        state.kind === "error" ? (
          <Text variant="body-1" color="secondary">
            Разницу не удалось загрузить: {state.message}
          </Text>
        ) : (
          <Skeleton style={{ height: 96, width: "100%" }} />
        )
      ) : special !== null ? (
        <Text variant="body-1">{special}</Text>
      ) : bridge === null ? (
        <Text variant="body-1" color="secondary">
          {metric === "full" && change.fullCapped
            ? "Repo Health Score ограничен потолком за находки AppSec, поэтому его изменение по категориям не раскладывается."
            : "У одного из анализов нет оценки – сравнивать нечего."}
        </Text>
      ) : (
        <ChangeRows bridge={bridge} />
      )}
    </Flex>
  );
}

/**
 * Итог и категории: оценки «с → по» крупно, под ними строки категорий —
 * название, полоса вклада (длина — доля самого большого вклада, цвет —
 * прибавила или убавила), вклад и одна фраза «почему»; числа «было → стало» —
 * в подсказке фразы.
 */
function ChangeRows({ bridge }: { bridge: Bridge }) {
  const max = Math.max(1, ...bridge.steps.map((s) => Math.abs(s.value)));
  return (
    <>
      <div className="rh-scorediff__totals">
        <Text variant="header-1" color="secondary">
          {bridge.from}
        </Text>
        <Icon data={ArrowRight} size={20} className="rh-scorediff__arrow" />
        <Text variant="header-1">{bridge.to}</Text>
        <Text variant="body-2">
          <DeltaMark value={bridge.to - bridge.from} />
        </Text>
      </div>
      <ul className="rh-scorediff__list">
        {bridge.steps.map((s) => {
          const phrase = categoryPhrase(s.change);
          const details = categoryDetails(s.change);
          return (
            <li key={s.change.key} className="rh-scorediff__row">
              <Text variant="subheader-1" className="rh-scorediff__name">
                {categoryTitle(s.change.key)}
              </Text>
              <span className="rh-scorediff__track" aria-hidden="true">
                <i className={s.value > 0 ? "rh-scorediff__fill_up" : "rh-scorediff__fill_down"} style={{ width: `${(Math.abs(s.value) / max) * 100}%` }} />
              </span>
              <Text variant="subheader-2" className="rh-scorediff__val">
                {fmtDelta(s.value)}
              </Text>
              {phrase !== null && (
                <Text variant="body-1" color="secondary" className="rh-scorediff__why">
                  {details.length > 0 ? (
                    <ActionTooltip
                      title="Было → стало"
                      description={
                        <span className="rh-scorediff__details">
                          {details.map((d) => (
                            <span key={d}>{d}</span>
                          ))}
                        </span>
                      }
                    >
                      <span className="rh-scorediff__phrase" {...TIP_TARGET}>
                        {phrase.charAt(0).toUpperCase() + phrase.slice(1)}
                      </span>
                    </ActionTooltip>
                  ) : (
                    phrase.charAt(0).toUpperCase() + phrase.slice(1)
                  )}
                </Text>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function HistorySection({ card, org, repo }: { card: Card; org: string; repo: string }) {
  // описания по анализам — только зрителю с правами (сервер закрывает /ai-notes сам)
  return card.ai !== undefined ? <HistoryWithNotes card={card} org={org} repo={repo} /> : <HistoryBody card={card} org={org} repo={repo} notes={null} />;
}

function HistoryWithNotes({ card, org, repo }: { card: Card; org: string; repo: string }) {
  const { state, reload } = useJson<AiNotesResponse>(`${apiBase(org, repo)}/ai-notes`);
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => j.slug === `${org}/${repo}`)) reload();
  });
  return <HistoryBody card={card} org={org} repo={repo} notes={dataOf(state)} />;
}

function HistoryBody({ card, org, repo, notes }: { card: Card; org: string; repo: string; notes: AiNotesResponse | null }) {
  const { state, reload } = useJson<HistoryResponse>(`${apiBase(org, repo)}/history`, { keepPrevious: true });
  // новая точка истории появляется без перезагрузки — по итогу задания этого репо
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => j.slug === `${org}/${repo}`)) reload();
  });
  const data = dataOf(state);
  const [listOpen, setListOpen] = useState(false);
  // Пока история не пришла или не загрузилась — скелетон или ошибка, а не «оценок нет»:
  // 429 или перечитывание после анализа иначе показали бы ложное пустое состояние
  if (data === null) {
    return (
      <section className="rh-section" aria-labelledby="rh-history-title" data-slot="scoreHistory" aria-busy={state.kind === "loading"}>
        <Card view="outlined" className="rh-section-card rh-placeholder-card">
          <Flex direction="column" gap={1} alignItems="flex-start">
            <Text variant="subheader-3" as="h2" id="rh-history-title">
              {SLOT_EMPTY.scoreHistory.title}
            </Text>
            {state.kind === "error" ? (
              <>
                <Text variant="subheader-2">История не загрузилась</Text>
                <Text variant="body-1" color="complementary">{state.message}</Text>
                <Button view="outlined" size="s" onClick={reload}>
                  Повторить
                </Button>
              </>
            ) : (
              <Skeleton style={{ height: 120, width: "100%" }} />
            )}
          </Flex>
        </Card>
      </section>
    );
  }
  const overviewByScan = new Map<number, AiNoteHistoryItem>();
  if (notes && !notes.locked) for (const n of notes.notes) if (n.role === "overview") overviewByScan.set(n.scanId, n);
  const points = historyByTime(data?.points ?? []);
  const view = scoreHistoryView(data);
  const fullOpen = data?.fullOpen === true;
  const trajectory = card.ai?.specialists.find((n) => n.role === "trajectory") ?? null;
  const caption = aiNotesCaption(
    points.filter((p) => overviewByScan.has(p.scanId)).map((p) => p.finishedAt),
    evolutionTooEarly,
  );
  // колонки списка: дата, Index, Score (если открыт), иконка описания (если есть)
  const aiColumn = points.some((p) => overviewByScan.has(p.scanId));
  const list = points.length > 0 && (
    // счетчик — вторичным цветом отдельным словом, как «Contributors 1» у SourceCraft
    <Disclosure
      size="m"
      className="rh-history__all"
      expanded={listOpen}
      onUpdate={setListOpen}
      summary={
        <>
          {"Все анализы "}
          <span className="rh-history__count">{points.length}</span>
        </>
      }
    >
      {/* один слой внутри — для анимации высоты (стили .g-disclosure__content) */}
      <div className="rh-collapse__inner">
        {caption && (
          <Text variant="caption-2" color="secondary">
            {caption}
          </Text>
        )}
        <ul className="rh-history__list" style={{ gridTemplateColumns: `minmax(0, 1fr) auto${fullOpen ? " auto" : ""}${aiColumn ? " 16px" : ""}` }}>
          {[...points].reverse().map((p) => (
            <AnalysisRow key={p.scanId} point={p} fullOpen={fullOpen} overview={overviewByScan.get(p.scanId) ?? null} aiColumn={aiColumn} />
          ))}
        </ul>
      </div>
    </Disclosure>
  );
  if (!view.chart) {
    return (
      <section className="rh-section" aria-labelledby="rh-history-title" data-slot="scoreHistory">
        <Card view="outlined" className="rh-section-card rh-placeholder-card">
          <Flex direction="column" gap={1} alignItems="flex-start">
            <Text variant="subheader-3" as="h2" id="rh-history-title">
              {SLOT_EMPTY.scoreHistory.title}
            </Text>
            <Text variant="subheader-2">Графика пока нет</Text>
            <Text variant="body-1" color="complementary">
              {view.text}
            </Text>
          </Flex>
          {list && <div className="rh-history__placeholder-list">{list}</div>}
        </Card>
      </section>
    );
  }
  return (
    <section className="rh-section" aria-labelledby="rh-history-title" data-slot="scoreHistory">
      <Card view="outlined" className="rh-section-card">
        <Flex gap={2} alignItems="baseline" wrap className="rh-section__title">
          <Text variant="subheader-3" as="h2" id="rh-history-title">
            {SLOT_EMPTY.scoreHistory.title}
          </Text>
        </Flex>
        <Flex direction="column" gap={5} className="rh-history">
          {/* легенды нет: линии подписаны названиями у концов, значения — над точками */}
          <HistoryChart points={points} fullOpen={fullOpen} />
          {trajectory !== null && <AiNotePlate title="AI-разбор динамики" text={trajectory.text} staleFor={aiNotesStale(card.ai) ? card : null} />}
          {/* почему оценка стала такой — под AI-разбором динамики, перед списком анализов */}
          <ScoreBridge points={points} fullOpen={fullOpen} org={org} repo={repo} />
          {list}
        </Flex>
      </Card>
    </section>
  );
}

// ---------- бейдж для README ----------

// Бейдж для README — только у своих репозиториев (они есть в списке «Мои
// репозитории» по токену зрителя); у чужих кнопки нет. Открытому из рейтинга
// хватает публичного маршрута `badge.svg`; закрытому (private/internal) – с ключом
// `repo.badgeKey`, который маршрут карточки отдает только зрителю с правами.
// Доступность знает сервер (поля карточки `repo.badge` и `repo.badgeKey`), без
// пробного запроса `badge.svg`, который ловил бы 404 в консоли.

/**
 * Подписи чипов окна бейджа – короткие: 4 чипа с галочками идут в одну строку и на
 * телефоне (311px). «Зона» – слово зоны шкалы («здоров»), «Динамика» – разница с
 * прошлым анализом, «Категории» – шкалы 4 категорий под шапкой бейджа.
 */
const BADGE_CHIP_TEXT: Record<BadgeChip, string> = { rank: "Лига", word: "Зона", delta: "Динамика", cats: "Категории" };
const BADGE_FORMAT_TEXT: Record<BadgeFormat, string> = { md: "Markdown", html: "HTML", url: "Ссылка", json: "JSON API" };

/** Что передать окну бейджа: репо, адрес сервиса, есть ли лига и ключ закрытого репо. */
export interface BadgeTarget {
  org: string;
  repo: string;
  publicBaseUrl: string;
  league: boolean;
  /** `repo.badgeKey` закрытого репо; у открытого – null */
  badgeKey: string | null;
}

/**
 * Окно бейджа, как Clone у SourceCraft: превью, чипы частей в одну строку и поле
 * с кодом – формат слева, кнопка копирования справа. Чип лиги – только у репо с
 * лигой; JSON API – только у открытого (ключ закрытого открывает лишь бейдж).
 */
function BadgeContent({ target, title = true }: { target: BadgeTarget; title?: boolean }) {
  const { org, repo, publicBaseUrl, league, badgeKey } = target;
  const [chips, setChips] = useState<ReadonlySet<BadgeChip>>(() => new Set(league ? ["rank"] : []));
  const [format, setFormat] = useState<BadgeFormat>("md");
  const shown = BADGE_CHIPS.filter((c) => c !== "rank" || league);
  const formats = (Object.keys(BADGE_FORMAT_TEXT) as BadgeFormat[]).filter((f) => f !== "json" || badgeKey === null);
  const toggle = (c: BadgeChip) =>
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  const code = badgeCode({ publicBaseUrl, org, repo, chips, key: badgeKey }, format);
  // превью – с адреса этого же сервиса (относительный путь), тот же бейдж, что в коде
  const preview = badgeCode({ publicBaseUrl: "", org, repo, chips, key: badgeKey }, "url");
  // пока сервер рисует новый бейдж, на его месте скелетон по размеру бейджа (с категориями
  // это карточка); картинка грузится невидимой и показывается, когда готова
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  // не загрузилось (лимит запросов, сбой сети) – подпись вместо битой картинки; код выше верен
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const ready = loaded.has(preview);
  const broken = failed.has(preview);
  const markLoaded = () => setLoaded((prev) => (prev.has(preview) ? prev : new Set(prev).add(preview)));
  const markFailed = () => setFailed((prev) => (prev.has(preview) ? prev : new Set(prev).add(preview)));
  return (
    <div className="rh-badge-pop" data-slot="badge">
      {title && (
        <Text variant="subheader-1" as="div">
          {SLOT_EMPTY.badge.title}
        </Text>
      )}
      <div className="rh-badge-pop__preview" aria-busy={!ready && !broken}>
        {!ready && !broken && <Skeleton className="rh-badge-pop__skeleton" style={chips.has("cats") ? { width: 232, height: 92 } : { width: 180 }} />}
        {broken && (
          <Text color="secondary">Превью не загрузилось – попробуйте чуть позже. Код ниже рабочий.</Text>
        )}
        {!broken && <img key={preview} src={preview} alt="HealthCraft Index" hidden={!ready} onLoad={markLoaded} onError={markFailed} />}
      </div>
      <div className="rh-badge-pop__chips" role="group" aria-label="Что показать на бейдже">
        {shown.map((c) => (
          <Button key={c} className="rh-badge-pop__chip" size="s" view="outlined" selected={chips.has(c)} aria-pressed={chips.has(c)} onClick={() => toggle(c)}>
            {BADGE_CHIP_TEXT[c]}
            {chips.has(c) && (
              <Button.Icon side="end">
                <Icon data={Check} size={14} />
              </Button.Icon>
            )}
          </Button>
        ))}
      </div>
      <div className="rh-badge-pop__code">
        <Select
          className="rh-badge-pop__format"
          size="m"
          pin="round-brick"
          value={[format]}
          onUpdate={(v) => setFormat((v[0] as BadgeFormat | undefined) ?? "md")}
          options={formats.map((f) => ({ value: f, content: BADGE_FORMAT_TEXT[f] }))}
          aria-label="Формат кода"
          popupPlacement="bottom-start"
        />
        <TextInput className="rh-badge-pop__input" size="m" pin="brick-brick" readOnly value={code} controlProps={{ "aria-label": "Код бейджа" }} />
        <ClipboardButton text={code} size="m" view="outlined" pin="brick-round" tooltipInitialText="Скопировать" tooltipSuccessText="Скопировано" />
      </div>
    </div>
  );
}

/** На телефоне бейдж открывается из меню «⋮» — диалогом. */
export function BadgeDialog({ target, open, onClose }: { target: BadgeTarget; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="s" fullWidth className="rh-dialog-fit" aria-label={SLOT_EMPTY.badge.title}>
      <Dialog.Header caption={SLOT_EMPTY.badge.title} />
      <Dialog.Body>
        <BadgeContent target={target} title={false} />
      </Dialog.Body>
      <Dialog.Footer textButtonCancel="Готово" onClickButtonCancel={onClose} />
    </Dialog>
  );
}

export function BadgeButton({ target }: { target: BadgeTarget }) {
  return (
    <Popover trigger="click" placement={["bottom-end", "top-end"]} content={<BadgeContent target={target} />}>
      <Button view="normal" size="m">
        <Button.Icon side="start">
          <Icon data={SealCheck} size={16} />
        </Button.Icon>
        Бейдж
      </Button>
    </Popover>
  );
}
