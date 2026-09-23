// RepoPage.tsx — единая карточка репозитория (план §5 В3 + К2 В4.1):
// HealthCraft Index и полный Repo Health Score (В4.3), шесть категорий с
// раскрытием submetrics, маркеры и рекомендации с доказательствами. Состав ответа
// собирает сервер по доступу зрителя: закрытые ему блоки CI/Security
// приходят без чисел и показываются заглушкой по причине доступа.
// Главное правило экрана — трекер-закон в UI: ни одной фразы без факта
// либо без честного объяснения, почему факта нет.
//
// В4.9, часть 2 гейта, круг 1 (U1-A): табов нет — страница читается одной
// лентой по линии PDF: шапка → предупреждения → показатели и вклад категорий →
// «Категории» с основанием → «Рекомендации» → «Ограничения данных» →
// карточки «готовится». Все утверждения о данных собирает view-модель
// `cardView.ts` из тех же функций, что отчет (инвариант 1). Правая панель —
// паспорт анализа и короткая справка (U4-A); ниже 1440 она выезжает по кнопке
// «Как считается» (U5-a).
import { lastRatingHref } from "./ratingReturn";
import {
  ArrowDownToLine,
  ArrowsRotateRight,
  ArrowUpRightFromSquare,
  Bug,
  Calendar,
  CalendarXmark,
  ChevronDown,
  Circle,
  CircleCheck,
  Clock,
  ClockArrowRotateLeft,
  CodeCommits,
  CodeFork,
  CodePullRequest,
  Comment,
  CommentSlash,
  Copy,
  FileText,
  Flag,
  FolderTree,
  Hashtag,
  Heart,
  Hourglass,
  Key,
  LogoMarkdown,
  PersonGear,
  Persons,
  Pipeline,
  Pulse,
  Rocket,
  ScalesBalanced,
  ShieldCheck,
  SquareCheck,
  SquareListUl,
  Star,
  StarFill,
  Stopwatch,
  Thunderbolt,
} from "@gravity-ui/icons";
import type { IconData } from "@gravity-ui/uikit";
import {
  ActionTooltip,
  Alert,
  ArrowToggle,
  Button,
  Card,
  DefinitionList,
  DropdownMenu,
  Flex,
  HelpMark,
  Icon,
  Label,
  Link,
  Popover,
  Progress,
  Spin,
  Text,
  useToaster,
} from "@gravity-ui/uikit";
import { useEffect, useState } from "react";
import { COVERAGE_NULL_BELOW } from "../score/model";
import { displayOnly, submetricContext, submetricNote, submetricShownValue, submetricTitle } from "../report/submetrics";
import { submetricWeightText } from "../report/sections";
import type { MetaResponse, RepoCard } from "./api";
import { dataOf, mutateJson, useJson, useVisible } from "./api";
import { cardView, factSource, type CardView, type CategoryView, type RecommendationView } from "./cardView";
import { announceJobStarted, announceJobsChanged, useAnalysis, useAnalysisFinished, useSession } from "./session";
import {
  NO_DATA,
  NO_SCORE,
  reportFailureText,
  favoriteAddedText,
  type FavoriteAddCheck,
  type PathPart,
  SECURITY_PUBLIC_NOTE,
  fmtCount,
  fmtCoverage,
  fmtDate,
  fmtDateTime,
  fmtFactValue,
  fmtNumber,
  fmtScore,
  fmtSubmetric,
  noScoreText,
  reportFileName,
  scanStatusText,
  scanTriggerText,
  DEFINITION_NAME_WIDTH,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  sentence,
  slugOf,
} from "./format";
import { linkProps } from "./router";
import { LoginButton, Page, type Crumb } from "./Shell";
import { SLOT_EMPTY } from "./slots";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, RepoAvatar, RepoSlug, ScoreLegend, SkeletonRows, VisibilityPill } from "./ui";

type Card = RepoCard;
type Evidence = Card["evidence"][number];

export function RepoPage({ org, repo, meta }: { org: string; repo: string; meta: MetaResponse | null }) {
  const slug = `${org}/${repo}`;
  const cardUrl = `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  // В4.8.5 (К8.5.3): перечитывание не мигает скелетоном — прежние данные на
  // экране, пока не придёт новый ответ; сбой перечитывания — мягкая пометка
  const { state, reload } = useJson<Card>(cardUrl, { keepPrevious: true });
  const { me, reloadMe } = useSession();
  const meData = dataOf(me);
  const loggedIn = meData !== null && meData.login !== null;
  // В4.8.5 (К8.5.1): фаза анализа — из общего опроса заданий вкладки (по
  // заданию, а не по «появился ли скан с номером больше»); карточка сама
  // себя ради итога не опрашивает
  const analysis = useAnalysis();
  const live = analysis.live(slug);
  const start = useStartAnalysis(org, repo);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  useAnalysisFinished((jobs) => {
    const mine = jobs.find((j) => j.slug === slug);
    if (!mine) return;
    reload();
    // Ф2.20: звезда светится один раз после УСПЕШНОГО своего анализа
    if (mine.phase === "done") setDoneKey(`${slug}:${mine.jobId}`);
  });

  const data = dataOf(state);
  // А1: прокрутка к «Рекомендациям» по якорю и старому `?tab=` — после загрузки
  useRecommendationsAnchor(data !== null && data.score !== null, slug);
  // В4.8.5 (К8.5.14 (а), (в); §2-В1, §2-Р2): анализ — только своего
  // репозитория. «Свой» карточка считает сама по доступу, который она и так
  // резолвит при показе (`viewer.own`), — кнопка есть на любом своём
  // репозитории, даже не в избранном; чужой, аноним, неизвестно — кнопки нет
  // вовсе (элемента нет, а не неактивен)
  const canRefresh = data?.viewer?.own === true && data.viewer.auth === "pat";
  // К8.5.8: сервер не видит сессии, а вкладка считает зрителя вошедшим —
  // сессия истекла или вышли в соседней вкладке: приложение перечитывает /api/me
  const sessionGone = loggedIn && data?.viewer?.auth === "no-session";
  useEffect(() => {
    if (sessionGone) reloadMe();
  }, [sessionGone, reloadMe]);
  // С6-3: у карточки идёт чужой или периодический скан — она показывает «идёт
  // анализ» и изредка перечитывает себя (окно открытий карточки 30/мин не
  // съедается: раз в 30 с). Круг 2 (Н5): в скрытой вкладке — пауза
  const foreignRunning = data !== null && data.scan?.status === "running" && live === null && data.job === null;
  const visible = useVisible();
  useEffect(() => {
    if (!foreignRunning || !visible) return;
    const timer = setInterval(() => reload(), 30_000);
    return () => clearInterval(timer);
  }, [foreignRunning, visible, reload]);

  // Ступень 4 (В-10): крошка — на последнюю выдачу рейтинга (фильтр, сортировка, страница)
  const crumbs: Crumb[] = [{ text: "Рейтинг", href: lastRatingHref() }, { text: `${org} / ${repo}` }];
  const own = live ?? (data?.job ? { phase: data.job.status, stalled: data.job.stalled } : null);
  const jobStalled = own?.stalled === true;
  const analysisRunning = own !== null;
  const refreshButton = canRefresh && (
    <Button view="action" size="m" onClick={start.start} disabled={analysisRunning || start.sending} loading={start.sending}>
      {/* Доводка 21.09: спиннер живёт в слоте `Button.Icon`, а не голым узлом
          рядом с текстом. Слот сам держит габарит в высоту кнопки и гасит
          паддинг отрицательным полем (`.g-button__icon`); голый `Spin` был
          обычным inline-block и вставал к тексту вплотную — крутящееся кольцо
          налезало на первую букву. */}
      {analysisRunning && (
        <Button.Icon side="start">
          <Spin size="xs" />
        </Button.Icon>
      )}
      {analysisRunning ? "Идет анализ" : "Обновить анализ"}
    </Button>
  );

  if (data === null && state.kind !== "error") {
    return (
      // В4.6 (У27): ритм скелетона = ритм содержимого — блок-полоса величины
      // (~150px) и шесть строк категорий по 45px, панель начинается с легенды
      <Page crumbs={crumbs} aside={<SkeletonRows rows={3} height={96} />} asideDrawer>
        <Flex direction="column" gap={3}>
          <SkeletonRows rows={1} height={150} />
          <SkeletonRows rows={6} height={45} />
        </Flex>
      </Page>
    );
  }
  if (data === null) {
    // UX-5 (круг 2 В4.4): «Обновить анализ» на странице ошибки скрыт; повтор —
    // «Повторить» (reload)
    return (
      <Page crumbs={crumbs}>
        <Alert
          theme="danger"
          view="outlined"
          className="rh-break-anywhere"
          title={`Не удалось открыть ${slugOf(org, repo)}`}
          message={state.kind === "error" ? state.message : undefined}
          // В4.8.5 (К8.5.4, С6-6): «Повторить» — только там, где повтор может помочь;
          // на постоянном 404/400 он повторял бы тот же отказ
          actions={state.kind === "error" && (state.status === 404 || state.status === 400) ? undefined : [{ text: "Повторить", handler: reload }]}
        />
      </Page>
    );
  }

  const card = data;
  const view = cardView(card);
  const reportHref = `${cardUrl}/report.md`;
  const refreshError = state.kind === "ok" ? state.refreshError : undefined;
  const actions = (
    <Flex gap={2} alignItems="center">
      {card.score !== null && <ReportMenu mdHref={reportHref} pdfHref={`${cardUrl}/report.pdf`} pdfName={reportFileName(org, repo, "pdf")} />}
      {refreshButton}
    </Flex>
  );

  return (
    <Page crumbs={crumbs} actions={actions} aside={<ScoreAside card={card} meta={meta} analysis={own} foreignRunning={foreignRunning} />} asideDrawer>
      {/* К8.5.3: перечитывание не удалось — данные остаются, пометка видна */}
      {refreshError && (
        <div style={{ marginBottom: "var(--g-spacing-3)" }}>
          <Alert
            theme="warning"
            view="outlined"
            size="s"
            message={`Данные могли устареть: обновить карточку не удалось – ${refreshError}`}
            actions={[{ text: "Повторить", handler: reload }]}
          />
        </div>
      )}
      <Header card={card} view={view} starDoneKey={doneKey} starLoggedIn={meData === null ? null : loggedIn} />
      {card.score === null ? (
        own !== null || foreignRunning ? (
          // Ф2.15 + К8.5.1 (С6-3): идёт анализ — свой или чужой/периодический;
          // без обещания времени (§2-В5)
          <EmptyState
            icon={SquareListUl}
            title={own?.phase === "queued" ? "Анализ запланирован" : "Идет анализ"}
            description={
              (own?.phase === "queued"
                ? "Заявка стоит в очереди – ее возьмут в работу, и здесь появится итог."
                : "Данные собираются – итог появится здесь.") +
              // UX-10 (круг 2 В4.4): заметка, когда задание зависло (признак сервера)
              (jobStalled ? " Анализ затянулся – его итог появится в «Заданиях»." : "")
            }
          />
        ) : (
          // В4.4 (кластер E): «скана не было» ≠ «скан был — сбой/мало данных»;
          // CTA — по возможностям зрителя (запуск/токен/объяснение)
          // Д3 (В4.9): текст пустого состояния — общий с отчетом (`noScoreText`)
          <EmptyState
            icon={SquareListUl}
            title={noScoreText(card.scan).title}
            description={noScoreText(card.scan).description}
            actions={
              canRefresh
                ? [{ text: card.scan ? "Повторить анализ" : "Запустить анализ", view: "action", size: "l", onClick: start.start }]
                : card.viewer?.auth === "no-pat"
                  ? [
                      // В4.8.5 (К8.5.14 (ж)): без токена «свой» не известен — CTA
                      // не обещает анализ (прежний CTA звал к анализу без токена): токен
                      // открывает CI/CD и Security, анализ — только своих
                      { text: "Добавить токен в Настройках", view: "action", size: "l", href: "/settings" },
                    ]
                  : undefined
            }
          />
        )
      ) : (
        // А1 (U1-A): одна лента по линии PDF, табов нет
        <Flex direction="column" gap={6}>
          <Flex direction="column" gap={3}>
            <Markers view={view} />
            <ScoreBand card={card} view={view} />
          </Flex>
          <Categories card={card} view={view} />
          <Recommendations view={view} />
          <Limitations items={view.limitations} />
          <CardSlots />
        </Flex>
      )}
    </Page>
  );
}

/**
 * «Отчёт»: формат выбирается в меню. MD — тот же генератор, что рисует
 * страницу (§2.3); PDF (В4.7, П1) — та же модель отчёта, отрисованная
 * сервером. PDF качается через `fetch` + blob: на сбое сервер отвечает
 * JSON-ошибкой, и зритель видит её тостом, а не пустой файл; пункт MD
 * от этого не зависит.
 */
/** Сбой выгрузки: HTTP-статус (0 — сети нет) и код сервера — для текста тоста. */
class ReportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`report ${status}`);
  }
}

function ReportMenu({ mdHref, pdfHref, pdfName }: { mdHref: string; pdfHref: string; pdfName: string }) {
  const toaster = useToaster();
  const [busy, setBusy] = useState<"md" | "pdf" | null>(null);
  const mdName = pdfName.replace(/\.pdf$/, ".md");
  // В4.8.5 (К8.5.11, С7-1): обе выгрузки — fetch + blob; любой сбой — тост в
  // приложении (раньше MD открывался ссылкой, и 429/404/500 заменяли
  // приложение сырым JSON). Текст тоста — по коду (reportFailureText)
  const download = async (kind: "md" | "pdf"): Promise<void> => {
    setBusy(kind);
    const href = kind === "md" ? mdHref : pdfHref;
    const expected = kind === "md" ? "text/markdown" : "application/pdf";
    try {
      let res: Response;
      try {
        res = await fetch(href);
      } catch {
        throw new ReportError(0, null);
      }
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith(expected)) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        throw new ReportError(res.ok ? 500 : res.status, body?.error?.code ?? null);
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = kind === "md" ? mdName : pdfName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      const status = e instanceof ReportError ? e.status : 500;
      const code = e instanceof ReportError ? e.code : null;
      toaster.add({
        name: `report-${kind}-failed:${href}`,
        theme: "danger",
        title: kind === "md" ? "Markdown не скачан" : "PDF не скачан",
        content: reportFailureText(kind, status, code),
      });
    } finally {
      setBusy(null);
    }
  };
  const pdfBusy = busy === "pdf";
  return (
    <DropdownMenu
      size="m"
      popupProps={{ placement: "bottom-end" }}
      renderSwitcher={(props) => (
        // В4.7 круг 2 (Р2.4): пока PDF собирается, кнопка показывает спиннер
        <Button {...props} view="normal" size="m" aria-haspopup="menu" loading={busy !== null}>
          <Icon data={ArrowDownToLine} size={16} />
          Отчет
          <Icon data={ChevronDown} size={16} />
        </Button>
      )}
      items={[
        { text: "Markdown (.md)", iconStart: <Icon data={LogoMarkdown} size={16} />, disabled: busy !== null, action: () => void download("md") },
        { text: pdfBusy ? "PDF (.pdf) – готовим…" : "PDF (.pdf)", iconStart: <Icon data={FileText} size={16} />, disabled: busy !== null, action: () => void download("pdf") },
      ]}
    />
  );
}

/**
 * «Обновить анализ» — запуск (К2, К3: сервер проверяет доступ PAT до
 * постановки). В4.8.5 (К8.5.1): итог узнаётся не опросом карточки, а общим
 * опросом заданий вкладки (session.tsx) — по номеру задания; тост об итоге
 * даёт он же, из любого экрана. Здесь — только отправка и её исход; повторный
 * клик на время отправки заблокирован (С4-13).
 */
function useStartAnalysis(org: string, repo: string): { sending: boolean; start: () => void } {
  const [sending, setSending] = useState(false);
  const toaster = useToaster();
  const analysis = useAnalysis();

  const start = () => {
    if (sending) return;
    setSending(true);
    void mutateJson<{ queued?: boolean; jobId?: number; deduplicated?: boolean }>(`/api/me/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/scan`, "POST")
      .then((res) => {
        // круг 2 (Н5): итог этого задания объявится и в ответе базовой линии опроса
        announceJobStarted(res?.jobId);
        // задание уже стояло (повтор, потерянный ответ, другая вкладка) — не «запущен заново»
        toaster.add({
          name: `scan-queued:${org}/${repo}`,
          theme: "info",
          title: res.deduplicated ? "Анализ уже идет" : "Анализ в очереди",
          content: "Итог придет уведомлением – можно уйти со страницы.",
        });
      })
      .catch((e: unknown) => {
        toaster.add({ name: `scan-failed:${org}/${repo}`, theme: "danger", title: "Анализ не запущен", content: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        setSending(false);
        // С9-16: даже если ответ потерян, задание могло встать — узнаём у сервера
        announceJobsChanged();
        analysis.refresh();
      });
  };

  return { sending, start };
}

function Header({ card, view, starDoneKey, starLoggedIn }: { card: Card; view: CardView; starDoneKey: string | null; starLoggedIn: boolean | null }) {
  const { repo: r } = card;
  return (
    <div className="rh-card-head">
      {/* аватар l (42px) ровно на высоту блока «название 24 + мета 16» */}
      <div className="rh-repo-head">
        <RepoAvatar repo={r.repo} logoUrl={r.logoUrl} size="l" />
        <Flex direction="column" justifyContent="space-between" style={{ minWidth: 0 }}>
          <Flex gap={2} alignItems="center" wrap className="rh-card-head__title">
            {/* В4.6 (У27): тот же компонент слага, что в строке рейтинга */}
            <RepoSlug org={r.org} repo={r.repo} variant="header-1" />
            {/* В4.9 ч.2 (А7, U6-1 с поправкой владельца): видимость SourceCraft —
                той же плашкой, что в избранном; «неизвестно» плашки не дает */}
            <VisibilityPill value={view.visibility} />
            <Flex gap={1} alignItems="center">
              <FavoriteStar org={r.org} repo={r.repo} doneKey={starDoneKey} loggedIn={starLoggedIn} />
              <ActionTooltip title="Открыть на sourcecraft.dev">
                <Button
                  view="flat-secondary"
                  size="s"
                  href={r.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Открыть репозиторий на sourcecraft.dev"
                >
                  <Icon data={ArrowUpRightFromSquare} size={14} />
                </Button>
              </ActionTooltip>
            </Flex>
          </Flex>
          {/* В4.9 ч.2 (А7; §2 23.09 ответ 4 — прочтение HQ): «обновлен» →
              «активность» рядом с «анализ». Две даты различены словом: одна —
              активность репозитория по каталогу, другая — момент анализа, та же,
              что в шапке отчета (`analysisDate`). */}
          <Meta>
            <MetaItem title="Язык">
              <LanguageName name={r.language} color={r.languageColor} />
            </MetaItem>
            <MetaItem icon={Heart} title="Реакции">
              {fmtNumber(r.likes)}
            </MetaItem>
            <MetaItem icon={CodeFork} title="Ответвления">
              {fmtNumber(r.forks)}
            </MetaItem>
            <MetaItem icon={Clock} title="Последняя активность в репозитории">
              активность {fmtDate(r.lastActivityAt)}
            </MetaItem>
            {view.analysisAt && (
              <MetaItem icon={ArrowsRotateRight} title="Момент анализа – та же дата, что в шапке отчета">
                анализ {fmtDateTime(view.analysisAt)}
              </MetaItem>
            )}
          </Meta>
        </Flex>
      </div>
      {r.title && r.title !== r.repo && (
        <Text as="p" className="rh-prose" color="complementary" style={{ margin: "var(--g-spacing-2) 0 0" }}>
          {r.title}
        </Text>
      )}
    </div>
  );
}

/**
 * В4.9 ч.2 (А1): табов нет — «Рекомендации» стоят разделом ленты с якорем
 * `#recommendations`. Роутер работает только с `pushState` и якорь сам не
 * прокручивает, а карточка грузится асинхронно, поэтому прокрутка — эффектом
 * после загрузки: по `#recommendations` и по старой ссылке `?tab=recommendations`
 * (письма, закладки, прежние ссылки кабинета продолжают вести к разделу).
 */
export const RECOMMENDATIONS_ID = "recommendations";

/** Ссылка на раздел «Рекомендации» карточки — кабинет ведет сюда. */
export function recommendationsHref(cardHref: string): string {
  return `${cardHref}#${RECOMMENDATIONS_ID}`;
}

function useRecommendationsAnchor(ready: boolean, key: string): void {
  useEffect(() => {
    if (!ready) return;
    const wants = window.location.hash === `#${RECOMMENDATIONS_ID}` || new URLSearchParams(window.location.search).get("tab") === RECOMMENDATIONS_ID;
    if (!wants) return;
    // кадр на отрисовку раздела — затем прокрутка к нему
    const frame = requestAnimationFrame(() => document.getElementById(RECOMMENDATIONS_ID)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [ready, key]);
}

/**
 * Слоты под В5 (В4.6, У18). Стоят ПОСЛЕ табов сознательно: выше они отобрали бы
 * высоту у величины и шести категорий, а приёмка вехи требует видеть их в одном
 * экране на 1366x768. Ни одной кнопки внутри: место и честное состояние — да,
 * мёртвых действий — нет (критерий ТЗ 13.4). Контракты полей и формулировки —
 * `src/web/slots.ts`, имена берутся из спеки В5.
 *
 * Сравнение (К5.15) здесь НЕ монтируется: у него нет ни маршрута, ни пункта
 * rail до того, как В5 принесёт работающий сценарий — решение владельца 20.09.
 * Его контракт и пустое состояние живут в `slots.ts` и ждут там.
 */
function CardSlots() {
  return (
    <Flex gap={3} wrap role="region" aria-label="Готовится">
      {(["aiSummary", "scoreHistory", "badge"] as const).map((slot) => (
        <Card key={slot} view="outlined" className="rh-slot">
          <Flex direction="column" gap={1}>
            <Flex gap={2} alignItems="center">
              <Text variant="subheader-2" as="h2">
                {SLOT_EMPTY[slot].title}
              </Text>
              <Label theme="unknown" size="xs">
                готовится
              </Label>
            </Flex>
            <Text variant="body-2" color="complementary">
              {SLOT_EMPTY[slot].text}
            </Text>
          </Flex>
        </Card>
      ))}
    </Flex>
  );
}

// ---------- правая панель: итог ----------

/**
 * ДВА показателя объясняются ПАРОЙ ПОДСКАЗОК (В4.6 круг 2, Р13 — решение
 * владельца 20.09). Абзац «Разницу с HealthCraft Index дают CI и Security»
 * стоял под числами и повторял то, что уже сказано выше; владелец его
 * удалила, а отличие показателей переехало сюда. Тексты согласованы так,
 * чтобы разница читалась при чтении ПАРЫ: одна называет 4 категории и
 * «строится рейтинг», вторая — 6 категорий и «в рейтинг не входит».
 * Подсказка полного показателя стоит на ОБЕИХ ветках — открытой и закрытой
 * (в закрытой её не было вовсе, а спрашивают про отличие как раз там).
 * MD-отчёт свою формулировку сохраняет: документ читается без наведения.
 */
const INDEX_HELP =
  "Публичная оценка по 4 категориям: документация, активность, задачи и состояние кода. " +
  "Считается для всех открытых репозиториев и является основой общего рейтинга";

/** круг 2 (Е10): «Место в рейтинге» в паспорте анализа — в одну строку */
const ASIDE_NAME_WIDTH = 150;

const FULL_HELP =
  "Рассчитывается по 6 категориям: 4 категориям HealthCraft Index, а также CI/CD и Безопасности. " +
  "Показатель доступен только для репозиториев, к которым у вас есть доступ";

/** «Данные собраны» паспорта анализа (А8): ok — «полностью», partial — «частично», прочее — словом статуса. */
function collectedText(status: string): string {
  // Ступень 4 (Ф7): не «Данные собраны: сбойный» — для прочих статусов строка паспорта своя
  return status === "ok" ? "полностью" : status === "partial" ? "частично" : status === "bad" ? "не полностью – анализ завершился сбоем" : scanStatusText(status);
}

/**
 * В4.9 ч.2 (А8, U4-A): правая панель — паспорт анализа и короткая справка.
 * «Анализ» — место, покрытие, полнота сбора, запуск; «Шкала оценки» —
 * плашки без абзаца; «Что учитывается» — 2 строки; «Реквизиты» свернуты.
 * Вклад, «Сильнее всего…» и «Каких данных не хватило» ушли: вклад — под
 * числами, недостающие данные — основанием у строки категории.
 */
function ScoreAside({
  card,
  meta,
  analysis,
  foreignRunning,
}: {
  card: Card;
  meta: MetaResponse | null;
  /** свой идущий анализ (фаза и признак сервера «затянулось»); null — нет */
  analysis: { phase: "queued" | "running"; stalled: boolean } | null;
  /** идёт чужой или периодический скан (С6-3) */
  foreignRunning: boolean;
}) {
  const { score, scan } = card;
  const threshold = fmtCoverage(meta?.coverageNullBelow ?? COVERAGE_NULL_BELOW);
  const coverageHelp = `Доля веса категорий, по которым есть данные. Ниже ${threshold} оценка не ставится.`;
  const full = score !== null && !score.fullLocked;
  return (
    <>
      <AsideSection title="Анализ">
        {/* К8.5.1 (С4-9): идущий анализ виден и на карточке с оценкой — свой
            (по заданию) или чужой/периодический (по скану); без обещания времени */}
        {(analysis !== null || foreignRunning) && (
          <Flex gap={2} alignItems="center">
            {analysis?.stalled ? (
              <Label theme="warning" size="xs">
                анализ затянулся – итог появится в «Заданиях»
              </Label>
            ) : (
              <>
                <Spin size="xs" />
                <Text color="secondary">{analysis?.phase === "queued" ? "анализ в очереди" : "идет анализ"}</Text>
              </>
            )}
          </Flex>
        )}
        {scan || score ? (
          <DefinitionList nameMaxWidth={ASIDE_NAME_WIDTH}>
            {score && (
              <DefinitionList.Item name="Место в рейтинге">
                {score.rank !== null && score.rankedTotal ? `#${fmtCount(score.rank)} из ${fmtCount(score.rankedTotal)}` : "—"}
              </DefinitionList.Item>
            )}
            {score && !full && (
              <DefinitionList.Item name="Покрытие" note={coverageHelp}>
                {fmtCoverage(score.indexCoverage)}
              </DefinitionList.Item>
            )}
            {/* круг 4 (П2): при двух показателях — короткие имена в одну строку,
                аббревиатуры расшифрованы в подсказке */}
            {score && full && (
              <DefinitionList.Item name="Покрытие HCI" note={`HCI – HealthCraft Index. ${coverageHelp}`}>
                {fmtCoverage(score.indexCoverage)}
              </DefinitionList.Item>
            )}
            {score && full && (
              <DefinitionList.Item name="Покрытие RHS" note={`RHS – Repo Health Score. ${coverageHelp}`}>
                {fmtCoverage(score.repoHealthCoverage ?? 0)}
              </DefinitionList.Item>
            )}
            {scan && scan.status !== "running" && <DefinitionList.Item name="Данные собраны">{collectedText(scan.status)}</DefinitionList.Item>}
            {scan && scan.status !== "running" && <DefinitionList.Item name="Запуск">{scanTriggerText(scan.trigger)}</DefinitionList.Item>}
          </DefinitionList>
        ) : analysis !== null || foreignRunning ? null : (
          <Text color="secondary">Анализа еще не было</Text>
        )}
      </AsideSection>

      {/* В4.6 (У22): та же легенда, что на рейтинге; абзац под ней на карточке снят (А8) */}
      {score && <ScoreLegend withNote={false} />}

      {score && (
        <AsideSection title="Что учитывается">
          <Flex direction="column" gap={1}>
            <Text variant="body-1" color="complementary">
              HealthCraft Index – 4 открытые категории, Repo Health Score – все 6.
            </Text>
            <Text variant="body-1" color="complementary">
              Отсутствующие данные не учитываются как нулевые.
            </Text>
          </Flex>
        </AsideSection>
      )}

      {scan && (
        // круг 2 (Е11): места в панели хватает — «Реквизиты» не свернуты
        <AsideSection title="Реквизиты">
          <DefinitionList nameMaxWidth={ASIDE_NAME_WIDTH}>
              <DefinitionList.Item name="Анализ">№ {scan.id}</DefinitionList.Item>
              {score && (
                <DefinitionList.Item name="Версия методики">
                  <Label theme="normal" size="xs">
                    {score.modelVersion}
                  </Label>
                </DefinitionList.Item>
              )}
          </DefinitionList>
        </AsideSection>
      )}
    </>
  );
}

/** Строка пути к полной оценке: слово «Настройках» — ссылка SPA на /settings (в отчете — текст). */
function PathLine({ parts }: { parts: PathPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.settings ? (
          <Link key={i} {...linkProps("/settings")}>
            {p.text}
          </Link>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * ВЕЛИЧИНА — первый экран главной колонки. Круг 2 части 2 (Е12, вариант A,
 * §2 23.09): у каждого показателя своя плашка — число, плашка уровня и под
 * ним его полоса вклада; подписи над полосой нет, цветной полосы балла под
 * числом нет (Н2). На широком экране плашки стоят в ряд, на узком — столбиком
 * (`.rh-score-cards`, auto-fit). Закрытый Repo Health Score — своя плашка с
 * путем к нему по типу зрителя.
 */
function ScoreBand({ card, view }: { card: Card; view: CardView }) {
  const score = card.score!;
  const barOf = (name: string) => view.contributions.find((b) => b.title.endsWith(name)) ?? null;
  return (
    <div className="rh-score-cards">
      <Card view="outlined" className="rh-score-band">
        <ScoreFigure title="HealthCraft Index" help={INDEX_HELP} total={score.healthcraftIndex} rank={score.rank} rankedTotal={score.rankedTotal} />
        <ContributionStrip bar={barOf("HealthCraft Index")} />
      </Card>
      {/* круг 4 (З): закрытый показатель — на светло-сером фоне заглушек */}
      <Card view="outlined" className={view.fullPath ? "rh-score-band rh-score-band_locked" : "rh-score-band"}>
        {view.fullPath ? (
          // быстрая правка 23.09 (2): колонка на всю высоту плашки — кнопка входа у нижнего края
          <Flex direction="column" gap={1} style={{ minWidth: 0, flexGrow: 1 }}>
            <Flex gap={1} alignItems="center">
              <Text color="secondary">Repo Health Score</Text>
              <HelpMark iconSize="s" aria-label="Что такое «Repo Health Score»">
                {FULL_HELP}
              </HelpMark>
            </Flex>
            {/* Закрытый показатель не схлопывается в метку (прием платформы):
                заголовок — кому он виден, строка — путь к нему по типу зрителя,
                одной копией с отчетом (`fullScorePath`, §2 23.09 ответ 1) */}
            <Text variant="subheader-2">Виден участникам репозитория</Text>
            <Text variant="body-1" color="complementary">
              <PathLine parts={view.fullPath} />
            </Text>
            {view.signIn && (
              <div className="rh-score-band__signin">
                <LoginButton compact={false} inline />
              </div>
            )}
          </Flex>
        ) : (
          <>
            <ScoreFigure title="Repo Health Score" help={FULL_HELP} total={score.repoHealthScore} />
            <ContributionStrip bar={barOf("Repo Health Score")} />
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * Полоса вклада под своим числом (Ш2, круг 2 — палитра П2): тонкий стек
 * 8 px с зазором 2 px и легенда точками в строку с переносом, как «Top
 * languages» SourceCraft и панель «Вклад категорий» рейтинга. Одна категория
 * — один цвет на обоих экранах (`categoryColorClass`); «не набрано» —
 * последним, нейтральным. Заголовка нет (Е12): полоса стоит в плашке своего
 * показателя, имя — в `aria-label`. Расчет — `categoryContributions`, общий
 * с отчетом; на карточке вклад без «+» (Е3).
 */
function ContributionStrip({ bar }: { bar: CardView["contributions"][number] | null }) {
  if (!bar) return null;
  return (
    <div className="rh-contrib rh-contrib_card" role="group" aria-label={bar.title}>
      {bar.note !== null ? (
        <Text as="p" color="complementary" className="rh-contrib__note">
          {bar.note}
        </Text>
      ) : (
        <>
          <div className="rh-contrib__bar" aria-hidden="true">
            {bar.segments.map((s) => (
              <i key={s.key} className={`rh-contrib__seg ${s.colorClass}`} style={{ flexGrow: s.share * 1000 }} />
            ))}
            {bar.rest && bar.rest.share > 0 && <i className="rh-contrib__seg rh-cat-color_rest" style={{ flexGrow: bar.rest.share * 1000 }} />}
          </div>
          <ul className="rh-contrib__legend">
            {bar.segments.map((s) => (
              <li key={s.key} className="rh-contrib__item">
                <i className={`rh-contrib__dot ${s.colorClass}`} aria-hidden="true" />
                <Text variant="body-1">{s.title}</Text>
                <Text variant="body-1" color="secondary" className="rh-contrib__share">
                  – {s.value}
                </Text>
              </li>
            ))}
            {bar.rest && (
              <li className="rh-contrib__item">
                <i className="rh-contrib__dot rh-cat-color_rest" aria-hidden="true" />
                <Text variant="body-1" color="secondary">
                  {bar.rest.title} – {bar.rest.value}
                </Text>
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function ScoreFigure({ title, help, total, rank, rankedTotal }: { title: string; help: string; total: number | null; rank?: number | null; rankedTotal?: number | null }) {
  return (
    <Flex direction="column" gap={1} style={{ minWidth: 0 }}>
      <Flex gap={1} alignItems="center">
        <Text color="secondary">{title}</Text>
        <HelpMark iconSize="s" aria-label={`Что такое «${title}»`}>
          {help}
        </HelpMark>
      </Flex>
      {total === null ? (
        <span className="rh-chip-fit">
          <Label theme="unknown" size="s">
            {NO_SCORE}
          </Label>
        </span>
      ) : (
        <Flex gap={2} alignItems="baseline" wrap className="rh-score-figure__value">
          <Text variant="display-2">{fmtScore(total)}</Text>
          <Text color="secondary">из 100</Text>
          <Label theme={scoreLabelTheme(total)} size="s">
            {sentence(scoreWord(total))}
          </Label>
          {/* место в рейтинге — серый текст справа */}
          {rank !== null && rank !== undefined && rankedTotal ? (
            <Text color="secondary" className="rh-score-figure__rank" title="Место в публичном рейтинге по HealthCraft Index">
              #{fmtCount(rank)} из {fmtCount(rankedTotal)}
            </Text>
          ) : null}
        </Flex>
      )}
    </Flex>
  );
}

// ---------- категории ----------

/**
 * В4.9 ч.2 (А4, U2-a): строка категории — раскрытие · название · полоса ·
 * балл · плашка уровня, вторая строка под названием — основание (тот же
 * текст, что колонка «Основание» PDF). Полосы серые — цвет несет только
 * плашка; чипа «Вклад N%» нет. Закрытые зрителю CI/CD и Безопасность — не
 * строками: плашка с голубой рамкой под списком (решение В4.6 круг 2 п.4 в
 * силе, §2 23.09 «финальный вид подтвержден» п.2).
 */
function Categories({ card, view }: { card: Card; view: CardView }) {
  return (
    <section className="rh-section" aria-labelledby="rh-categories-title">
      {/* круг 2 (Е4): заголовок — внутри плашки, в ритме ее строк */}
      <Card view="outlined" className="rh-section-card">
        <Text variant="subheader-3" as="h2" id="rh-categories-title" className="rh-section__title">
          Категории
        </Text>
        <ul className="rh-list" style={{ borderTop: 0 }}>
          {view.categories.map((c) => (
            <CategoryRow key={c.key} category={c} card={card} defaultOpen={c.key === view.worstKey} />
          ))}
        </ul>
        {view.locked && <LockedCategories text={view.locked.text} />}
      </Card>
    </section>
  );
}

/**
 * Плашка закрытых категорий (А4): заголовок и пояснение одним предложением —
 * `ACCESS_LOCK_SHORT` по причине (одна копия с отчетом, К9.13); при разных
 * причинах — по предложению на категорию. Призыва внутри нет: единственный
 * призыв стоит у закрытого Repo Health Score.
 */
function LockedCategories({ text }: { text: string }) {
  // круг 2 (Т3): одно предложение без заголовка
  // круг 3 (5): иконка — по центру однострочного текста; круг 5 (1): светло-синий фон
  return <Alert theme="info" view="filled" size="s" align="center" className="rh-locked-note" message={text} />;
}

function CategoryRow({ category: c, card, defaultOpen = false }: { category: CategoryView; card: Card; defaultOpen?: boolean }) {
  const key = c.key;
  const cat = card.score!.categories[key]!;
  const [open, setOpen] = useState(defaultOpen);
  const subs = Object.entries(cat.submetrics);
  // Ступень 4 (Ф12): у категории без данных раскрывать нечего — одно состояние, один вид
  const expandable = c.score !== null && (subs.length > 0 || c.partialNote !== null);

  const row = (
    <>
      {expandable ? <ArrowToggle direction={open ? "bottom" : "right"} size={14} /> : <span />}
      <span className="rh-category__name">
        <span className="rh-category__title">
          <Text variant="subheader-1">{c.title}</Text>
          {c.stale && (
            <Label theme="warning" size="xs">
              Данные из прошлого анализа
            </Label>
          )}
        </span>
        {/* основание — вторая строка, тот же текст, что колонка «Основание» PDF */}
        <Text variant="body-1" color="complementary" className="rh-category__why">
          {c.why}
        </Text>
      </span>
      {/* Tri-state: без данных — «—» вместо полосы и числа, плашка «Нет данных» */}
      <span className={c.score === null ? "rh-category__bar rh-category__bar_empty" : "rh-category__bar"}>
        {/* круг 2 (Е13): у «нет данных» на месте полосы пусто — единственный
            прочерк стоит в колонке балла, у правого края, рядом с плашкой */}
        {c.score === null ? null : (
          <span className="rh-cat-bar" role="img" aria-label={`${c.scoreText} из 100`}>
            <span className="rh-cat-bar__fill" style={{ width: `${Math.max(0, Math.min(100, Math.round(c.score)))}%` }} />
          </span>
        )}
      </span>
      <Text variant="subheader-2" color={c.score === null ? "secondary" : undefined} className="rh-category__value">
        {c.scoreText}
      </Text>
      <Label theme={c.chip.theme} size="xs" className="rh-category__word">
        {c.chip.text}
      </Label>
    </>
  );

  return (
    <li className="rh-list__item" style={{ padding: 0 }}>
      {expandable ? (
        <button type="button" className="rh-category" aria-expanded={open} onClick={() => setOpen(!open)}>
          {row}
        </button>
      ) : (
        <div className="rh-category">{row}</div>
      )}
      {/* В4.6 (У17): разбивка по движкам живёт под строкой Security */}
      {key === "security" && <AppsecEngines card={card} />}
      {open && (
        <div className="rh-subrows">
          {/* примечание частичной нехватки данных — внутри раскрытия (в MD его нет в строке) */}
          {c.partialNote && (
            <Text variant="body-1" color="complementary" className="rh-subrows__note">
              {c.partialNote}
            </Text>
          )}
          {/* Доводка 21.09: шапка подписывает ТОЛЬКО числовые колонки — над
              именем метрики подпись не нужна, там и так имя. Подписи 11px
              приглушённые, без линии под ними (вариант B). Колонки общие со
              строками: сетка живёт на `.rh-subrows`, строки раскрываются в
              неё через `display: contents`, иначе у каждой строки был бы свой
              `auto` и подпись не встала бы над значениями. */}
          {/* круг 2 (Е6): вес показателя внутри категории — та же колонка, что в
              разборе PDF (`submetricWeightText`, одна копия); порядок колонок — как в PDF */}
          {/* круг 3 (7): «Вес» перед «Балл» — на карточке; разбор PDF прежний */}
          <div className="rh-subrows__head">
            <span>Значение</span>
            <span>Вес</span>
            <span>Балл</span>
          </div>
          {subs.map(([subKey, sub]) => (
            <div key={subKey} className="rh-subrow">
              {/* Доводка 21.09: имя, пунктирный лидер и значение — ОДНА ячейка.
                  Раньше имя и значение стояли в разных колонках грида, между
                  ними зияла растянутая пустота, и строка распадалась надвое.
                  Лидер физически ведёт глаз от названия к числу.
                  Цвет имени говорит о весе: справочные подметрики («показ, без
                  веса») набраны приглушённым, взвешенные — основным. */}
              <span className="rh-subrow__head">
                <Text color="secondary" className="rh-subrow__icon">
                  <Icon data={submetricIcon(key, subKey)} size={14} />
                </Text>
                <Text color={displayOnly(key, subKey) ? "secondary" : undefined} className="rh-subrow__name">
                  {submetricTitle(key, subKey)}
                </Text>
                <span className="rh-subrow__lead" aria-hidden="true" />
                {/* В4.7 (П4.2): значение — по словарю подметрик
                    (`src/report/submetrics.ts`), тому же, что у MD и PDF:
                    единица и масштаб, составное значение — короткой строкой,
                    без многоточия (строка может перенестись). Доли по-прежнему
                    округлены (Р20). Поповер «Основание» ниже печатает значение
                    СЫРЫМ: это доказательная база.
                    Доводка 21.09: слово «значение» из строки убрано — оно
                    повторялось в каждой из девяти строк; полная форма
                    осталась в подсказке. */}
                {/* В4.9 (К9.9): служебная заметка расчета не печатается — вместо «—» стоят
                    слова заметки из словаря подметрик, примечание уходит в подсказку;
                    неизвестная заметка не показывается вовсе */}
                <Text
                  color="secondary"
                  className="rh-subrow__value"
                  title={`значение: ${submetricShownValue(key, subKey, sub, submetricContext(card.score?.computedAt), cat.submetrics)}${submetricNote(key, subKey, sub.note)?.remark ? `. ${submetricNote(key, subKey, sub.note)!.remark}` : ""}`}
                >
                  {submetricShownValue(key, subKey, sub, submetricContext(card.score?.computedAt), cat.submetrics)}
                </Text>
              </span>
              {/* В колонке балла — только балл, и полос у подметрик нет вовсе:
                  в плотных списках платформы (файловое дерево, коммиты, теги)
                  нет ни полос, ни чипов, читаемость держится на одном кегле,
                  колонках и двух уровнях яркости.
                  Слова «без веса» и «нет данных» отсюда убраны: они были
                  вдвое-втрое шире числа и сбивали правый столбик, ради
                  которого колонка и заведена. Вместо слова прочерк — тот же
                  знак, каким продукт показывает отсутствующее число везде
                  (`fmtScore`), и он никогда не читается нулём (закон 2). Что
                  именно отсутствует, говорят подсказка и цвет имени. */}
              <Text className="rh-subrow__score" color="secondary">
                {submetricWeightText(key, subKey)}
              </Text>
              {displayOnly(key, subKey) || sub.score === null ? (
                <Text
                  className="rh-subrow__score"
                  color="secondary"
                  title={displayOnly(key, subKey) ? "Показывается для справки, в балл категории не входит" : NO_DATA}
                >
                  —
                </Text>
              ) : (
                <Text className="rh-subrow__score">{fmtSubmetric(sub.score)}</Text>
              )}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

// ---------- маркеры расчёта: предупреждения наверху и «Ограничения данных» ----------

/**
 * Предупреждения наверху (В4.6, З4 систематика): `warning` — оговорка о самом
 * расчете, `info` — граница данных. В4.9 ч.2 (А6, §2 23.09 ответ 2): наверху
 * остаются только те, которых нет в «Ограничениях данных», — данные из
 * прошлого анализа, лимит сервиса и усеченная история стоят одним списком
 * внизу, тем же текстом, что PDF.
 */
function Markers({ view }: { view: CardView }) {
  const rows: { key: string; label: string; text: string; theme: "info" | "warning" }[] = [];
  // Ф2.9 (LOW-9): маркер codeEmpty — зритель видел Score 0 без объяснения
  if (view.topMarkers.includes("code-empty")) {
    rows.push({
      key: "code-empty",
      label: "В репозитории нет кода",
      text: "В репозитории нет ни одного файла, поэтому оценка – 0. Это не ошибка сервиса: оценивать нечего.",
      theme: "info",
    });
  }
  if (view.topMarkers.includes("ci-cap")) {
    rows.push({
      key: "ci-cap",
      label: "CI настроен, результаты запусков недоступны",
      text: "Файл CI в репозитории есть, но результаты запусков сервису недоступны. Без них категория CI/CD получает не больше 50 из 100.",
      theme: "warning",
    });
  }
  if (rows.length === 0) return null;
  return (
    <Flex direction="column" gap={2} role="region" aria-label="Особенности расчета">
      {[...rows].sort((a, b) => (a.theme === b.theme ? 0 : a.theme === "warning" ? -1 : 1)).map((row) => (
        // круг 5 (1): info — заливкой, предупреждение — прежней рамкой
        <Alert key={row.key} theme={row.theme} view={row.theme === "info" ? "filled" : "outlined"} size="s" title={row.label} message={row.text} />
      ))}
    </Flex>
  );
}

/** «Ограничения данных» (А6): `limitations` отчета тем же текстом, пункт — info-плашка; пусто — раздела нет. */
function Limitations({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="rh-section" aria-labelledby="rh-limitations-title">
      <Card view="outlined" className="rh-section-card">
        <Text variant="subheader-3" as="h2" id="rh-limitations-title" className="rh-section__title">
          Ограничения данных
        </Text>
        <Flex direction="column" gap={2}>
          {items.map((text) => (
            // круг 5 (1): инфо-плашки — светло-синей заливкой, как «Токен показывается один раз»
            <Alert key={text} theme="info" view="filled" size="s" message={text} />
          ))}
        </Flex>
      </Card>
    </section>
  );
}

// ---------- рекомендации ----------

/**
 * В4.9 ч.2 (А5, U13 и U8): раздел виден без клика. Номер слева — порядок
 * выдачи движка (как в PDF; словом «приоритет» не подписан — это позиция, не
 * срочность), действие заголовком, причина, справа «ожидаемый эффект» над
 * плашкой прироста. Основание — словами: подметрика правила и ее значение;
 * по клику — источник, время сбора и сырые данные.
 */
function Recommendations({ view }: { view: CardView }) {
  return (
    // круг 2 (Е13): рекомендаций нет — без заголовка раздела; быстрая правка
    // 23.09 (3): но строка «Рекомендаций нет» остается, иначе читатель не знает,
    // потерялся раздел или улучшать нечего
    view.recommendations.length === 0 ? (
      <section className="rh-section" id={RECOMMENDATIONS_ID} aria-label="Рекомендации">
        <Card view="outlined" className="rh-section-card">
          <Flex gap={2} alignItems="center">
            <Icon data={CircleCheck} size={16} className="rh-muted-icon" />
            <Text color="complementary">{view.noRecommendations}</Text>
          </Flex>
        </Card>
      </section>
    ) : (
      <section className="rh-section" id={RECOMMENDATIONS_ID} aria-labelledby="rh-recommendations-title">
        <Card view="outlined" className="rh-section-card">
          <Text variant="subheader-3" as="h2" id="rh-recommendations-title" className="rh-section__title">
            Рекомендации
          </Text>
          <ol className="rh-list rh-recs" style={{ borderTop: 0 }}>
            {view.recommendations.map((r) => (
              <RecommendationRow key={r.rec.ruleId} item={r} />
            ))}
          </ol>
        </Card>
      </section>
    )
  );
}

function RecommendationRow({ item }: { item: RecommendationView }) {
  const { rec } = item;
  return (
    <li className="rh-list__item rh-rec">
      <Text variant="subheader-1" color="secondary" className="rh-rec__n">
        {item.n}
      </Text>
      <Flex direction="column" gap={1} className="rh-rec__body">
        {/* В4.9 (К9.10): заголовок = действие (глагол), ниже — причина; как в отчете.
            Круг 2 (Е8): кегль и ритм — как у строки категории (название subheader-1,
            основание body-1 complementary) */}
        <Text variant="subheader-1">{rec.action}</Text>
        <Text variant="body-1" color="complementary">
          {rec.problem}
        </Text>
        <Flex gap={2} wrap alignItems="center" className="rh-rec__basis">
          <Text variant="body-short" color="secondary">
            Причина:
          </Text>
          <Popover trigger="click" placement={["bottom-start", "top-start"]} content={<FactProof item={item} />}>
            <Label theme="info" size="xs" interactive>
              <Flex gap={1} alignItems="center">
                {item.label}
                <Icon data={ChevronDown} size={12} />
              </Flex>
            </Label>
          </Popover>
        </Flex>
      </Flex>
      <div className="rh-rec__effect">
        {item.effectNote !== null ? (
          <>
            <Text variant="caption-2" color="secondary">
              {item.effectNote}
            </Text>
            {/* круг 4 (Э1): зеленый — только для здоровья; эффект — нейтральной серой плашкой */}
            <Label theme="unknown" size="xs" title="Прирост показателя, если выполнить только эту рекомендацию">
              {item.effect}
            </Label>
          </>
        ) : (
          <Text variant="body-short" color="complementary">
            {item.effect}
          </Text>
        )}
      </div>
    </li>
  );
}

/** Поповер основания: заголовок-ярлык; по каждому факту — источник словами, время сбора, сырые данные свернутыми и ключ мелко. */
function FactProof({ item }: { item: RecommendationView }) {
  return (
    <Flex direction="column" gap={3} className="rh-proof">
      <Text variant="subheader-1">{item.label}</Text>
      {item.facts.map(({ key, fact }) => (
        <FactBlock key={key} factKey={key} fact={fact} />
      ))}
    </Flex>
  );
}

function FactBlock({ factKey, fact }: { factKey: string; fact: Evidence | null }) {
  if (!fact) {
    return (
      <Flex direction="column" gap={1}>
        {/* Ступень 4 (Ф10): текст про AppSec — только у фактов Безопасности */}
        <Text color="complementary">{factKey.startsWith("appsec") ? `Эти данные вам недоступны. ${SECURITY_PUBLIC_NOTE}` : "Эти данные видны участникам репозитория."}</Text>
        <Text variant="caption-2" color="hint">
          {factKey}
        </Text>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap={1}>
      <Flex gap={2} wrap alignItems="center">
        <Text variant="body-short" color="secondary">
          Источник: {factSource(fact)} · собрано {fmtDateTime(fact.collectedAt)}
        </Text>
        {fact.status !== "ok" && (
          <Label theme={fact.status === "bad" ? "warning" : "unknown"} size="xs">
            {sentence(factStatusText(fact.status))}
          </Label>
        )}
      </Flex>
      {/* круг 2 (Ф2, §2 23.09): исходные данные целиком, без сворачивания */}
      <pre className="rh-code rh-proof__raw">{fmtFactValue(fact.value)}</pre>
      <Text variant="caption-2" color="hint">
        {fact.key}
      </Text>
    </Flex>
  );
}
function factStatusText(status: string): string {
  switch (status) {
    case "ok":
      return "данные есть";
    case "no-data":
      return "данных нет";
    case "bad":
      return "источник не ответил";
    default:
      return status;
  }
}

// В4.9 (К9.2): причины «нет данных» — `humanNoData`/`noDataReason` из format.ts
// (одна копия на карточку, MD и PDF; до В4.9 здесь жила вторая копия).
// Показ-без-веса — `displayOnly` словаря подметрик (src/report/submetrics.ts).

// В4.7 (П4.2): названия подметрик переехали в словарь `src/report/submetrics.ts`
// (одно правило на страницу, MD и PDF); иконки остаются здесь — это вид.

/**
 * Иконка подметрики — по одной на каждую из 28 (доводка 21.09).
 * Иконка здесь не украшение: строк в раскрытой категории до девяти, все
 * набраны одним кеглем, и глиф слева даёт строке опознавательный знак,
 * по которому её находят повторно, не перечитывая название. Все взяты из
 * `@gravity-ui/icons` — своих рисунков не заводим (правило 3а
 * docs/ui/gravity-uikit.md). Незнакомый ключ получает нейтральную точку.
 */
const SUBMETRIC_ICONS: Record<string, IconData> = {
  "documentation.readme": FileText,
  "documentation.license": ScalesBalanced,
  "documentation.contributing": Persons,
  "documentation.codeowners": PersonGear,
  "cicd.config": Pipeline,
  "cicd.pass_rate": CircleCheck,
  "cicd.duration": Stopwatch,
  "security.density": Bug,
  "security.resolved": ShieldCheck,
  "security.secrets": Key,
  "activity.fresh": Clock,
  "activity.freq": Pulse,
  "activity.contributors": Persons,
  "activity.pulls_90d": CodePullRequest,
  "activity.releases_12m": Rocket,
  "activity.mirror_likeness": Copy,
  "activity.commits_90d": CodeCommits,
  "activity.commits_365d": Calendar,
  "activity.sync_bursts": Thunderbolt,
  "issues.stale": Hourglass,
  "issues.close_days": ClockArrowRotateLeft,
  "issues.resolution": SquareCheck,
  "issues.first_resp": Comment,
  "issues.tracker_unused": CommentSlash,
  "code.density": Flag,
  "code.old_share": CalendarXmark,
  "code.root": FolderTree,
  "code.todo_total": Hashtag,
};

function submetricIcon(category: string, sub: string): IconData {
  return SUBMETRIC_ICONS[`${category}.${sub}`] ?? Circle;
}

/**
 * Разбивка находок AppSec ПО ДВИЖКАМ (В4.6, У17). Счётчики коллектор уже
 * собирает (`appsec.ts`, поле `backlog.engines`) — до этой вехи они лежали в
 * факте и никуда не показывались, то есть зритель видел одно число «столько-то
 * находок» без понимания, чем именно они найдены.
 *
 * SCA — отдельной строкой, потому что это другой класс находок (зависимости, а
 * не свой код), и по нему у платформы отдельный вопрос (Q&A №14). **В ОЦЕНКУ
 * SCA не вводится:** решение владельца 20.09 — Security-формула не меняется ни
 * на йоту (закон 5, воспроизводимость 13.2.2). Имя движка не угадывается: в
 * SCA-строку идёт тот счётчик, чьё имя платформа назвала сама, остальные
 * печатаются как есть.
 */
interface AppsecBreakdown {
  engines: [string, number][];
  sca: [string, number] | null;
  openFindings: number | null;
  truncated: boolean;
}

function appsecBreakdown(card: Card): AppsecBreakdown | null {
  const fact = card.evidence.find((e) => e.key === "appsec.findings");
  if (!fact || fact.status !== "ok") return null;
  const backlog = (fact.value as { backlog?: { engines?: Record<string, number>; open_findings?: number | null; truncated?: boolean } } | null)?.backlog;
  if (!backlog || typeof backlog.engines !== "object" || backlog.engines === null) return null;
  const all = Object.entries(backlog.engines).sort((a, b) => b[1] - a[1]);
  const sca = all.find(([name]) => /sca|composition|depend/i.test(name)) ?? null;
  return {
    engines: all.filter((pair) => pair !== sca),
    sca,
    openFindings: typeof backlog.open_findings === "number" ? backlog.open_findings : null,
    truncated: backlog.truncated === true,
  };
}

function AppsecEngines({ card }: { card: Card }) {
  const breakdown = appsecBreakdown(card);
  if (!breakdown || (breakdown.engines.length === 0 && breakdown.sca === null)) return null;
  return (
    <Flex direction="column" gap={1} style={{ padding: "0 var(--g-spacing-3) var(--g-spacing-2) calc(16px + var(--g-spacing-6))" }}>
      <Text variant="body-2" color="complementary">
        Находки AppSec по видам проверок{breakdown.openFindings !== null ? ` (всего открытых: ${fmtNumber(breakdown.openFindings)})` : ""}:
      </Text>
      <DefinitionList nameMaxWidth={DEFINITION_NAME_WIDTH}>
        {breakdown.engines.map(([name, count]) => (
          <DefinitionList.Item key={name} name={name}>
            {fmtNumber(count)}
          </DefinitionList.Item>
        ))}
        {breakdown.sca && (
          <DefinitionList.Item name={`${breakdown.sca[0]} (зависимости, SCA)`} note="Находки в зависимостях показываются отдельно и в оценку Безопасности не входят: формула категории не менялась.">
            {fmtNumber(breakdown.sca[1])}
          </DefinitionList.Item>
        )}
      </DefinitionList>
      {breakdown.sca === null && (
        <Text variant="body-2" color="complementary">
          SourceCraft не вернул отдельное число находок в зависимостях (SCA).
        </Text>
      )}
      {breakdown.truncated && (
        <Text variant="body-2" color="complementary">
          Список групп находок усечен предохранителем пагинации: счетчики показывают собранную часть.
        </Text>
      )}
    </Flex>
  );
}



// ========== ПОРТ 6 (hq-parallel): избранное на карточке ==========

/**
 * Ф2.20 (решение 18.09): после успешного own-скана НЕзаполненная звезда один
 * раз получает неблокирующий зелёный glow (модалка запрещена). «Один раз» =
 * переход active→done в текущей browser-session: ключ `<org>/<repo>:<jobId>`
 * в sessionStorage, DDL нет. Заполненная звезда не светится.
 */
function FavoriteStar({ org, repo, doneKey, loggedIn }: { org: string; repo: string; doneKey: string | null; loggedIn: boolean | null }) {
  const toaster = useToaster();
  const [state, setState] = useState<"loading" | "on" | "off" | "anon">("loading");
  const [error, setError] = useState<string | null>(null);
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    if (!doneKey || state !== "off") return;
    try {
      if (sessionStorage.getItem(doneKey) !== null) return;
      sessionStorage.setItem(doneKey, "1");
    } catch {
      /* sessionStorage недоступен — светим без «одного раза», модалки нет */
    }
    setGlow(true);
    const timer = setTimeout(() => setGlow(false), 2800);
    return () => clearTimeout(timer);
  }, [doneKey, state, org, repo]);
  useEffect(() => {
    // аноним: звезда выключена без живого запроса — 401-зонд мусорил консоль
    // браузера (планка В4.5 «ноль ошибок консоли»), а вход уже виден в /api/me
    // В4.8.5 (К8.5.8, С6-6): сессия ещё грузится — звезда «проверяем», а не «войдите»
    if (loggedIn === null) {
      setState("loading");
      return;
    }
    if (!loggedIn) {
      setState("anon");
      return;
    }
    // Доводка 21.09: здесь стоял ref `probed`, разрешавший запрос ОДИН раз за
    // жизнь компонента. Он навсегда запирал звезду у вошедшего зрителя:
    // `/api/me` перезапрашивается (и на время перезапроса `kind` снова
    // "loading", то есть `loggedIn` на миг false). Порядок выходил такой —
    // эффект с loggedIn=true поднимал флаг и слал запрос; следующий эффект с
    // loggedIn=false отменял его через `stop` и ставил "anon"; третий, уже с
    // loggedIn=true, видел поднятый флаг и выходил БЕЗ запроса. Состояние
    // оставалось "anon", кнопка — неактивной с подсказкой «Войдите», хотя
    // зритель вошёл. От зонда-401 у анонима защищает проверка выше, а от
    // гонки ответов — `stop` ниже; ref не нужен ни для того, ни для другого.
    let stop = false;
    fetch(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`)
      .then(async (res) => {
        if (res.status === 401) {
          if (!stop) setState("anon");
          return;
        }
        // M-11: сбой сервера — не «войдите»: честная ошибка проверки
        if (!res.ok) {
          if (!stop) {
            setState("off");
            setError("Не удалось проверить избранное – попробуйте позже");
          }
          return;
        }
        const body = (await res.json()) as { favorite: boolean };
        if (!stop) setState(body.favorite ? "on" : "off");
      })
      .catch(() => {
        if (!stop) {
          setState("off");
          setError("Не удалось проверить избранное – попробуйте позже");
        }
      });
    return () => {
      stop = true;
    };
  }, [org, repo, loggedIn]);
  // Доводка 21.09: на время проверки кнопка больше НЕ исчезает. Прежний
  // `return null` убирал её из шапки до ответа `/api/me/favorites`, и при
  // переходе из рейтинга у вошедшего зрителя звезда пропадала на время
  // запроса, а соседняя иконка перехода прыгала на её место. Теперь во время
  // проверки показывается та же кнопка, только неактивная: габарит шапки
  // постоянен, а состояние честно названо подсказкой.
  const checking = state === "loading";
  const toggle = async () => {
    setError(null);
    if (state === "anon") return; // задизейблена: подсказка в title
    const next = state === "on" ? "off" : "on";
    setState(next);
    try {
      const res = await mutateJson<{ check?: FavoriteAddCheck } | null>(
        `/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
        next === "on" ? "PUT" : "DELETE",
      );
      // Доводка 21.09: у действия появился отклик. Смена оттенка звезды —
      // единственное, что происходило, и на мелкой иконке её не замечали;
      // тост ещё и называет, КУДА репозиторий попал, — раздел «Мои
      // репозитории» иначе приходится искать самому.
      // В4.8.5 (К8.5.14 (д)): права проверяются сами при добавлении — тост
      // говорит, чем кончилась проверка и поставлен ли первый анализ своего
      toaster.add({
        name: `favorite:${org}/${repo}`,
        theme: next === "on" ? "success" : "info",
        title: next === "on" ? "Добавлено в избранное" : "Убрано из избранного",
        content: next === "on" ? `${slugOf(org, repo)}. ${favoriteAddedText(res?.check)}` : slugOf(org, repo),
      });
      // первый анализ своего мог встать — «Задания» и карточка узнают сразу
      if (next === "on") announceJobsChanged();
    } catch (e) {
      setState(state); // откат — звезда не врёт
      // С3-6: ошибка — одним тостом (раньше и тост, и строка под звездой)
      toaster.add({
        name: `favorite-failed:${org}/${repo}`,
        theme: "danger",
        title: next === "on" ? "Не удалось добавить в избранное" : "Не удалось убрать из избранного",
        content: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <Flex direction="column" gap={1}>
      {/* В4.6 (У32, замечание владельца 9 + правило 3а docs/ui/gravity-uikit.md):
          звезда — ИКОНКА из @gravity-ui/icons, а не юникодный символ звезды.
          Символ рисовался шрифтом, то есть не совпадал по размеру и оптике с
          соседней иконочной кнопкой и не слушался размера иконок вообще.
          Заполненная — янтарная (`warning`, 8,18:1 в тёмной теме): это тот
          самый «акцент на мелкой детали», который просил владелец. */}
      <Button
        size="s"
        view="flat"
        className={["rh-favorite-star", state === "on" ? "rh-favorite-star_on" : "", glow ? "rh-star-glow" : ""]
          .filter(Boolean)
          .join(" ")}
        disabled={state === "anon" || checking}
        /* В4.6 (У16): объяснение границы доступа прямо там, где зритель
           нажимает звезду. Сервис НЕ перечисляет репозитории зрителя сам —
           списка «все мои репозитории» у него нет и быть не может без
           токена с правами; поэтому «Мои репозитории» в кабинете — это
           избранное, а не автоматический список (решение favorites-only
           18.09). Раздел настроек вынесен на `/settings` в В4.6, круг 3. */
        title={
          checking
            ? "Проверяем избранное…"
            : state === "anon"
              ? "Войдите через Я ID, чтобы добавлять в избранное"
              : "В избранное. Раздел «Избранное» содержит выбранные вами репозитории; права на закрытые данные сервис проверит сам при добавлении."
        }
        onClick={() => void toggle()}
      >
        {/* В4.6 круг 2 (Р22, замечание владельца 20.09): 14px, как у соседней
            иконки перехода на sourcecraft.dev — 16 против 14 давали разную
            оптику у двух кнопок, стоящих вплотную. Кнопки-обёртки совпадают
            по габариту: обе `size="s"`. */}
        <Icon data={state === "on" ? StarFill : Star} size={14} />
      </Button>
      {error && <Text color="danger">{error}</Text>}
    </Flex>
  );
}
