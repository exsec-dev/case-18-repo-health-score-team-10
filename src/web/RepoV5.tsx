// RepoV5.tsx — элементы В5 на карточке репозитория, переверстанные кругом 3
// вехи В5.3 по дизайн-аудиту (reports/2026-09-24-m53-ui-design-audit.md) и
// выбору владельца (TASK.md §2 24.09 «В5.3, круг 3»):
//   - флаг фрода — текст фактора строит код (6-A, способ 2); с UX-прохода В5.2 25.09 — в подвале
//     плашки HealthCraft Index рядом с кнопкой проверки;
//   - AI-обзор — раздел сразу под показателями в рамке градиента Алисы (2-A);
//     разбор модели по категориям — в раскрытии категории, отметка в строке (3-B + плашка);
//   - история оценки — раздел ленты: ось времени, пороги, список анализов (3-B),
//     описание на момент анализа — в строке анализа (4-A);
//   - бейдж для README — кнопка в шапке с поповером, как Clone у SourceCraft (5-A).
// Видимость текстов модели — прежняя (решение 22.09): `card.ai` приходит только
// зрителю с правами на полный Score; без прав этих блоков нет вовсе.
import { ArrowsRotateRight, ChevronDown, CircleExclamation, ClockArrowRotateLeft, HourglassEnd, SealCheck, Shield, ShieldCheck, ShieldExclamation, Sparkles } from "@gravity-ui/icons";
import {
  ActionTooltip,
  Alert,
  Button,
  Card,
  ClipboardButton,
  Disclosure,
  Flex,
  HelpMark,
  Icon,
  Label,
  Link,
  Popover,
  Skeleton,
  Spin,
  Text,
  TextInput,
  useToaster,
} from "@gravity-ui/uikit";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RepoCard } from "./api";
import { dataOf, useJson } from "./api";
import {
  AI_SECTION_TITLE,
  FRAUD_EXPLAIN,
  FRAUD_TITLE,
  aiModelName,
  aiParagraphs,
  aiRoleTitle,
  fmtDate,
  fmtDateTime,
  fmtScore,
  fraudFactorFact,
  fraudFactorValue,
  fraudCheckStale,
  fraudFactorTitle, AI_DISCLAIMER, AI_OVERVIEW_REJECTED,
  quotaBlockedText,
  quotaCounter,
  withCounter,
  type AiQuotaView,
} from "./format";
import { announceJobStarted, announceJobsChanged, useAnalysisFinished } from "./session";
import { SLOT_EMPTY, aiNotesCaption, badgeMarkdown, historyByTime, scoreHistoryView } from "./slots";
import type { AiNoteHistoryItem, AiNotesResponse, HistoryPoint, HistoryResponse } from "../summary/history-contract";
import { evolutionTooEarly } from "../summary/history-contract";

type Card = RepoCard;
type CardAi = NonNullable<Card["ai"]>;
type AiNote = NonNullable<CardAi["overview"]>;

const apiBase = (org: string, repo: string): string => `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;

// ---------- общая метка модели ----------

/** Метка AI — одна форма на всех экранах (§2 24.09): официальное имя; §2 25.09 — чисто серая (`unknown`), без иконки. */
export function AiModelLabel({ model }: { model: string }) {
  return (
    <Label theme="unknown" size="xs">
      {aiModelName(model)}
    </Label>
  );
}

/** Абзацы текста модели (О3): те же, что в отчете. */
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
  requestAnimationFrame(() => document.getElementById(categoryAnchor(key))?.scrollIntoView({ block: "center", behavior: "smooth" }));
}

// ---------- флаг фрода (К-3, выбор 6-A) ----------

/**
 * Строка подозрения на накрутку: заголовок, главный признак и подсказка с остальными.
 * UX-проход 25.09 (замечание 7, Екатерина): живет в подвале плашки HealthCraft Index
 * рядом с кнопкой проверки, а не отдельной плашкой над показателями.
 */
function FraudFlagMessage({ card }: { card: Card }) {
  const fraud = card.ai?.fraud;
  // подозрение — только при флаге, как в кабинете и отчете
  if (fraud === undefined || fraud === null || fraud.flag !== true || fraud.factors.length === 0) return null;
  const factOf = (key: string): unknown => fraudFactorValue(key, fraud.signals, card.evidence, fraud.inputs);
  // вариант B (25.09): одна строка — заголовок и главный признак; пояснение и
  // остальные признаки — в подсказке; формулировка модели — только в отчете.
  // Признак — строка кода из факта (способ 2), без факта — формулировка модели
  const lines = fraud.factors.flatMap((f) => (fraudFactorFact(f.key, factOf(f.key)) ?? f.note).split("; "));
  const [lead, ...rest] = lines;
  return (
        <span className="rh-fraud__line">
          <Text variant="subheader-1">{`${FRAUD_TITLE}: `}</Text>
          {/* аудит надежности М2: флаг прошлого анализа не выдается за текущий */}
          <Text variant="body-1">{fraudCheckStale(card.ai?.check) ? `${lead} (по прошлому анализу)` : lead}</Text>
          <HelpMark iconSize="s" aria-label="Что значит подозрение на искусственную активность" className="rh-fraud__help">
            <Flex direction="column" gap={2} className="rh-fraud__pop">
              <Text variant="body-1">{FRAUD_EXPLAIN}</Text>
              {rest.length > 0 && (
                <Flex direction="column" gap={1}>
                  <Text variant="body-1" color="secondary">
                    Другие признаки:
                  </Text>
                  {rest.map((l) => (
                    <Text key={l} variant="body-1">
                      {l}
                    </Text>
                  ))}
                </Flex>
              )}
              <Text variant="caption-2" color="secondary">
                {`Признаки: ${fraud.factors.map((f) => fraudFactorTitle(f.key)).join(", ")}. Подробности – в разделе отчета.`}
              </Text>
            </Flex>
          </HelpMark>
        </span>
  );
}

// ---------- AI-обзор (выбор 2-A) ----------

/** Причина конвейера «нет фактов категории» — не ошибка: у категории нет данных, модели нечего пояснять (О8). */
function isNoFacts(reason: string): boolean {
  return reason.startsWith("нет фактов");
}

/** Длинный текст: затухание ~6 строк и «Показать полностью» (выбор владельца 24.09, вариант A). */
function Collapsible({ children, resetKey }: { children: React.ReactNode; resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => setOpen(false), [resetKey]);
  // Замечание 25.09 (кнопка пропала на широком экране): затухание гасило последнюю
  // строку, а переполнение было меньше порога. Теперь: полная высота (scrollHeight
  // не зависит от max-height) сравнивается с лимитом 6 строк; хвост до полутора
  // строк показывается целиком, длиннее — затухание и кнопка
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = (): void => {
      const line = parseFloat(getComputedStyle(el).getPropertyValue("--g-text-body-1-line-height")) || 18;
      setOverflows(el.scrollHeight > line * 7.5);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [resetKey]);
  const clamped = overflows && !open;
  return (
    <Flex direction="column" gap={1} alignItems="flex-start">
      <div ref={ref} className={`rh-ai-text${clamped ? " rh-ai-text_clamped" : ""}`}>
        {children}
      </div>
      {overflows && (
        // замечание 2 (25.09): без полей — начало строки совпадает с абзацем
        <button type="button" className="rh-ai-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Свернуть" : "Показать полностью"}
          <Icon data={ChevronDown} size={14} style={open ? { transform: "rotate(180deg)" } : undefined} />
        </button>
      )}
    </Flex>
  );
}

/**
 * Тост отказа (аудит дизайна О8): лимит — штатное состояние, желтым «Лимит исчерпан» с
 * текстом сервера и временем; красным — только настоящие сбои.
 */
function refusalToast(error: { code?: string; message?: string; until?: string } | undefined, status: number, failTitle: string): { theme: "warning" | "danger"; title: string; content: string } {
  const message = error?.message ?? `Ошибка ${status}`;
  if (error?.code?.startsWith("quota_")) {
    const tail = error.code === "quota_hour" && error.until ? `. Следующий запуск – после ${fmtDateTime(error.until)}` : "";
    return { theme: "warning", title: "Лимит исчерпан", content: `${message}${tail}` };
  }
  return { theme: "danger", title: failTitle, content: message };
}

/**
 * Остаток лимитов AI зрителя (В5.2, Б6, решение 3): один запрос на карточку, только
 * вошедшему (аноним не шлет запрос — 401 в консоли не нужен). `reload` — после
 * постановки заявки и по итогу задания.
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
      // 23.09 (smoke-круг 2): объявленное задание тостится, даже если опрос застал его завершенным
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
    } finally {
      setSending(false);
    }
  };
  // В5.2 (Б3): переключатель автообновления удален — обзор запускается только кнопкой
  return { sending, start };
}

/**
 * Подпись под скелетоном обзора по фазе (UX-1, вариант (б), решение Екатерины 25.09):
 * «Обновить обзор» у владельца — сначала анализ, потом текст; два уведомления остаются,
 * а подпись честно говорит, что происходит сейчас.
 */
export function aiProgressText(analysisRunning: boolean, ownFullCycle: boolean): string {
  if (analysisRunning) return "Идет анализ – затем обзор обновится сам.";
  if (ownFullCycle) return "Анализ готов, обзор дописывается – раздел обновится сам.";
  return "Обзор формируется – раздел обновится сам.";
}

/** «Проверить оценку» (В5.2, Б3): постановка проверки на накрутку. */
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
    } finally {
      setSending(false);
    }
  };
  return { sending, start };
}

/** Состояние проверки оценки для подвала (аудит дизайна §3.1): иконка, текст, дата, кнопка. */
export interface FraudCheckState {
  kind: "none" | "active" | "clean" | "flagged" | "failed" | "nothing" | "stale";
  text: string;
  date: string | null;
  button: "Проверить оценку" | "Повторить проверку" | null;
}

/**
 * Тексты 7 состояний — таблица §3.1 аудита дизайна (reports/2026-09-25-m52-ui-design-audit.md);
 * имя действия одно — «проверка оценки» (О4); «нет истории коммитов» — факт, не сбой (О3);
 * флаг прошлого анализа несет желтая плашка подвала с пометкой «по прошлому анализу» (О5).
 */
export function fraudCheckState(ai: CardAi, loggedIn: boolean): FraudCheckState {
  const { check, fraud } = ai;
  const stale = check.scanId !== null && check.latestScanId !== null && check.scanId < check.latestScanId;
  // UX-проход 25.09 (замечание 6): рядом со статусом — только дата, без «проверено»
  const date = check.checkedAt ? fmtDateTime(check.checkedAt) : null;
  if (check.active) return { kind: "active", text: "Проверка оценки идет – результат появится здесь", date: null, button: null };
  if (check.failure !== null && !check.retryable) return { kind: "nothing", text: "Проверять нечего: в анализе нет истории коммитов", date: null, button: null };
  const run = loggedIn && check.latestScanId !== null;
  if (check.failure !== null) {
    return {
      kind: "failed",
      text: loggedIn ? `Проверка оценки не сформировалась: ${check.failure}` : "Проверка оценки не сформировалась",
      date: null,
      button: run ? "Повторить проверку" : null,
    };
  }
  // UX-проход 25.09 (замечание 7): признаки — в самом подвале, «подробности выше» больше не нужно
  if (fraud !== null && fraud.flag) return { kind: "flagged", text: "Есть признаки накрутки", date, button: run && stale ? "Проверить оценку" : null };
  if (fraud !== null && stale) return { kind: "stale", text: "Признаков накрутки нет по прошлому анализу", date, button: run ? "Проверить оценку" : null };
  if (fraud !== null) return { kind: "clean", text: "Признаков накрутки нет", date, button: null };
  return {
    kind: "none",
    text: loggedIn ? "Оценка не проверялась на накрутку" : "Проверку может запустить любой вошедший пользователь",
    date: null,
    button: run ? "Проверить оценку" : null,
  };
}

const CHECK_ICON: Record<FraudCheckState["kind"], { data: typeof Shield; color: string } | null> = {
  none: { data: Shield, color: "var(--g-color-text-secondary)" },
  active: null,
  clean: { data: ShieldCheck, color: "var(--g-color-text-positive)" },
  flagged: { data: ShieldExclamation, color: "var(--g-color-text-warning)" },
  failed: { data: CircleExclamation, color: "var(--g-color-text-secondary)" },
  nothing: { data: Shield, color: "var(--g-color-text-secondary)" },
  stale: { data: ClockArrowRotateLeft, color: "var(--g-color-text-secondary)" },
};

/**
 * Подвал плашки HealthCraft Index (В5.2, Б6, выбор 1A): состояние проверки оценки и
 * кнопка «Проверить оценку N/M» (решение 3 — остаток в тексте кнопки). Статус меняется
 * опросом — `aria-live` (О11); причина неактивной кнопки — видимой подписью (О2).
 */
export function FraudCheckFooter({ card, org, repo, onChanged, loggedIn, quota, onQuota }: { card: Card; org: string; repo: string; onChanged: () => void; loggedIn: boolean; quota: AiQuotaView | null; onQuota: () => void }) {
  const ai = card.ai;
  const action = useCheckAction(org, repo, () => {
    onChanged();
    onQuota();
  });
  useEffect(() => {
    if (ai === undefined || ai === null || !ai.check.active) return;
    const timer = setTimeout(onChanged, 5000);
    return () => clearTimeout(timer);
  }, [ai, onChanged]);
  if (ai === undefined || ai === null) return null;
  const st = fraudCheckState(ai, loggedIn);
  const counter = quotaCounter(quota?.check);
  const blocked = counter !== null && counter.left === 0 && quota !== null ? quotaBlockedText("check", quota.check, counter) : null;
  const icon = CHECK_ICON[st.kind];
  const button =
    st.button !== null ? (
      // UX-проход 25.09, круг 2 (замечание 2): кнопка без иконки во всех состояниях
      <Button view={st.kind === "flagged" ? "normal-contrast" : "outlined"} size="s" loading={action.sending} disabled={blocked !== null} onClick={() => void action.start()}>
        {withCounter(st.button, counter)}
      </Button>
    ) : null;
  const why =
    st.button !== null && blocked !== null ? (
      <Text variant="caption-2" color="secondary" as="p" className="rh-check-foot__why">
        {blocked}
      </Text>
    ) : null;
  // UX-проход 25.09 (замечание 7, Екатерина): признаки накрутки — желтой плашкой в самом
  // подвале, рядом с кнопкой проверки; отдельной плашки над показателями больше нет
  const flagLine = st.kind === "flagged" ? <FraudFlagMessage card={card} /> : null;
  if (flagLine !== null && ai.fraud?.factors.length) {
    return (
      <div className="rh-check-foot rh-check-foot_flagged" aria-live="polite">
        <Alert
          theme="warning"
          view="filled"
          size="s"
          // UX-проход 25.09, круг 2 (замечание 2): иконка — по первой строке текста
          align="baseline"
          // кнопка — под текстом: в узкой плашке индекса сбоку она сжимает строку признака
          className="rh-fraud"
          message={
            <Flex direction="column" gap={1}>
              {flagLine}
              {st.date !== null && (
                <Text variant="caption-2" color="secondary">
                  {st.date}
                </Text>
              )}
            </Flex>
          }
          actions={button ?? undefined}
        />
        {why}
      </div>
    );
  }
  return (
    <div className="rh-check-foot" aria-live="polite">
      <Flex gap={2} alignItems="center" justifyContent="space-between" wrap>
        <Flex gap={2} alignItems="center" style={{ minWidth: 0 }}>
          {icon === null ? <Spin size="xs" /> : <Icon data={icon.data} size={16} style={{ color: icon.color, flexShrink: 0 }} />}
          <Text variant="body-short">{st.text}</Text>
          {st.date !== null && (
            <Text variant="caption-2" color="hint">
              {st.date}
            </Text>
          )}
        </Flex>
        {button}
      </Flex>
      {why}
    </div>
  );
}

export function AiOverviewSection({ card, org, repo, onChanged, loggedIn, quota, onQuota }: { card: Card; org: string; repo: string; onChanged: () => void; loggedIn: boolean; quota: AiQuotaView | null; onQuota: () => void }) {
  const ai = card.ai;
  const own = card.viewer?.own === true;
  // В5.2 (Б3): публичный обзор публичного репо запускает любой вошедший; закрытого — владелец
  const canRun = loggedIn && (own || card.repo.visibility === "public");
  const publicVersion = ai?.audience === "public";
  const actions = useSummaryActions(org, repo, () => {
    onChanged();
    onQuota();
  });
  // решение 3 (25.09): остаток — в тексте кнопки; при нуле кнопка неактивна, причина видна (О2)
  const counter = quotaCounter(quota?.overview);
  const quotaBlocked = counter !== null && counter.left === 0 && quota !== null ? quotaBlockedText("overview", quota.overview, counter) : null;

  // smoke-круг 23.09: пока задание идет — карточка перечитывается раз в 5 с.
  // Разбор задержки 25.09 (Ф1, reports/2026-09-25-m53-ai-latency.md): setInterval
  // обрывал идущий запрос (useJson отменяет прежний) — ответ дольше 5 с не доходил
  // никогда. Теперь следующий запрос — через 5 с ПОСЛЕ ответа: новая карточка →
  // новый `ai` → эффект ставит один таймер
  useEffect(() => {
    if (ai === undefined || ai === null || !ai.jobActive) return;
    const timer = setTimeout(onChanged, 5000);
    return () => clearTimeout(timer);
  }, [ai, onChanged]);
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => j.slug === `${org}/${repo}`)) onChanged();
  });

  // без прав на полный Score текста нет (решение 22.09) — раздела нет
  if (ai === undefined) return null;

  // замечание 7 (25.09): обзора нет и он не формируется — заглушка в духе закрытого
  // Repo Health Score (серый фон, заголовок-состояние, одно основное действие);
  // переключателя автообновления нет, рамка градиента остается
  const empty = ai === null || (ai.overview === null && ai.specialists.length === 0 && !ai.jobActive);
  if (empty) {
    const cooldown = ai?.cooldownUntil != null && Date.parse(ai.cooldownUntil) > Date.now();
    const rejected = (ai?.failures ?? []).some((f) => !isNoFacts(f.reason));
    return (
      <section className="rh-ai-section rh-ai-section_empty" aria-labelledby="rh-ai-title" data-slot="aiSummary">
        <Flex direction="column" gap={1} alignItems="flex-start">
          <Text color="secondary" id="rh-ai-title" as="h2" className="rh-ai-section__label">
            {AI_SECTION_TITLE}
          </Text>
          {/* ревью В5.3 (25.09): генерация была, но ни одна роль не прошла проверку — не «пока нет» */}
          <Text variant="subheader-2">{rejected ? "Обзор не прошел проверку фактами" : "Обзора пока нет"}</Text>
          <Text variant="body-1" color="complementary">
            {canRun
              ? publicVersion
                ? "Модель перескажет оценку обычным языком по открытым данным – 4 категориям без CI/CD и Безопасности. На расчет обзор не влияет."
                : "Модель перескажет оценку обычным языком и разберет каждую категорию. На расчет обзор не влияет."
              : card.repo.visibility === "public"
                ? "Обзор может сформировать любой вошедший пользователь. Модель пересказывает оценку и на расчет не влияет."
                : "Обзор запускает владелец репозитория. Модель пересказывает оценку и на расчет не влияет."}
          </Text>
          {canRun && (
            <div className="rh-score-band__signin">
              <Button view="action" size="m" loading={actions.sending} disabled={cooldown || quotaBlocked !== null} onClick={() => void actions.start()}>
                <Button.Icon side="start">
                  <Icon data={Sparkles} size={16} className="rh-ai-button-icon" />
                </Button.Icon>
                {withCounter("Сформировать обзор", counter)}
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

  // В5.2 (Б3): переключатель автообновления удален; запуск — в меню «три точки».
  // Аудит дизайна О1: не-владельцу пункт нужен, только если после обзора был новый
  // анализ (иначе — холостой «уже готов»); нет пункта — нет и «⋮»
  const newerAnalysis = aiNotesStale(ai);
  // тур 3 В5.5 (круг 2, 26.09): в меню «⋮» был единственный пункт — вместо меню
  // иконка обновления с подсказкой; выключенная — причина в подсказке на обертке
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
    <Flex gap={2} alignItems="center">
      <ActionTooltip title={runDisabled ? runReason : runText}>{runDisabled ? <span className="rh-disabled-tip">{runButton}</span> : runButton}</ActionTooltip>
    </Flex>
  );

  const stamp =
    ai !== null && ai.generatedAt !== null && !jobActive ? (
      // замечание 25.09: подпись — отдельной строкой под текстом (сдвиг вправо отменен), цвет на ступень темнее
      <Text variant="caption-2" color="hint">
        {`Обзор от ${fmtDateTime(ai.generatedAt)}. ${AI_DISCLAIMER}`}
        {cooldownActive ? ` Следующий запуск – после ${fmtDateTime(ai.cooldownUntil)}.` : ""}
        {canRun && quotaBlocked !== null ? ` ${quotaBlocked}.` : ""}
      </Text>
    ) : null;

  return (
    // §2 25.09: готовый обзор — дымка Алисы в углах и тонкий градиентный контур; рамка
    // градиента движется только пока обзор формируется
    <section className={jobActive ? "rh-ai-section rh-ai-section_live" : "rh-ai-section"} aria-labelledby="rh-ai-title" aria-busy={jobActive} data-slot="aiSummary">
      <Flex direction="column" gap={3}>
        <Flex gap={2} alignItems="center" wrap>
          <span className="rh-ai-section__spark" aria-hidden="true">
            <Icon data={Sparkles} size={16} />
          </span>
          <Text variant="subheader-3" as="h2" id="rh-ai-title">
            {AI_SECTION_TITLE}
          </Text>
          {/* круг 3 тура 3: знак устаревания — сразу после заголовка */}
          {hasOverview && newerAnalysis && <AiStaleMark />}
          {model !== null && <AiModelLabel model={model} />}
          {/* выбор 2A (25.09): объем публичной версии — меткой в заголовке, пояснение в подсказке */}
          {publicVersion && hasOverview && (
            // UX-проход 25.09 (замечание 5): знак вопроса — внутри плашки
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

        {jobActive ? (
          // без обещания времени (§2-В5)
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
            {canRun ? "Обзора пока нет. Он пересказывает оценку обычным языком и на нее не влияет." : card.repo.visibility === "public" ? "Обзора пока нет – его может сформировать любой вошедший пользователь." : "Обзора пока нет – его запускает владелец репозитория."}
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

        {/* тур 3 В5.5 (п.10, 26.09): строки о непрошедших проверку разборах — ДО
            строки с датой обзора (дата закрывает блок) */}
        {failures.length > 0 && (
          <Flex direction="column" gap={1}>
            {failures.map((f) => (
              <Text key={f.role} variant="caption-2" color="secondary">
                {`Разбор «${aiRoleTitle(f.role)}» не прошел проверку фактами.`}
              </Text>
            ))}
          </Flex>
        )}

        {stamp}
      </Flex>
    </section>
  );
}

// ---------- разбор модели в категории (выбор 3-B) ----------

/** Заметка специалиста для категории; роли совпадают с ключами категорий. */
export function categoryAiNote(card: Card, key: string): AiNote | null {
  return card.ai?.specialists.find((n) => n.role === key) ?? null;
}

/**
 * Отметка в строке категории: искра серая — разбор появится после обзора,
 * фиолетовая — разбор есть (откройте категорию). Без прав (`card.ai`
 * undefined) и у категории без данных — отметки нет: модели нечего пояснять.
 */
export function CategoryAiMark({ card, categoryKey, hasData }: { card: Card; categoryKey: string; hasData: boolean }) {
  // замечание 8 (25.09): отметка — только когда разбор уже есть (серых «будет» нет)
  if (card.ai === undefined || !hasData || categoryAiNote(card, categoryKey) === null) return null;
  const title = "Есть разбор модели – откройте категорию";
  return (
    <span className="rh-cat-ai__mark rh-cat-ai__mark_ready" title={title} aria-label={title} role="img">
      <Icon data={Sparkles} size={14} />
    </span>
  );
}

/**
 * Текст модели в категории и разбор динамики (замечания 3, 6 от 25.09): стиль
 * info-плашки AI-обзора, без метки модели (она уже в заголовке обзора).
 */
/**
 * Тур 3 В5.5 (круг 2, 26.09, Екатерина): AI-текст сделан по НЕпоследнему
 * анализу — после него был новый, цифры в тексте могут не совпасть с карточкой.
 * Условие то же, что у пункта «Обновить обзор» для не-владельца (аудит О1).
 */
export function aiNotesStale(ai: Card["ai"]): boolean {
  return ai != null && ai.check.latestScanId !== null && ai.scanId < ai.check.latestScanId;
}

/**
 * Знак «текст устарел» у всех AI-плашек — сразу после заголовка. Круг 3 тура 3
 * (26.09, Екатерина): «говорящая» иконка — песочные часы «время вышло» в тоне
 * предупреждения (прежде — серые часы со стрелкой), подсказка зовет обновить.
 */
export function AiStaleMark() {
  return (
    <ActionTooltip title="Обзор устарел" description="Сделан по прошлому анализу – после него был новый, цифры в тексте могут не совпадать с карточкой. Обновите обзор.">
      <span className="rh-ai-stale" role="img" aria-label="Обзор устарел: сделан по прошлому анализу">
        <Icon data={HourglassEnd} size={18} />
      </span>
    </ActionTooltip>
  );
}

export function AiNotePlate({ title, text, stale = false }: { title: string; text: string; stale?: boolean }) {
  return (
    <Alert
      theme="info"
      view="filled"
      size="s"
      className="rh-ai-plate"
      icon={<Icon data={Sparkles} size={16} />}
      title={
        stale ? (
          <span className="rh-ai-plate__title">
            {title}
            <AiStaleMark />
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

export function CategoryAiNote({ note, stale = false }: { note: AiNote; stale?: boolean }) {
  return (
    <div className="rh-cat-ai">
      <AiNotePlate title="Разбор модели" text={note.text} stale={stale} />
    </div>
  );
}

// ---------- история оценки (выбор 3-B) + описания по анализам (4-A) ----------

const CHART_H = 160;
const PAD_L = 8;
const PAD_R = 28;
const PAD_T = 8;
const PAD_B = 22;

function yOf(v: number): number {
  return PAD_T + (1 - Math.max(0, Math.min(100, v)) / 100) * (CHART_H - PAD_T - PAD_B);
}

/** Ширина контейнера графика (замечание 4, 25.09): viewBox = реальная ширина — график на всю колонку без искажения точек и подписей. */
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

function HistoryChart({ points, fullOpen }: { points: HistoryPoint[]; fullOpen: boolean }) {
  const [wrapRef, CHART_W] = useWidth();
  const times = points.map((p) => (p.finishedAt === null ? NaN : Date.parse(p.finishedAt)));
  const known = times.filter((t) => Number.isFinite(t));
  const t0 = Math.min(...known);
  const t1 = Math.max(...known);
  // ось X — время анализа (О12); без разброса времени — равномерно
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
  const hci = points.map((p) => p.healthcraftIndex);
  const rhs = fullOpen ? points.map((p) => p.repoHealthScore) : null;
  // подписи оси: за короткий период (меньше 36 ч) — время, иначе дата; подпись,
  // наезжающая на соседнюю (ближе 90 px), не ставится — первая и последняя остаются
  const short = Number.isFinite(t1 - t0) && t1 - t0 < 36 * 3600_000;
  const axisText = (iso: string | null): string => (short ? fmtDateTime(iso).split(" ")[0]! : fmtDate(iso));
  const candidates = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const labelIdx: number[] = [];
  for (const i of candidates) {
    const last = labelIdx[labelIdx.length - 1];
    if (last !== undefined && Math.abs(xOf(i) - xOf(last)) < 90) {
      if (i === points.length - 1) labelIdx[labelIdx.length - 1] = i;
      continue;
    }
    labelIdx.push(i);
  }
  if (labelIdx.length === 1 && points.length > 1 && Math.abs(xOf(0) - xOf(points.length - 1)) >= 90) labelIdx.unshift(0);
  return (
    <div ref={wrapRef} className="rh-history__chart-wrap">
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width={CHART_W} height={CHART_H} role="img" aria-label="HealthCraft Index по датам анализов, пороги 40 и 70" className="rh-history__chart">
      {[40, 70].map((g) => (
        <g key={g}>
          <line x1={PAD_L} x2={CHART_W - PAD_R} y1={yOf(g)} y2={yOf(g)} stroke="var(--g-color-line-generic)" strokeDasharray="4 4" />
          <text x={CHART_W - PAD_R + 6} y={yOf(g) + 4} fontSize={11} fill="var(--g-color-text-secondary)">
            {g}
          </text>
        </g>
      ))}
      <line x1={PAD_L} x2={CHART_W - PAD_R} y1={yOf(0)} y2={yOf(0)} stroke="var(--g-color-line-generic)" />
      {rhs !== null && <path d={path(rhs)} fill="none" stroke="var(--g-color-text-secondary)" strokeWidth={1.5} strokeDasharray="4 3" />}
      <path d={path(hci)} fill="none" stroke="var(--g-color-text-primary)" strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) =>
        p.healthcraftIndex === null ? null : (
          <circle key={p.scanId} cx={xOf(i)} cy={yOf(p.healthcraftIndex)} r={3} fill={p.codeEmpty ? "var(--g-color-text-secondary)" : "var(--g-color-text-primary)"}>
            <title>
              {`${fmtDateTime(p.finishedAt)} · HealthCraft Index ${fmtScore(p.healthcraftIndex)}` +
                (rhs !== null ? ` · Repo Health Score ${fmtScore(p.repoHealthScore)}` : "") +
                (p.headSha ? ` · коммит ${p.headSha.slice(0, 7)}` : "") +
                (p.codeEmpty ? " · пустой репозиторий" : "")}
            </title>
          </circle>
        ),
      )}
      {labelIdx.map((i) => (
        <text key={i} x={xOf(i)} y={CHART_H - 6} fontSize={11} fill="var(--g-color-text-secondary)" textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
          {axisText(points[i]!.finishedAt)}
        </text>
      ))}
    </svg>
    </div>
  );
}

function AnalysisRow({ point, fullOpen, overview }: { point: HistoryPoint; fullOpen: boolean; overview: AiNoteHistoryItem | null }) {
  return (
    <li className="rh-history__row">
      <div className="rh-history__line">
        <Text variant="body-1">{fmtDateTime(point.finishedAt)}</Text>
        <Text variant="body-1" color="secondary">{`HealthCraft Index ${fmtScore(point.healthcraftIndex)}`}</Text>
        {fullOpen && <Text variant="body-1" color="secondary">{`Repo Health Score ${fmtScore(point.repoHealthScore)}`}</Text>}
        {point.headSha && (
          <Flex gap={0} alignItems="center">
            <Text variant="body-1" color="secondary">{`коммит ${point.headSha.slice(0, 7)}`}</Text>
            <ClipboardButton text={point.headSha} size="xs" view="flat-secondary" tooltipInitialText="Скопировать хеш коммита" tooltipSuccessText="Скопировано" />
          </Flex>
        )}
        {point.codeEmpty && (
          <Label theme="normal" size="xs">
            пустой репозиторий
          </Label>
        )}
        {/* замечание 5 (25.09): описание на момент анализа — иконкой в правом углу строки, текст в подсказке */}
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
            <span className="rh-history__note-mark" role="button" tabIndex={0} aria-label="Описание на момент анализа">
              <Icon data={Sparkles} size={16} />
            </span>
          </Popover>
        )}
      </div>
    </li>
  );
}

export function HistorySection({ card, org, repo }: { card: Card; org: string; repo: string }) {
  // описания по анализам — только зрителю с правами (сервер закрывает /ai-notes сам)
  return card.ai !== undefined ? <HistoryWithNotes card={card} org={org} repo={repo} /> : <HistoryBody card={card} org={org} repo={repo} notes={null} />;
}

function HistoryWithNotes({ card, org, repo }: { card: Card; org: string; repo: string }) {
  const { state, reload } = useJson<AiNotesResponse>(`${apiBase(org, repo)}/ai-notes`);
  // Ф2 (25.09): описания по анализам перечитываются по итогу задания этого репо
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => j.slug === `${org}/${repo}`)) reload();
  });
  return <HistoryBody card={card} org={org} repo={repo} notes={dataOf(state)} />;
}

function HistoryBody({ card, org, repo, notes }: { card: Card; org: string; repo: string; notes: AiNotesResponse | null }) {
  const { state, reload } = useJson<HistoryResponse>(`${apiBase(org, repo)}/history`, { keepPrevious: true });
  // Ф2 (25.09): новая точка истории появляется без F5 — по итогу задания этого репо
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => j.slug === `${org}/${repo}`)) reload();
  });
  const data = dataOf(state);
  const [listOpen, setListOpen] = useState(false);
  // ревью В5.3 (25.09): пока история не пришла или не загрузилась — не «оценок нет»
  // (429 в общем окне карточки или перечитывание после анализа печатали ложное пустое состояние)
  if (data === null) {
    return (
      <section className="rh-section" aria-labelledby="rh-history-title" data-slot="scoreHistory" aria-busy={state.kind === "loading"}>
        <Card view="outlined" className="rh-section-card rh-placeholder-card">
          <Flex direction="column" gap={2} alignItems="flex-start">
            <Text color="secondary" as="h2" id="rh-history-title" className="rh-ai-section__label">
              {SLOT_EMPTY.scoreHistory.title}
            </Text>
            {state.kind === "error" ? (
              <>
                <Text variant="body-1" color="complementary">{`История не загрузилась: ${state.message}`}</Text>
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
  const list = points.length > 0 && (
    <Disclosure size="m" expanded={listOpen} onUpdate={setListOpen} summary={`Все анализы (${points.length})`}>
      {caption && (
        <Text variant="caption-2" color="secondary">
          {caption}
        </Text>
      )}
      <ul className="rh-history__list">
        {[...points].reverse().map((p) => (
          <AnalysisRow key={p.scanId} point={p} fullOpen={fullOpen} overview={overviewByScan.get(p.scanId) ?? null} />
        ))}
      </ul>
    </Disclosure>
  );
  if (!view.chart) {
    // замечание 6 (25.09): графика нет — серая заглушка, как у пустого AI-обзора
    return (
      <section className="rh-section" aria-labelledby="rh-history-title" data-slot="scoreHistory">
        <Card view="outlined" className="rh-section-card rh-placeholder-card">
          <Flex direction="column" gap={1} alignItems="flex-start">
            <Text color="secondary" as="h2" id="rh-history-title" className="rh-ai-section__label">
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
        {/* замечание 7 (25.09): график, разбор и список — с воздухом между собой */}
        <Flex direction="column" gap={5} className="rh-history">
          <Flex direction="column" gap={2}>
            <HistoryChart points={points} fullOpen={fullOpen} />
            <Flex gap={4} wrap>
              <Text variant="caption-2" color="secondary">
                <span className="rh-history__key rh-history__key_index" aria-hidden="true" /> {view.count}
              </Text>
              <Text variant="caption-2" color="secondary">
                {fullOpen && <span className="rh-history__key rh-history__key_full" aria-hidden="true" />} {view.full}
              </Text>
            </Flex>
          </Flex>
          {trajectory !== null && <AiNotePlate title="Разбор динамики" text={trajectory.text} stale={aiNotesStale(card.ai)} />}
          {list}
        </Flex>
      </Card>
    </section>
  );
}

// ---------- бейдж для README (выбор 5-A) ----------

/**
 * Бейдж для README. Тур 3 В5.5 (п.4, 26.09, Екатерина): кнопка у ЛЮБОГО публичного
 * репозитория рейтинга, не только у своего (вытесняет замечание 9 от 25.09 —
 * «только у своего»): маршрут SVG и так открыт всем (К5.8), бейдж чужого репо
 * годится для подборок, статей и форков. Приватному и internal кнопки нет:
 * публичный маршрут отвечает им 404 — проверка ниже.
 */
export function BadgeButton({ org, repo, publicBaseUrl }: { org: string; repo: string; publicBaseUrl: string }) {
  const path = `/api/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    setOk(false);
    // бейдж выдается только публичным репозиториям из рейтинга: 404 — кнопки нет (О6)
    fetch(`${path}/badge.svg`, { signal: ctrl.signal })
      .then((res) => setOk(res.ok))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [path]);
  if (!ok) return null;
  const code = badgeMarkdown(publicBaseUrl, org, repo);
  return (
    <Popover
      trigger="click"
      placement={["bottom-end", "top-end"]}
      content={
        <div className="rh-badge-pop" data-slot="badge">
          <Text variant="subheader-1" as="div">
            {SLOT_EMPTY.badge.title}
          </Text>
          <div className="rh-badge-pop__preview">
            <img src={`${path}/badge.svg`} alt="HealthCraft Index" />
          </div>
          <Text variant="caption-2" color="secondary" as="div">
            Markdown
          </Text>
          <TextInput size="m" readOnly value={code} aria-label="Код бейджа для README" endContent={<ClipboardButton text={code} size="s" view="flat-secondary" tooltipInitialText="Скопировать" tooltipSuccessText="Скопировано" />} />
          <Link href={`${publicBaseUrl.replace(/\/+$/, "")}${path}`} target="_blank" rel="noreferrer">
            Данные в JSON
          </Link>
        </div>
      }
    >
      <Button view="normal" size="m">
        <Button.Icon side="start">
          <Icon data={SealCheck} size={16} />
        </Button.Icon>
        Бейдж для README
      </Button>
    </Popover>
  );
}
