// RepoV5.tsx — элементы В5 на карточке репозитория, переверстанные кругом 3
// вехи В5.3 по дизайн-аудиту (reports/2026-09-24-m53-ui-design-audit.md) и
// выбору владельца (TASK.md §2 24.09 «В5.3, круг 3»):
//   - флаг фрода — предупреждение над показателями, текст фактора строит код (6-A, способ 2);
//   - AI-обзор — раздел сразу под показателями в рамке градиента Алисы (2-A);
//     разбор модели по категориям — в раскрытии категории, отметка в строке (3-B + плашка);
//   - история оценки — раздел ленты: ось времени, пороги, список анализов (3-B),
//     описание на момент анализа — в строке анализа (4-A);
//   - бейдж для README — кнопка в шапке с поповером, как Clone у SourceCraft (5-A).
// Видимость текстов модели — прежняя (решение 22.09): `card.ai` приходит только
// зрителю с правами на полный Score; без прав этих блоков нет вовсе.
import { ChevronDown, EllipsisVertical, SealCheck, Sparkles } from "@gravity-ui/icons";
import {
  Alert,
  Button,
  Card,
  ClipboardButton,
  Disclosure,
  DropdownMenu,
  Flex,
  HelpMark,
  Icon,
  Label,
  Link,
  Popover,
  Skeleton,
  Switch,
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
  fraudFactorTitle, AI_DISCLAIMER, AI_OVERVIEW_REJECTED
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

export function FraudAlert({ card }: { card: Card }) {
  const fraud = card.ai?.fraud;
  // подозрение — только при флаге, как в кабинете и отчете
  if (fraud === undefined || fraud === null || fraud.flag !== true || fraud.factors.length === 0) return null;
  const factOf = (key: string): unknown => fraudFactorValue(key, fraud.signals, card.evidence);
  // вариант B (25.09): одна строка — заголовок и главный признак; пояснение и
  // остальные признаки — в подсказке; формулировка модели — только в отчете.
  // Признак — строка кода из факта (способ 2), без факта — формулировка модели
  const lines = fraud.factors.flatMap((f) => (fraudFactorFact(f.key, factOf(f.key)) ?? f.note).split("; "));
  const [lead, ...rest] = lines;
  return (
    // замечание 1 (25.09): желтый фон, как у прочих предупреждений; без кнопки перехода
    <Alert
      theme="warning"
      view="filled"
      size="s"
      align="center"
      className="rh-fraud"
      message={
        <span className="rh-fraud__line">
          <Text variant="subheader-1">{`${FRAUD_TITLE}: `}</Text>
          <Text variant="body-1">{lead}</Text>
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
      }
    />
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

function useSummaryActions(org: string, repo: string, onChanged: () => void) {
  const toaster = useToaster();
  const [sending, setSending] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const start = async (): Promise<void> => {
    setSending(true);
    try {
      const res = await fetch(`${apiBase(org, repo)}/summary`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { jobId?: number | null; cached?: boolean; scanQueued?: boolean; error?: { message?: string } } | null;
      if (!res.ok) {
        toaster.add({ name: `summary-fail:${org}/${repo}`, theme: "danger", title: "Обзор не запущен", content: body?.error?.message ?? `Ошибка ${res.status}` });
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
  // 23.09 (Алексей): тумблер — только политика автогенерации на будущие анализы, заявок не ставит
  const setAuto = async (on: boolean): Promise<void> => {
    setAutoBusy(true);
    try {
      const res = await fetch(`${apiBase(org, repo)}/summary-auto`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toaster.add({ name: `summary-auto-fail:${org}/${repo}`, theme: "danger", title: "Режим не изменен", content: err?.error?.message ?? `Ошибка ${res.status}` });
        return;
      }
      onChanged();
    } finally {
      setAutoBusy(false);
    }
  };
  return { sending, autoBusy, start, setAuto };
}

export function AiOverviewSection({ card, org, repo, onChanged }: { card: Card; org: string; repo: string; onChanged: () => void }) {
  const ai = card.ai;
  const own = card.viewer?.own === true;
  const actions = useSummaryActions(org, repo, onChanged);

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
            {own
              ? "Модель перескажет оценку обычным языком и разберет каждую категорию. На расчет обзор не влияет."
              : "Обзор запускает владелец репозитория. Модель пересказывает оценку и на расчет не влияет."}
          </Text>
          {own && (
            <div className="rh-score-band__signin">
              <Button
                view="action"
                size="m"
                loading={actions.sending}
                disabled={cooldown}
                title={cooldown && ai ? `Следующий запуск – после ${fmtDateTime(ai.cooldownUntil)}` : undefined}
                onClick={() => void actions.start()}
              >
                <Button.Icon side="start">
                  <Icon data={Sparkles} size={16} className="rh-ai-button-icon" />
                </Button.Icon>
                Сформировать обзор
              </Button>
            </div>
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

  // замечание 2 (25.09): на виду — переключатель автообновления; запуск — в меню «три точки»
  const ownerActions = own && ai !== null && (
    <Flex gap={2} alignItems="center">
      <Switch size="m" checked={ai.optIn} disabled={actions.autoBusy} onUpdate={(on) => void actions.setAuto(on)} content="Обновлять после каждого анализа" />
      <DropdownMenu
        renderSwitcher={(props) => (
          <Button {...props} view="flat-secondary" size="s" aria-label="Действия с обзором" loading={actions.sending}>
            <Icon data={EllipsisVertical} size={14} />
          </Button>
        )}
        items={[
          {
            text: hasOverview ? "Обновить обзор" : "Сформировать обзор",
            disabled: jobActive || cooldownActive || actions.sending,
            action: () => void actions.start(),
          },
        ]}
      />
    </Flex>
  );

  const stamp =
    ai !== null && ai.generatedAt !== null && !jobActive ? (
      // замечание 25.09: подпись — отдельной строкой под текстом (сдвиг вправо отменен), цвет на ступень темнее
      <Text variant="caption-2" color="hint">
        {`Обзор от ${fmtDateTime(ai.generatedAt)}. ${AI_DISCLAIMER}`}
        {cooldownActive ? ` Следующий запуск – после ${fmtDateTime(ai.cooldownUntil)}.` : ""}
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
          {model !== null && <AiModelLabel model={model} />}
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
              Обзор формируется – раздел обновится сам.
            </Text>
          </Flex>
        ) : ai === null || (!hasOverview && specialists.length === 0) ? (
          <Text variant="body-1" color="complementary">
            {own ? "Обзора пока нет. Он пересказывает оценку обычным языком и на нее не влияет." : "Обзора пока нет – его запускает владелец репозитория."}
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

        {stamp}

        {failures.length > 0 && (
          <Flex direction="column" gap={1}>
            {failures.map((f) => (
              <Text key={f.role} variant="caption-2" color="secondary">
                {`Разбор «${aiRoleTitle(f.role)}» не прошел проверку фактами.`}
              </Text>
            ))}
          </Flex>
        )}

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
export function AiNotePlate({ title, text }: { title: string; text: string }) {
  return (
    <Alert
      theme="info"
      view="filled"
      size="s"
      className="rh-ai-plate"
      icon={<Icon data={Sparkles} size={16} />}
      title={title}
      message={
        <div className="rh-ai-plate__text">
          <AiText text={text} />
        </div>
      }
    />
  );
}

export function CategoryAiNote({ note }: { note: AiNote }) {
  return (
    <div className="rh-cat-ai">
      <AiNotePlate title="Разбор модели" text={note.text} />
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
          {trajectory !== null && <AiNotePlate title="Разбор динамики" text={trajectory.text} />}
          {list}
        </Flex>
      </Card>
    </section>
  );
}

// ---------- бейдж для README (выбор 5-A) ----------

/**
 * Замечание 9 (25.09): бейдж ставит в README тот, кто этот README ведет, — кнопка
 * только у своего репозитория (бейджи CI у GitLab/GitHub выдаются в настройках
 * проекта, не посетителю). Публичный маршрут SVG открыт всем (К5.8).
 */
export function BadgeButton({ org, repo, publicBaseUrl, own }: { org: string; repo: string; publicBaseUrl: string; own: boolean }) {
  if (!own) return null;
  return <BadgeButtonOwn org={org} repo={repo} publicBaseUrl={publicBaseUrl} />;
}

function BadgeButtonOwn({ org, repo, publicBaseUrl }: { org: string; repo: string; publicBaseUrl: string }) {
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
