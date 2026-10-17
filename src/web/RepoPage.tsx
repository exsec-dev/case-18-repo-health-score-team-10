// Карточка репозитория: HealthCraft Index и полный Repo Health Score, шесть категорий
// с раскрытием подметрик, рекомендации с доказательствами. Состав ответа собирает сервер
// по доступу зрителя: закрытые ему CI/CD и Безопасность приходят без чисел и
// показываются заглушкой с причиной. Правило экрана: ни одной фразы без факта либо
// без честного объяснения, почему факта нет.
//
// Страница читается одной лентой в порядке PDF: шапка → показатели и вклад категорий →
// «Категории» → «Рекомендации» → история → «Ограничения данных». Утверждения о данных
// собирает view-модель `cardView.ts` из тех же функций, что отчет. Правая панель —
// паспорт анализа и короткая справка; ниже 1440 px она выезжает по кнопке «Как считается».
import { EmptyIllustration, NotFoundIllustration, QueueIllustration } from "./illustrations";
import { lastRatingHref } from "./ratingReturn";
import {
  ArrowDownToLine,
  ArrowsRotateRight,
  ArrowUpArrowDown,
  ArrowUpRightFromSquare,
  Bug,
  Calendar,
  CalendarXmark,
  ChartColumn,
  ChartLine,
  Check,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleInfo,
  Clock,
  ClockArrowRotateLeft,
  CodeCommits,
  CodeFork,
  CodeMerge,
  CodePullRequest,
  Comment,
  CommentSlash,
  Comments,
  Copy,
  Ellipsis,
  FileText,
  Flag,
  FolderTree,
  Hashtag,
  Heart,
  Hourglass,
  Key,
  LogoMarkdown,
  Person,
  PersonGear,
  Persons,
  Pipeline,
  Pulse,
  Rocket,
  ScalesBalanced,
  SealCheck,
  ShieldCheck,
  SquareCheck,
  Star,
  StarFill,
  Stopwatch,
  Thunderbolt,
} from "@gravity-ui/icons";
import type { IconData } from "@gravity-ui/uikit";
import {
  ActionTooltip,
  Tooltip,
  Alert,
  ArrowToggle,
  Button,
  Card,
  ClipboardButton,
  DefinitionList,
  Disclosure,
  DropdownMenu,
  Flex,
  HelpMark,
  Icon,
  Label,
  Link,
  Popover,
  SegmentedRadioGroup,
  Spin,
  Text,
  useToaster,
} from "@gravity-ui/uikit";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { COVERAGE_NULL_BELOW } from "../score/model";
import { displayOnly, submetricContext, submetricNote, submetricShownValue, submetricTitle } from "../report/submetrics";
import { factWords } from "../report/factWords";
import { FULL, INDEX, hintText, metricWeights, notInScoreNote, ownershipView, sourceWord, strengthsLine, submetricWeightText, type BarHint } from "../report/sections";
import type { MetaResponse, RepoCard } from "./api";
import { dataOf, mutateJson, useJson, useVisible } from "./api";
import { LADDER_HELP, cardView, type CardView, type CategoryView, type PositionView, type RecommendationView } from "./cardView";
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
  scoreLabelTheme,
  scoreWord,
  sentence,
  slugOf,
  notOwnReason,
  rankText,
  CI_CAP_TEXT,
  CI_CAP_TITLE,
  STALE_CATEGORY_MARK,
} from "./format";
import { linkProps, loginHref, navigate } from "./router";
import { COMPARE_MAX, COMPARE_LIMIT_TEXT, compareHref } from "./compareView";
import { lastCompareSet, rememberCompareSet } from "./compareReturn";
import { LoginButton, Page, type Crumb } from "./Shell";
import { Trophy } from "./icons";
import { useMediaQuery } from "./prefs";
import { AiOverviewSection, BadgeButton, BadgeDialog, CategoryAiMark, CategoryAiNote, FraudCheckFooter, HistorySection, OPEN_CATEGORY_EVENT, categoryAiNote, categoryAnchor, useAiQuota } from "./RepoV5";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, MethodLink, ModelVersion, RepoAvatar, RepoSlug, ScoreBar, ScoreLegend, SkeletonRows, VisibilityPill } from "./ui";

type Card = RepoCard;
type Evidence = Card["evidence"][number];

export function RepoPage({ org, repo, meta, onSection }: { org: string; repo: string; meta: MetaResponse | null; onSection?: (s: "rating" | "me") => void }) {
  const slug = `${org}/${repo}`;
  const cardUrl = `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  // перечитывание не мигает скелетоном — прежние данные на экране, пока не придет
  // новый ответ; сбой перечитывания — мягкая пометка
  const { state, reload } = useJson<Card>(cardUrl, { keepPrevious: true });
  const { me, reloadMe } = useSession();
  const meData = dataOf(me);
  const loggedIn = meData !== null && meData.login !== null;
  // остаток лимитов AI — для текста кнопок обзора и проверки
  const aiQuota = useAiQuota(loggedIn);
  // фаза анализа — из общего опроса заданий вкладки (по заданию, а не по «появился ли
  // скан с номером больше»); карточка сама себя ради итога не опрашивает
  const analysis = useAnalysis();
  const live = analysis.live(slug);
  const start = useStartAnalysis(org, repo);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  useAnalysisFinished((jobs) => {
    const mine = jobs.find((j) => j.slug === slug);
    if (!mine) return;
    reload();
    // звезда светится один раз после успешного своего анализа; итог AI-заявки
    // (обзор, проверка) ее не зажигает
    if (mine.phase === "done" && (mine.kind === undefined || mine.kind === "scan")) setDoneKey(`${slug}:${mine.jobId}`);
  });

  const data = dataOf(state);
  useRecommendationsAnchor(data !== null && data.score !== null, slug);
  // Анализ запускается только для своего репозитория. «Свой» определяется по доступу,
  // который карточка и так резолвит (`viewer.own`), — кнопка есть на любом своем репо,
  // даже не в избранном; чужому, анониму и при неизвестном доступе кнопки нет вовсе
  const canRefresh = data?.viewer?.own === true && data.viewer.auth === "pat";
  // сервер не видит сессии, а вкладка считает зрителя вошедшим (сессия истекла или
  // вышли в соседней вкладке) — перечитываем /api/me
  const sessionGone = loggedIn && data?.viewer?.auth === "no-session";
  useEffect(() => {
    if (sessionGone) reloadMe();
  }, [sessionGone, reloadMe]);
  // Идет чужой или периодический скан — карточка показывает «идет анализ» и
  // перечитывает себя раз в 30 с (лимит открытий карточки 30/мин так не съедается);
  // в скрытой вкладке — пауза
  const foreignRunning = data !== null && data.scan?.status === "running" && live === null && data.job === null;
  const visible = useVisible();
  useEffect(() => {
    if (!foreignRunning || !visible) return;
    const timer = setInterval(() => reload(), 30_000);
    return () => clearInterval(timer);
  }, [foreignRunning, visible, reload]);

  // Первая крошка публичного репо ведет на последнюю выдачу рейтинга (фильтр, сортировка,
  // страница). Закрытый (private/internal) в рейтинг не входит — ему крошка «Избранное»,
  // откуда на него и попадают
  const closedRepo = data?.repo?.visibility === "private" || data?.repo?.visibility === "internal";
  useEffect(() => {
    if (data) onSection?.(closedRepo ? "me" : "rating");
  }, [data !== null, closedRepo]); // eslint-disable-line react-hooks/exhaustive-deps
  const crumbs: Crumb[] = [closedRepo ? { text: "Избранное", href: "/me" } : { text: "Рейтинг", href: lastRatingHref() }, { text: slugOf(org, repo) }];
  const own = live ?? (data?.job ? { phase: data.job.status, stalled: data.job.stalled } : null);
  const jobStalled = own?.stalled === true;
  const analysisRunning = own !== null;
  // на телефоне «Обновить анализ» — иконкой с подписью в подсказке и aria-label,
  // иначе строка действий не помещается
  const phoneBar = useMediaQuery("(max-width: 767px)");
  const refreshText = analysisRunning ? "Идет анализ" : "Обновить анализ";
  const refreshButton = canRefresh && phoneBar ? (
    <ActionTooltip title={refreshText}>
      <Button view="action" size="m" onClick={start.start} disabled={analysisRunning || start.sending} loading={start.sending || analysisRunning} aria-label={refreshText}>
        <Icon data={ArrowsRotateRight} size={16} />
      </Button>
    </ActionTooltip>
  ) : canRefresh && (
    <Button view="action" size="m" onClick={start.start} disabled={analysisRunning || start.sending} loading={start.sending}>
      {/* спиннер — в слоте `Button.Icon`: слот держит габарит и отступ, а голый `Spin`
          встает к тексту вплотную и налезает на первую букву */}
      {analysisRunning && (
        <Button.Icon side="start">
          <Spin size="xs" />
        </Button.Icon>
      )}
      {refreshText}
    </Button>
  );

  if (data === null && state.kind !== "error") {
    return (
      // скелетон повторяет ритм содержимого: блок показателей (~150px) и шесть строк
      // категорий по 45px
      <Page crumbs={crumbs} aside={<SkeletonRows rows={3} height={96} />} asideDrawer>
        <Flex direction="column" gap={3}>
          <SkeletonRows rows={1} height={150} />
          <SkeletonRows rows={6} height={45} />
        </Flex>
      </Page>
    );
  }
  if (data === null && state.kind === "error" && state.status === 404 && loggedIn) {
    // репо из избранного, которого нет в каталоге (закрытый, ни разу не анализировался), —
    // пустое состояние, а не ошибка «не удалось открыть»
    return <FavoriteNotInCatalog org={org} repo={repo} fallback={state.message} onRetry={reload} onSection={onSection} />;
  }
  if (data === null && state.kind === "error" && state.status === 404) {
    return <NotInCatalog org={org} repo={repo} crumbs={crumbs} />;
  }
  if (data === null) {
    // на странице ошибки «Обновить анализ» нет; повтор — «Повторить» (reload)
    return (
      <Page crumbs={crumbs}>
        <Alert
          theme="danger"
          view="outlined"
          className="rh-break-anywhere"
          title={`Не удалось открыть ${slugOf(org, repo)}`}
          message={state.kind === "error" ? state.message : undefined}
          // «Повторить» — только там, где повтор может помочь; на постоянном 404/400 он
          // повторял бы тот же отказ
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
    <CardActions
      org={org}
      repo={repo}
      scored={card.score !== null}
      badge={card.repo.badge}
      league={card.score?.rankBadge != null}
      publicBaseUrl={meta?.publicBaseUrl ?? window.location.origin}
      report={card.score !== null ? { mdHref: reportHref, pdfHref: `${cardUrl}/report.pdf`, pdfName: reportFileName(org, repo, "pdf") } : null}
      refresh={refreshButton}
    />
  );

  return (
    <Page crumbs={crumbs} actions={actions} aside={<ScoreAside card={card} meta={meta} analysis={own} foreignRunning={foreignRunning} />} asideDrawer>
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
          // идет анализ — свой или чужой/периодический; без обещания времени
          <EmptyState
            image={QueueIllustration}
            title={own?.phase === "queued" ? "Анализ запланирован" : "Идет анализ"}
            description={
              (own?.phase === "queued"
                ? "Заявка стоит в очереди – ее возьмут в работу, и здесь появится итог."
                : "Данные собираются – итог появится здесь.") +
              // задание зависло (признак сервера)
              (jobStalled ? " Анализ затянулся – его итог появится в «Очереди»." : "")
            }
          />
        ) : (
          // «анализа не было» ≠ «анализ был, но сбой или мало данных»; текст общий с отчетом
          // (`noScoreText`), действие — по возможностям зрителя
          <EmptyState
            image={EmptyIllustration}
            title={noScoreText(card.scan).title}
            description={noScoreText(card.scan).description}
            actions={
              canRefresh
                ? [{ text: card.scan ? "Повторить анализ" : "Запустить анализ", view: "action", size: "l", onClick: start.start }]
                : card.viewer?.auth === "no-pat"
                  ? [
                      // без токена неизвестно, свой ли репозиторий, поэтому анализ не
                      // обещаем: токен открывает CI/CD и Безопасность, анализ — только своих
                      { text: "Добавить токен в Настройках", view: "action", size: "l", href: "/settings" },
                    ]
                  : undefined
            }
          />
        )
      ) : (
        // одна лента без табов: показатели → категории («почему») → рекомендации
        // («что исправить») → AI-обзор → история
        <Flex direction="column" gap={6} className="rh-repo-feed">
          <Flex direction="column" gap={3}>
            {/* проверка оценки и признаки накрутки — подвалом плашки HealthCraft Index */}
            {/* без индекса проверять на накрутку и пересказывать нечего — кнопок нет */}
            <ScoreBand
              card={card}
              view={view}
              // в пустом репозитории проверять и пересказывать нечего: ни проверки активности, ни AI-обзора
              footer={card.score.healthcraftIndex === null || card.markers.codeEmpty ? undefined : <FraudCheckFooter card={card} org={org} repo={repo} onChanged={reload} loggedIn={loggedIn} quota={aiQuota.quota} onQuota={aiQuota.reload} />}
            />
          </Flex>
          <Categories card={card} view={view} />
          <Recommendations view={view} org={org} repo={repo} />
          {card.score.healthcraftIndex !== null && !card.markers.codeEmpty && <AiOverviewSection card={card} org={org} repo={repo} onChanged={reload} loggedIn={loggedIn} quota={aiQuota.quota} onQuota={aiQuota.reload} />}
          <HistorySection card={card} org={org} repo={repo} />
          <Limitations items={view.limitations} />
        </Flex>
      )}
    </Page>
  );
}

/**
 * Выбывший из каталога, закрытый или несуществующий репозиторий — одно спокойное пустое
 * состояние вместо красной ошибки. Текст один на все случаи: различимый 404 выдал бы
 * существование закрытого репозитория.
 */
function NotInCatalog({ org, repo, crumbs }: { org: string; repo: string; crumbs: Crumb[] }) {
  return (
    <Page crumbs={crumbs}>
      {/* гость по ссылке на закрытый репозиторий (так жюри открывает наш) получает
          выход — вход, после которого вернется на эту карточку; текст тот же для
          любого адреса и не выдает, существует ли закрытый репозиторий */}
      <EmptyState
        image={NotFoundIllustration}
        title="Репозиторий не найден"
            headingLevel={1}
        description="Возможно, он закрытый или в адресе ошибка. Закрытые репозитории открываются участникам после входа через Я ID."
        actions={[
          { text: "Войти", view: "action", size: "l", href: loginHref(`/repo/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, "") },
          { text: "К рейтингу", view: "normal", size: "l", href: lastRatingHref() },
        ]}
      />
    </Page>
  );
}
/**
 * Карточка репозитория из избранного, которого нет в каталоге сервиса: закрытый
 * репозиторий попадает в каталог только своим анализом, а анализ запускается только
 * для своих (права на CI/CD или Безопасность). Текст — по сохраненным правам строки
 * избранного (`last_access`), без обещаний.
 */
function FavoriteNotInCatalog({ org, repo, fallback, onRetry, onSection }: { org: string; repo: string; fallback: string; onRetry: () => void; onSection?: (s: "rating" | "me") => void }) {
  const favs = useJson<{ entries: { org: string; repo: string; access: { visibility: string; own: boolean } | null }[] }>("/api/me/favorites");
  const data = dataOf(favs.state);
  const inFavs = data?.entries.some((e) => e.org.toLowerCase() === org.toLowerCase() && e.repo.toLowerCase() === repo.toLowerCase()) === true;
  useEffect(() => {
    if (inFavs) onSection?.("me");
  }, [inFavs]); // eslint-disable-line react-hooks/exhaustive-deps
  const crumbs: Crumb[] = [{ text: "Избранное", href: "/me" }, { text: slugOf(org, repo) }];
  if (favs.state.kind === "loading") {
    return (
      <Page crumbs={crumbs}>
        <SkeletonRows rows={1} height={150} />
      </Page>
    );
  }
  const fav = data?.entries.find((e) => e.org.toLowerCase() === org.toLowerCase() && e.repo.toLowerCase() === repo.toLowerCase()) ?? null;
  if (fav === null) {
    return (
      <NotInCatalog org={org} repo={repo} crumbs={[{ text: "Рейтинг", href: lastRatingHref() }, { text: slugOf(org, repo) }]} />
    );
  }
  return <FavoriteNotInCatalogState org={org} repo={repo} own={fav.access?.own === true} access={fav.access} crumbs={crumbs} onRetry={onRetry} />;
}

/**
 * Состояние «в избранном, но не в каталоге»: своему — «Запустить анализ» прямо здесь
 * (сервер перепроверяет права живьем), итог задания перечитывает страницу; пока идет
 * анализ — без кнопки; чужому — объяснение.
 */
function FavoriteNotInCatalogState({
  org,
  repo,
  own,
  access,
  crumbs,
  onRetry,
}: {
  org: string;
  repo: string;
  own: boolean;
  access: { visibility: string; own: boolean } | null | undefined;
  crumbs: Crumb[];
  onRetry: () => void;
}) {
  const slug = `${org}/${repo}`;
  const start = useStartAnalysis(org, repo);
  const analysis = useAnalysis();
  const live = analysis.live(slug);
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => j.slug === slug)) onRetry();
  });
  if (live !== null) {
    return (
      <Page crumbs={crumbs}>
        <EmptyState
          image={QueueIllustration}
          title={live.phase === "queued" ? "Анализ запланирован" : "Идет анализ"}
          description={live.phase === "queued" ? "Заявка стоит в очереди – ее возьмут в работу, и здесь появится итог." : "Данные собираются – итог появится здесь."}
        />
      </Page>
    );
  }
  return (
    <Page crumbs={crumbs}>
      <EmptyState
        image={EmptyIllustration}
        title="Оценки пока нет"
        description={
          own
            ? "Репозиторий в вашем избранном, но анализа еще не было. Запустите его – итог появится здесь."
            : notOwnReason(access)
        }
        actions={
          own
            ? [{ text: start.sending ? "Запускаем…" : "Запустить анализ", view: "action", size: "l", onClick: start.start }]
            : [{ text: "К избранному", view: "normal", size: "l", href: "/me" }]
        }
      />
    </Page>
  );
}

/** Сбой выгрузки: HTTP-статус (0 — сети нет) и код сервера — для текста тоста. */
class ReportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`report ${status}`);
  }
}

/** Сколько ширины строки действий оставлять крошкам: меньше — имя репо уходило в «…». */
const CRUMBS_MIN = 280;

/**
 * Компактная строка действий: не хватает места крошкам (меньше `CRUMBS_MIN`) —
 * true. Порог считается от самой строки, а не от окна: ширину съедают rail,
 * «Задания» и «Как считается?», и брейкпоинт по окну то прятал кнопки зря, то
 * оставлял их, когда имя репо уже целиком уходило в многоточие. Обратно в полную
 * строку — только когда ширины хватит с запасом, без дребезга на границе.
 */
function useCompactBar(anchor: { current: HTMLElement | null }, phone: boolean): boolean {
  const [compact, setCompact] = useState(phone);
  const need = useRef(0);
  useLayoutEffect(() => {
    if (phone) {
      setCompact(true);
      return;
    }
    const bar = anchor.current?.closest<HTMLElement>(".rh-actionbar");
    const crumbs = bar?.querySelector<HTMLElement>(".rh-actionbar__crumbs");
    if (!bar || !crumbs) return;
    const check = () => {
      setCompact((was) => {
        if (!was) {
          const room = crumbs.clientWidth;
          if (room >= CRUMBS_MIN) return false;
          need.current = bar.clientWidth + (CRUMBS_MIN - room);
          return true;
        }
        return bar.clientWidth < need.current;
      });
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(bar);
    ro.observe(crumbs);
    return () => ro.disconnect();
  }, [anchor, phone]);
  return compact;
}

/**
 * Строка действий карточки: сравнить, бейдж, отчет, обновить анализ (главное действие
 * справа). Не хватает места (`useCompactBar`, на телефоне всегда) — остается главная
 * кнопка, а остальное, отчет тоже, уходит в меню «…». У репо без оценки «Сравнить»
 * нет — в сравнении у него был бы пустой столбец.
 */
function CardActions({ org, repo, scored, badge, league, publicBaseUrl, report, refresh }: { org: string; repo: string; scored: boolean; badge: boolean; league: boolean; publicBaseUrl: string; report: ReportFiles | null; refresh: ReactNode }) {
  const phone = useMediaQuery("(max-width: 767px)");
  const anchor = useRef<HTMLSpanElement>(null);
  const compact = useCompactBar(anchor, phone);
  // хуки — до любого ветвления: ширина меняет раскладку на лету
  const compare = useCompareState(org, repo);
  const reportDl = useReportDownload(report);
  // доступность бейджа знает сервер (поле карточки), без пробного запроса badge.svg
  const badgeOk = badge;
  const [badgeOpen, setBadgeOpen] = useState(false);
  if (!compact) {
    return (
      <Flex gap={2} alignItems="center">
        <span ref={anchor} hidden />
        {/* одна главная кнопка в шапке, как Clone у SourceCraft: у своего репо — «Обновить
            анализ», у чужого — «Сравнить», путь члена жюри и конкурента */}
        {scored && <CompareButton org={org} repo={repo} primary={!refresh} />}
        {/* бейдж — кнопкой с поповером, как Clone у SourceCraft */}
        {scored && <BadgeButton org={org} repo={repo} publicBaseUrl={publicBaseUrl} available={badge} league={league} />}
        {reportDl && <ReportMenu report={reportDl} />}
        {refresh}
      </Flex>
    );
  }
  // главная кнопка остается снаружи: «Обновить анализ» у своего, «Сравнить» у чужого
  // (на телефоне «Сравнить» — в меню: «В сравнении 1 из 3» не помещается)
  const compareOutside = scored && !refresh && !phone;
  const items = [
    ...(scored && !compareOutside
      ? [
          compare.full
            ? { text: "Сравнить – уже 3 из 3", disabled: true, iconStart: <Icon data={ScalesBalanced} size={16} />, action: () => undefined }
            : { text: compare.inSet ? "Открыть сравнение" : "Сравнить", iconStart: <Icon data={ScalesBalanced} size={16} />, action: compare.inSet ? compare.open : compare.add },
        ]
      : []),
    ...(scored && badgeOk ? [{ text: "Бейдж для README", iconStart: <Icon data={SealCheck} size={16} />, action: () => setBadgeOpen(true) }] : []),
    ...(reportDl ? reportDl.items.map((i) => ({ ...i, text: `Отчет: ${i.text}` })) : []),
  ];
  return (
    <Flex gap={2} alignItems="center">
      <span ref={anchor} hidden />
      {compareOutside && <CompareButton org={org} repo={repo} primary />}
      {refresh}
      {items.length > 0 && (
        <DropdownMenu
          size="m"
          items={items}
          popupProps={{ placement: "bottom-end" }}
          renderSwitcher={(props) => (
            <Button {...props} view="flat" size="m" aria-label="Еще действия" loading={reportDl?.busy != null}>
              <Icon data={Ellipsis} size={16} />
            </Button>
          )}
        />
      )}
      {badgeOk && <BadgeDialog org={org} repo={repo} publicBaseUrl={publicBaseUrl} league={league} open={badgeOpen} onClose={() => setBadgeOpen(false)} />}
    </Flex>
  );
}

/**
 * Набор сравнения вкладки для кнопки и пункта меню «Сравнить» (одно правило).
 * `add` добавляет репозиторий и остается на карточке: уведомление с «Открыть»
 * ведет в сравнение. Раньше кнопка сразу уводила на /compare, и за вторым
 * репозиторием приходилось идти назад через рейтинг.
 */
function useCompareState(org: string, repo: string): { inSet: boolean; full: boolean; count: number; add: () => void; open: () => void } {
  const toaster = useToaster();
  // набор живет в sessionStorage — после добавления кнопку надо перерисовать
  const [, setVersion] = useState(0);
  const slug = slugOf(org, repo);
  const set = lastCompareSet();
  const inSet = set.includes(slug);
  const open = (): void => navigate(compareHref(lastCompareSet()));
  const add = (): void => {
    const next = [...lastCompareSet().filter((s) => s !== slug), slug];
    rememberCompareSet(next);
    setVersion((v) => v + 1);
    toaster.add({
      name: "compare-added",
      theme: "success",
      title: "Добавлено в сравнение",
      content: next.length < 2 ? `В наборе 1 из ${COMPARE_MAX} – добавьте еще один репозиторий` : `В наборе ${next.length} из ${COMPARE_MAX}`,
      actions: [{ label: "Открыть", onClick: () => navigate(compareHref(next)), removeAfterClick: true }],
    });
  };
  return { inSet, full: !inSet && set.length >= COMPARE_MAX, count: set.length, add, open };
}

/**
 * «Сравнить» из карточки. Набор — последний набор сравнения вкладки (`lastCompareSet`,
 * как у пункта rail): есть место — добавляет, остается на странице и показывает
 * уведомление с переходом; репо уже в наборе — «В сравнении N из 3» ведет на
 * страницу сравнения; мест нет — кнопка выключена с причиной в подсказке.
 */
function CompareButton({ org, repo, primary = false }: { org: string; repo: string; primary?: boolean }) {
  const { inSet, full, count, add, open } = useCompareState(org, repo);
  if (full) {
    return (
      <ActionTooltip title={COMPARE_LIMIT_TEXT}>
        {/* выключенная кнопка не получает наведения — подсказка на обертке; обертка
            фокусируется, чтобы причину было слышно и с клавиатуры */}
        <span className="rh-disabled-tip" tabIndex={0} aria-label={`Сравнить: ${COMPARE_LIMIT_TEXT}`}>
          <Button view="normal" size="m" disabled>
            <Icon data={ScalesBalanced} size={16} />
            Сравнить
          </Button>
        </span>
      </ActionTooltip>
    );
  }
  return (
    <Button view={primary && !inSet ? "action" : "normal"} size="m" onClick={inSet ? open : add} title={inSet ? "Открыть сравнение" : `Добавить в сравнение (${count + 1} из ${COMPARE_MAX})`}>
      <Icon data={inSet ? Check : ScalesBalanced} size={16} />
      {inSet ? (
        <>
          В сравнении
          {/* счетчик тише подписи — как остаток лимита у кнопок AI */}
          <span className="rh-btn-count">{`${count} из ${COMPARE_MAX}`}</span>
        </>
      ) : (
        "Сравнить"
      )}
    </Button>
  );
}

/** Файлы отчета карточки: адреса Markdown и PDF и имя PDF (имя MD — от него). */
interface ReportFiles {
  mdHref: string;
  pdfHref: string;
  pdfName: string;
}

/** Выгрузка отчета и пункты меню «Markdown / PDF» — одни для кнопки «Отчет» и меню «…». */
interface ReportDownload {
  busy: "md" | "pdf" | null;
  items: { text: string; iconStart: ReactNode; disabled: boolean; action: () => void }[];
}

function useReportDownload(files: ReportFiles | null): ReportDownload | null {
  const toaster = useToaster();
  const [busy, setBusy] = useState<"md" | "pdf" | null>(null);
  const mdHref = files?.mdHref ?? "";
  const pdfHref = files?.pdfHref ?? "";
  const pdfName = files?.pdfName ?? "";
  const mdName = pdfName.replace(/\.pdf$/, ".md");
  // Обе выгрузки — fetch + blob: сбой (429/404/500) показывается тостом, а не сырым
  // JSON вместо приложения, как было бы при переходе по ссылке. Текст тоста — по коду
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
  if (!files) return null;
  const pdfBusy = busy === "pdf";
  return {
    busy,
    items: [
      { text: "Markdown (.md)", iconStart: <Icon data={LogoMarkdown} size={16} />, disabled: busy !== null, action: () => void download("md") },
      { text: pdfBusy ? "PDF (.pdf) – готовим…" : "PDF (.pdf)", iconStart: <Icon data={FileText} size={16} />, disabled: busy !== null, action: () => void download("pdf") },
    ],
  };
}

function ReportMenu({ report }: { report: ReportDownload }) {
  return (
    <DropdownMenu
      size="m"
      popupProps={{ placement: "bottom-end" }}
      renderSwitcher={(props) => (
        <Button {...props} view="normal" size="m" aria-haspopup="menu" loading={report.busy !== null}>
          <Icon data={ArrowDownToLine} size={16} />
          Отчет
          <Icon data={ChevronDown} size={16} />
        </Button>
      )}
      items={report.items}
    />
  );
}

/**
 * Запуск анализа (сервер проверяет доступ токена до постановки). Итог узнает общий
 * опрос заданий вкладки (session.tsx) по номеру задания — он же дает тост об итоге
 * на любом экране. Здесь — только отправка и ее исход; повторный клик на время
 * отправки заблокирован.
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
        // итог этого задания объявится, даже если оно попадет уже в базовую линию опроса
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
        // даже если ответ потерян, задание могло встать — узнаем у сервера
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
      {/* аватар l (42px) — по центру блока «название + мета» (layout.css) */}
      <div className="rh-repo-head">
        <RepoAvatar repo={r.repo} logoUrl={r.logoUrl} size="l" />
        <Flex direction="column" justifyContent="space-between" style={{ minWidth: 0 }}>
          <Flex gap={2} alignItems="center" className="rh-card-head__title">
            <RepoSlug org={r.org} repo={r.repo} variant="header-2" />
            {/* видимость в SourceCraft — той же плашкой, что в избранном; «неизвестно» плашки не дает */}
            <VisibilityPill value={view.visibility} />
            <Flex gap={1} alignItems="center">
              <ClipboardButton text={slugOf(r.org, r.repo)} size="s" view="flat-secondary" tooltipInitialText="Скопировать org/repo" tooltipSuccessText="Скопировано" />
              <FavoriteStar org={r.org} repo={r.repo} visibility={r.visibility} doneKey={starDoneKey} loggedIn={starLoggedIn} />
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
          {/* Две даты различены словом: «активность» — по каталогу SourceCraft, «анализ» —
              момент анализа, та же дата, что в шапке отчета (`analysisDate`). */}
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
 * «Рекомендации» — раздел ленты с якорем `#recommendations`. Роутер работает только с
 * `pushState` и якорь сам не прокручивает, а карточка грузится асинхронно, поэтому
 * прокрутка — эффектом после загрузки: по `#recommendations` и по старой ссылке
 * `?tab=recommendations` (письма и закладки продолжают вести к разделу).
 */
export const RECOMMENDATIONS_ID = "recommendations";

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

// ---------- правая панель: итог ----------

/**
 * Два показателя объясняются парой подсказок: тексты согласованы так, чтобы разница
 * читалась при чтении пары (4 категории и основа рейтинга против 6 категорий и доступа
 * участникам). Подсказка полного показателя стоит и в открытой, и в закрытой плашке —
 * про отличие спрашивают как раз там. В MD-отчете своя формулировка: документ читается
 * без наведения.
 */
const INDEX_HELP =
  "Публичная оценка по 4 категориям: документация, активность, задачи и состояние кода. " +
  "Считается для всех открытых репозиториев и является основой общего рейтинга.";

/** Ширина имен в паспорте анализа: «Полнота данных» с подсказкой и «Место в рейтинге» — в одну строку. */
const ASIDE_NAME_WIDTH = 160;

const FULL_HELP =
  "Рассчитывается по 6 категориям: 4 категориям HealthCraft Index, а также CI/CD и Безопасности. " +
  "Виден, если вашему токену доступны и CI/CD, и Безопасность репозитория.";

/** «Данные собраны» паспорта анализа: ok — «полностью», partial — «частично», bad — своей фразой, прочее — словом статуса. */
function collectedText(status: string): string {
  return status === "ok" ? "полностью" : status === "partial" ? "частично" : status === "bad" ? "не полностью – анализ завершился сбоем" : scanStatusText(status);
}

/**
 * Правая панель — паспорт анализа и короткая справка: «Анализ» (место, покрытие,
 * полнота сбора, запуск), «Шкала оценки», «Что учитывается», «Сведения». Вклад
 * категорий стоит под числами, недостающие данные — основанием у строки категории.
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
  /** идет чужой или периодический скан */
  foreignRunning: boolean;
}) {
  const { score, scan } = card;
  const threshold = fmtCoverage(meta?.coverageNullBelow ?? COVERAGE_NULL_BELOW);
  // покрытие обоих показателей – по номинальным весам Repo Health Score
  // (`coverageOf` в score/compute.ts): у индекса база – 65 открытых, у полного – 100
  const coverageHelp = `Какая доля открытых категорий (с учетом веса) собрана: веса как в Repo Health Score, всего 65. Ниже ${threshold} оценку не ставим.`;
  const fullCoverageHelp = `Какая доля всех шести категорий (с учетом веса) собрана, из 100. Ниже ${threshold} оценку не ставим.`;
  const full = score !== null && !score.fullLocked;
  return (
    <>
      <AsideSection title="Анализ">
        {/* ход анализа показывают кнопка в шапке и «Задания»; панель говорит только
            о затянувшемся */}
        {analysis?.stalled === true && (
          <Label theme="warning" size="xs">
            анализ затянулся – итог появится в «Очереди»
          </Label>
        )}
        {scan || score ? (
          <DefinitionList nameMaxWidth={ASIDE_NAME_WIDTH}>
            {score && (
              <DefinitionList.Item name="Место в рейтинге">
                {/* одно правило с отчетом и сравнением; без места — причина, а не «—» */}
                {rankText(card.repo.visibility, score)}
              </DefinitionList.Item>
            )}
            {score && !full && (
              <DefinitionList.Item name="Полнота данных" note={coverageHelp}>
                {fmtCoverage(score.indexCoverage)}
              </DefinitionList.Item>
            )}
            {/* при двух показателях — полнота каждого: индекса и полной оценки */}
            {score && full && (
              <DefinitionList.Item name="Полнота: индекс" note={`HealthCraft Index. ${coverageHelp}`}>
                {fmtCoverage(score.indexCoverage)}
              </DefinitionList.Item>
            )}
            {score && full && (
              <DefinitionList.Item name="Полнота: полная оценка" note={`Repo Health Score. ${fullCoverageHelp}`}>
                {score.repoHealthCoverage === null ? "—" : fmtCoverage(score.repoHealthCoverage)}
              </DefinitionList.Item>
            )}
            {scan && scan.status !== "running" && <DefinitionList.Item name="Данные собраны">{collectedText(scan.status)}</DefinitionList.Item>}
            {scan && scan.status !== "running" && <DefinitionList.Item name="Запуск">{scanTriggerText(scan.trigger)}</DefinitionList.Item>}
          </DefinitionList>
        ) : analysis !== null || foreignRunning ? null : (
          <Text color="secondary">Анализа еще не было</Text>
        )}
      </AsideSection>

      {/* та же легенда, что на рейтинге, но без абзаца под ней */}
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
            <MethodLink page="scores" />
          </Flex>
        </AsideSection>
      )}

      {scan && (
        <AsideSection title="Сведения">
          <DefinitionList nameMaxWidth={ASIDE_NAME_WIDTH}>
            <DefinitionList.Item name="Номер анализа">{scan.id}</DefinitionList.Item>
            {score && (
              <DefinitionList.Item name="Версия методики">
                <ModelVersion version={score.modelVersion} />
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
 * Показатели — первый экран главной колонки. У каждого своя плашка: число, уровень и
 * под ними полоса вклада категорий. На широком экране плашки стоят в ряд, на узком —
 * столбиком (`.rh-score-cards`, auto-fit). Закрытый Repo Health Score — своя плашка
 * с путем к нему по типу зрителя.
 */
function ScoreBand({ card, view, footer }: { card: Card; view: CardView; footer?: ReactNode }) {
  const score = card.score!;
  const barOf = (name: string) => view.contributions.find((b) => b.title.endsWith(name)) ?? null;
  return (
    <div className="rh-score-cards">
      <Card view="outlined" className="rh-score-band">
        <ScoreFigure title="HealthCraft Index" help={INDEX_HELP} total={score.healthcraftIndex} position={view.position} codeEmpty={card.markers.codeEmpty} />
        {score.healthcraftIndex === null && <NoScoreReason view={view} />}
        <ContributionStrip bar={barOf("HealthCraft Index")} />
        {footer}
      </Card>
      <Card view="outlined" className={view.fullPath ? "rh-score-band rh-score-band_locked" : "rh-score-band"}>
        {view.fullPath ? (
          // колонка на всю высоту плашки — кнопка входа у нижнего края
          <Flex direction="column" gap={1} style={{ minWidth: 0, flexGrow: 1 }}>
            <Flex gap={1} alignItems="center">
              <Text color="secondary">Repo Health Score</Text>
              <HelpMark iconSize="s" aria-label="Что такое «Repo Health Score»">
                <MetricHelp text={FULL_HELP} name={FULL} />
              </HelpMark>
            </Flex>
            {/* закрытый показатель не схлопывается в метку: заголовок — кому он виден,
                строка — путь к нему по типу зрителя, тот же текст, что в отчете (`fullScorePath`) */}
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
            <ScoreFigure title="Repo Health Score" help={FULL_HELP} total={score.repoHealthScore} codeEmpty={card.markers.codeEmpty} />
            <ContributionStrip bar={barOf("Repo Health Score")} />
          </>
        )}
        {/* плашка CI — и в закрытой карточке: доступ к CI есть, к Безопасности нет */}
        <Markers view={view} />
      </Card>
    </div>
  );
}

/**
 * Почему оценки нет — сразу под «Оценки нет», а не последним блоком ленты:
 * первая строка «Ограничений данных» (тот же текст, что в отчете) и путь в
 * методику обработки отсутствующих данных.
 */
function NoScoreReason({ view }: { view: CardView }) {
  return (
    <Flex direction="column" gap={1} alignItems="flex-start">
      <Text variant="body-1" color="complementary">
        {view.limitations[0] ?? "Данных собрано слишком мало для расчета: полнота данных ниже порога."}
      </Text>
      <MethodLink page="no-data">Как обрабатываются отсутствующие данные</MethodLink>
    </Flex>
  );
}

/**
 * Полоса вклада под своим числом: тонкий стек и легенда точками с переносом, как «Top
 * languages» SourceCraft и панель «Вклад категорий» рейтинга. Одна категория — один
 * цвет на обоих экранах (`categoryColorClass`); «не набрано» — последним, штриховкой.
 * Заголовка нет — полоса стоит в плашке своего показателя, имя в `aria-label`. Расчет
 * (`categoryContributions`) общий с отчетом. Наведение или фокус на сегмент либо пункт
 * легенды подсвечивает сегмент и показывает подсказку только с тем, чего на экране
 * нет: потолок категории и ее долю в оценке, у «не набрано» — где недобрано больше всего.
 */
function ContributionStrip({ bar }: { bar: CardView["contributions"][number] | null }) {
  const [active, setActive] = useState<string | null>(null);
  if (!bar) return null;
  const REST = "rest";
  const parts = [
    ...bar.segments.map((s) => ({ key: s.key, colorClass: s.colorClass, share: s.share, hint: s.hint, title: s.title, value: s.value, rest: false })),
    ...(bar.rest ? [{ key: REST, colorClass: "rh-cat-color_rest", share: bar.rest.share, hint: bar.rest.hint, title: bar.rest.title, value: bar.rest.value, rest: true }] : []),
  ];
  const hover = (key: string) => ({
    onMouseEnter: () => setActive(key),
    onMouseLeave: () => setActive((k) => (k === key ? null : k)),
    onFocus: () => setActive(key),
    onBlur: () => setActive((k) => (k === key ? null : k)),
  });
  const withTip = (hint: BarHint | null, node: ReactElement) =>
    hint ? (
      // Tooltip, а не ActionTooltip: у того заголовок — только строка, а число тише текста
      <Tooltip
        content={
          <>
            <span className="rh-tip-title">{hint.title}</span>
            {hint.main}
            {/* число тише текста — как счетчик у кнопок, без «·» */}
            {hint.muted && <span className="rh-tip-muted">{hint.muted}</span>}
          </>
        }
        className="rh-tip-oneline"
      >
        {node}
      </Tooltip>
    ) : (
      node
    );
  return (
    <div className={active ? "rh-contrib rh-contrib_card rh-contrib_focus" : "rh-contrib rh-contrib_card"} role="group" aria-label={bar.title}>
      {bar.note !== null ? (
        <Text as="p" color="complementary" className="rh-contrib__note">
          {bar.note}
        </Text>
      ) : (
        <>
          {/* сегменты — только для мыши: с клавиатуры то же дает легенда. Категория с
              нулевым вкладом остается полоской 2px (min-width), пустой остаток не рисуется */}
          <div className="rh-contrib__bar" aria-hidden="true">
            {parts
              .filter((p) => !p.rest || p.share > 0)
              .map((p) => (
                <Fragment key={p.key}>
                  {withTip(
                    p.hint,
                    <i
                      className={`rh-contrib__seg ${p.colorClass}${active === p.key ? " rh-contrib_on" : ""}`}
                      style={{ flexGrow: p.share * 1000 }}
                      {...hover(p.key)}
                    />,
                  )}
                </Fragment>
              ))}
          </div>
          <ul className="rh-contrib__legend">
            {parts.map((p) => (
              <Fragment key={p.key}>
                {withTip(
                  p.hint,
                  <li
                    className={`rh-contrib__item${active === p.key ? " rh-contrib_on" : ""}`}
                    tabIndex={p.hint ? 0 : undefined}
                    aria-label={p.hint ? `${p.title} – ${p.value}: ${hintText(p.hint)}` : undefined}
                    {...hover(p.key)}
                  >
                    <i className={`rh-contrib__dot ${p.colorClass}`} aria-hidden="true" />
                    {p.rest ? (
                      <Text variant="body-1" color="secondary">
                        {p.title} – {p.value}
                      </Text>
                    ) : (
                      <>
                        <Text variant="body-1">{p.title}</Text>
                        <Text variant="body-1" color="secondary" className="rh-contrib__share">
                          – {p.value}
                        </Text>
                      </>
                    )}
                  </li>,
                )}
              </Fragment>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Подсказка показателя: определение и веса категорий списком «Документация ····· 23%»,
 * чтобы расчет можно было проверить самому. Веса номинальные и одинаковы для всех
 * репозиториев, поэтому у закрытого Repo Health Score они тоже видны.
 */
function MetricHelp({ text, name }: { text: string; name: typeof INDEX | typeof FULL }) {
  return (
    <Flex direction="column" gap={2}>
      <Text>{text}</Text>
      {/* список на всю ширину подсказки: отточие тянется, вес — у правого края */}
      <DefinitionList responsive className="rh-weights">
        {metricWeights(name).map((w) => (
          <DefinitionList.Item key={w.key} name={w.title}>
            {w.weight}
          </DefinitionList.Item>
        ))}
      </DefinitionList>
    </Flex>
  );
}

/**
 * Число показателя и уровень. В пустом репозитории 0 — не «зона риска», а «оценивать
 * нечего»: число серым и метка «нет кода» (причина — строкой под ним).
 */
function ScoreFigure({ title, help, total, position, codeEmpty = false }: { title: string; help: string; total: number | null; position?: PositionView | null; codeEmpty?: boolean }) {
  return (
    <Flex direction="column" gap={1} style={{ minWidth: 0 }}>
      <Flex gap={1} alignItems="center">
        <Text color="secondary">{title}</Text>
        <HelpMark iconSize="s" aria-label={`Что такое «${title}»`}>
          <MetricHelp text={help} name={title === INDEX ? INDEX : FULL} />
        </HelpMark>
      </Flex>
      {total === null ? (
        <span className="rh-chip-fit">
          <Label theme="unknown" size="s">
            {NO_SCORE}
          </Label>
        </span>
      ) : (
        // блок позиции прижат вправо над полосой вклада: сверху плашка лиги, снизу место и
        // процент похожих; не хватает места рядом с числом — уходит строкой ниже, тоже вправо
        <div className="rh-score-figure__row">
          <Flex gap={2} alignItems="baseline" wrap className="rh-score-figure__value">
            <Text variant="display-2" color={codeEmpty ? "secondary" : undefined}>
              {fmtScore(total)}
            </Text>
            <Text color="secondary">из 100</Text>
            {codeEmpty ? (
              <Label theme="unknown" size="s">
                нет кода
              </Label>
            ) : (
              <Label theme={scoreLabelTheme(total)} size="s">
                {sentence(scoreWord(total))}
              </Label>
            )}
          </Flex>
          {position ? <PositionLine position={position} /> : null}
        </div>
      )}
    </Flex>
  );
}

function PositionLine({ position }: { position: PositionView }) {
  return (
    <Flex direction="column" gap={1} alignItems="flex-end" className="rh-position">
      {position.league ? (
        <ActionTooltip title={position.league.hint}>
          <span className={`rh-league rh-league_${position.league.tier}`} tabIndex={0} aria-label={`${position.league.label}. ${position.league.hint}`}>
            <Icon data={Trophy} size={14} />
            {position.league.label}
          </span>
        </ActionTooltip>
      ) : null}
      {/* подсказка ⓘ — в строке текста, после неразрывного пробела: на телефоне не отрывается
          от последнего слова на свою строку */}
      <Text color="secondary" className="rh-position__line">
        {/* title — только на тексте: у ⓘ свой тултип, иначе всплывали бы оба */}
        <span title="Место в публичном рейтинге по HealthCraft Index">
          {position.rank}
          {position.cohort ? `, ${position.cohort}` : ""}
        </span>
        {position.cohortHelp ? (
          <>
            {"\u00a0"}
            <HelpMark iconSize="s" aria-label="Кто такие похожие" className="rh-position__help">
              {position.cohortHelp}
            </HelpMark>
          </>
        ) : null}
      </Text>
    </Flex>
  );
}

// ---------- категории ----------

/**
 * Строка категории: раскрытие · название · полоса · балл · плашка уровня; под
 * названием — основание (тот же текст, что колонка «Основание» PDF). Полосы серые —
 * цвет несет только плашка. Закрытые зрителю CI/CD и Безопасность — не строками,
 * а одной плашкой под списком.
 */
function Categories({ card, view }: { card: Card; view: CardView }) {
  const strengths = strengthsLine(card);
  const notInScore = notInScoreNote(card);
  return (
    <section className="rh-section" aria-labelledby="rh-categories-title">
      <Card view="outlined" className="rh-section-card">
        <Text variant="subheader-3" as="h2" id="rh-categories-title" className="rh-section__title">
          Категории
        </Text>
        {/* сильные стороны и что требует внимания — строкой под заголовком; тот же текст, что в MD/PDF */}
        {strengths !== null && (
          <Text as="p" variant="body-1" color="complementary" className="rh-strengths">
            {strengths}
          </Text>
        )}
        {/* «не участвует и не снижает» — один раз на список, у строк только причина */}
        {notInScore !== null && (
          <Text as="p" variant="body-1" color="secondary" className="rh-strengths">
            {notInScore}
          </Text>
        )}
        <ul className="rh-list" style={{ borderTop: 0 }}>
          {view.categories.map((c) => (
            // при первом заходе ни одна категория не раскрыта: автораскрытие худшей путало
            <CategoryRow key={c.key} category={c} card={card} />
          ))}
        </ul>
        {view.locked && <LockedCategories text={view.locked.text} />}
      </Card>
    </section>
  );
}

/**
 * Плашка закрытых категорий: одно предложение без заголовка — `ACCESS_LOCK_SHORT` по
 * причине, тот же текст, что в отчете; при разных причинах — по предложению на
 * категорию. Призыва внутри нет: единственный призыв стоит у закрытого Repo Health Score.
 */
function LockedCategories({ text }: { text: string }) {
  return <Alert theme="info" view="filled" size="s" align="center" className="rh-locked-note" message={text} />;
}

function CategoryRow({ category: c, card, defaultOpen = false }: { category: CategoryView; card: Card; defaultOpen?: boolean }) {
  const key = c.key;
  const cat = card.score!.categories[key]!;
  const [open, setOpen] = useState(defaultOpen);
  // ссылки на категорию из других блоков (признаки накрутки, AI-обзор) раскрывают строку
  useEffect(() => {
    const onOpen = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === key) setOpen(true);
    };
    window.addEventListener(OPEN_CATEGORY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CATEGORY_EVENT, onOpen);
  }, [key]);
  const aiNote = categoryAiNote(card, key);
  const subs = Object.entries(cat.submetrics);
  // у категории без данных раскрывать нечего
  const expandable = c.score !== null && (subs.length > 0 || c.partialNote !== null);

  const row = (
    <>
      {expandable ? <ArrowToggle direction={open ? "bottom" : "right"} size={14} /> : <span />}
      <span className="rh-category__name">
        <span className="rh-category__title">
          <Text variant="subheader-1">{c.title}</Text>
          {/* искра — у категории есть разбор модели */}
          <CategoryAiMark card={card} categoryKey={key} hasData={c.score !== null} />
          {c.stale && (
            <Label theme="warning" size="xs">
              {STALE_CATEGORY_MARK}
            </Label>
          )}
        </span>
        <Text variant="body-1" color="complementary" className="rh-category__why">
          {c.why}
        </Text>
      </span>
      {/* Tri-state: без данных на месте полосы пусто — единственный прочерк стоит в
          колонке балла, рядом с плашкой «Нет данных» */}
      {/* полоса — только для глаза: балл уже звучит числом рядом, иначе он читался дважды */}
      <span className="rh-category__bar" aria-hidden="true">
        {c.score === null ? null : <ScoreBar value={c.score} width="100%" label={`${c.scoreText} из 100`} />}
      </span>
      <Text variant="subheader-2" color={c.score === null ? "secondary" : undefined} className="rh-category__value">
        {c.scoreText}
      </Text>
      {/* уровень несет цвет полосы — плашки «Требует внимания» и «В зоне риска»
          повторяли его словами; плашка остается только у «Нет данных», где
          полосы нет */}
      {c.score === null ? (
        <Label theme={c.chip.theme} size="xs" className="rh-category__word">
          {c.chip.text}
        </Label>
      ) : (
        <span />
      )}
    </>
  );

  return (
    <li className="rh-list__item" style={{ padding: 0 }} id={categoryAnchor(key)}>
      {/* строка — заголовок H3 (аккордеон: кнопка внутри заголовка), между категориями
          можно ходить по заголовкам */}
      <h3 className="rh-category__h">
        {expandable ? (
          <button type="button" className="rh-category" aria-expanded={open} aria-controls={`${categoryAnchor(key)}-subs`} onClick={() => setOpen(!open)}>
            {row}
          </button>
        ) : (
          <span className="rh-category">{row}</span>
        )}
      </h3>
      {open && expandable && (
        <div className="rh-subrows" id={`${categoryAnchor(key)}-subs`}>
          {c.cohortNote && (
            <Text variant="body-1" color="complementary" className="rh-subrows__note">
              {c.cohortNote}
            </Text>
          )}
          {/* примечание частичной нехватки данных — внутри раскрытия (в MD его нет в строке) */}
          {c.partialNote && (
            <Text variant="body-1" color="complementary" className="rh-subrows__note">
              {c.partialNote}
            </Text>
          )}
          {/* Шапка подписывает только числовые колонки — над именем метрики подпись не
              нужна. Сетка живет на `.rh-subrows`, строки раскрываются в нее через
              `display: contents`: иначе у каждой строки был бы свой `auto` и подпись не
              встала бы над значениями. Вес — тот же, что в разборе PDF (`submetricWeightText`). */}
          {/* табличная семантика поверх грида: строки — `display: contents` */}
          <div className="rh-subrows__table" role="table" aria-label={`Показатели категории «${c.title}»`}>
          <div className="rh-subrows__head" role="row">
            <span role="columnheader">Значение</span>
            <span role="columnheader">Вес</span>
            <span role="columnheader">Балл</span>
          </div>
          {subs.map(([subKey, sub]) => (
            <div key={subKey} className="rh-subrow" role="row">
              {/* Имя, пунктирный лидер и значение — одна ячейка: в разных колонках грида
                  между ними зияла пустота и строка распадалась надвое. Цвет имени говорит
                  о весе: справочные подметрики приглушены, взвешенные — основным цветом. */}
              <span className="rh-subrow__head" role="cell">
                <Text color="secondary" className="rh-subrow__icon">
                  <Icon data={submetricIcon(key, subKey)} size={14} />
                </Text>
                <Text color={displayOnly(key, subKey) ? "secondary" : undefined} className="rh-subrow__name">
                  {submetricTitle(key, subKey)}
                </Text>
                <span className="rh-subrow__lead" aria-hidden="true" />
                {/* Значение — по словарю подметрик (`src/report/submetrics.ts`), тому же,
                    что у MD и PDF: единица, масштаб, округление. Сырое значение печатает
                    только поповер основания — это доказательная база. Служебная заметка
                    расчета показывается словами из словаря, примечание — в подсказке. */}
                <Text
                  color="secondary"
                  className="rh-subrow__value"
                  title={`значение: ${submetricShownValue(key, subKey, sub, submetricContext(card.score?.computedAt), cat.submetrics)}${submetricNote(key, subKey, sub.note)?.remark ? `. ${submetricNote(key, subKey, sub.note)!.remark}` : ""}`}
                >
                  {submetricShownValue(key, subKey, sub, submetricContext(card.score?.computedAt), cat.submetrics)}
                </Text>
              </span>
              {/* В колонках веса и балла — только числа, без полос и слов: слова «без веса»
                  и «нет данных» шире числа и сбивали бы правый столбик. Вместо них прочерк —
                  тот же знак отсутствующего числа, что везде (`fmtScore`), он никогда не
                  читается нулем. Что именно отсутствует, говорят подсказка и цвет имени. */}
              <Text className="rh-subrow__score" color="secondary" role="cell">
                {submetricWeightText(key, subKey)}
              </Text>
              {displayOnly(key, subKey) || sub.score === null ? (
                <Text
                  className="rh-subrow__score"
                  role="cell"
                  color="secondary"
                  title={displayOnly(key, subKey) ? "Показывается для справки, в балл категории не входит" : NO_DATA}
                >
                  —
                </Text>
              ) : (
                <Text className="rh-subrow__score" role="cell">
                  {fmtSubmetric(sub.score)}
                </Text>
              )}
            </div>
          ))}
          </div>
          {key === "security" && <AppsecEngines card={card} />}
          {key === "code" && <OwnershipMap category={cat} />}
          {aiNote !== null && <CategoryAiNote note={aiNote} card={card} />}
        </div>
      )}
    </li>
  );
}

// ---------- маркеры расчёта: предупреждения наверху и «Ограничения данных» ----------

/**
 * Особенности расчета внизу плашки Repo Health Score. Единственное предупреждение (CI
 * настроен, запусков не видно) касается только CI/CD, а она входит только в Repo Health
 * Score. `warning` — оговорка о самом расчете, `info` — граница данных; прочие
 * ограничения (прошлый анализ, лимит сервиса, усеченная история) стоят одним списком
 * в «Ограничениях данных», тем же текстом, что в PDF.
 */
function Markers({ view }: { view: CardView }) {
  const rows: { key: string; label: string; text: string; theme: "info" | "warning" }[] = [];
  if (view.topMarkers.includes("ci-cap")) {
    rows.push({
      key: "ci-cap",
      // тот же текст печатает отчет строкой под показателями
      label: CI_CAP_TITLE,
      text: CI_CAP_TEXT,
      theme: "warning",
    });
  }
  if (rows.length === 0) return null;
  return (
    <Flex direction="column" gap={2} role="region" aria-label="Особенности расчета" className="rh-score-band__foot">
      {[...rows].sort((a, b) => (a.theme === b.theme ? 0 : a.theme === "warning" ? -1 : 1)).map((row) => (
        <Alert key={row.key} theme={row.theme} view="filled" size="s" align="baseline" title={row.label} message={row.text} />
      ))}
    </Flex>
  );
}

/** «Ограничения данных»: `limitations` отчета тем же текстом, пункт — info-плашка; пусто — раздела нет. */
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
            <Alert key={text} theme="info" view="filled" size="s" align="center" message={text} />
          ))}
        </Flex>
      </Card>
    </section>
  );
}

// ---------- рекомендации ----------

/**
 * Рекомендации. Номер слева — порядок «что исправить первым» (`cardView`): правила
 * серьезности, затем по приросту индекса — числу или потолку у правил без числа;
 * действие заголовком, ниже причина, справа ожидаемый эффект. Основание — словами (подметрика правила и ее значение), по клику —
 * источник, время сбора и сырые данные.
 */
function Recommendations({ view, org, repo }: { view: CardView; org: string; repo: string }) {
  // режим «По шагам» — лестница к зоне «Здоров»
  const [mode, setMode] = useState<"single" | "steps">("single");
  const ladder = view.ladder;
  const steps = mode === "steps" && ladder !== null;
  return (
    // рекомендаций нет — раздел без заголовка, но строка об этом остается: иначе
    // читатель не поймет, потерялся раздел или улучшать нечего
    view.recommendations.length === 0 ? (
      <section className="rh-section" id={RECOMMENDATIONS_ID} aria-label="Рекомендации">
        <Card view="outlined" className="rh-section-card">
          <Flex gap={2} alignItems="center">
            {/* галочка — только когда улучшать действительно нечего */}
            <Icon data={view.noRecommendationsKind === "healthy" ? CircleCheck : CircleInfo} size={16} className="rh-muted-icon" />
            <Text color="complementary">{view.noRecommendations}</Text>
          </Flex>
        </Card>
      </section>
    ) : (
      <section className="rh-section" id={RECOMMENDATIONS_ID} aria-labelledby="rh-recommendations-title">
        <Card view="outlined" className="rh-section-card">
          <Flex gap={2} alignItems="center" justifyContent="space-between" wrap className="rh-recs__head">
            <Text variant="subheader-3" as="h2" id="rh-recommendations-title" className="rh-section__title">
              Рекомендации
            </Text>
            {ladder !== null && (
              <SegmentedRadioGroup size="m" value={mode} onUpdate={(v) => setMode(v === "steps" ? "steps" : "single")} aria-label="Как показать рекомендации">
                <SegmentedRadioGroup.Option value="single">По отдельности</SegmentedRadioGroup.Option>
                <SegmentedRadioGroup.Option value="steps">По шагам</SegmentedRadioGroup.Option>
              </SegmentedRadioGroup>
            )}
          </Flex>
          {steps ? (
            <>
              <ol className="rh-list rh-recs" style={{ borderTop: 0 }} aria-label="Шаги к зоне «Здоров»">
                {ladder.steps.map((s) => (
                  <RecommendationRow key={s.item.rec.ruleId} item={s.item} org={org} repo={repo} stepEffect={s.effect} />
                ))}
              </ol>
              <Flex gap={1} alignItems="center" className="rh-recs__summary" aria-live="polite">
                <Text color="complementary">{ladder.summary}</Text>
                <HelpMark iconSize="s" aria-label="Как считаются шаги">
                  {LADDER_HELP}
                </HelpMark>
              </Flex>
              {ladder.rest.length > 0 && (
                <>
                  <Text variant="caption-2" color="secondary" className="rh-recs__rest-title">
                    Остальные рекомендации
                  </Text>
                  <ol className="rh-list rh-recs">
                    {ladder.rest.map((r) => (
                      <RecommendationRow key={r.rec.ruleId} item={r} org={org} repo={repo} />
                    ))}
                  </ol>
                </>
              )}
            </>
          ) : (
            <ol className="rh-list rh-recs" style={{ borderTop: 0 }}>
              {view.recommendations.map((r) => (
                <RecommendationRow key={r.rec.ruleId} item={r} org={org} repo={repo} />
              ))}
            </ol>
          )}
        </Card>
      </section>
    )
  );
}

function RecommendationRow({ item, org, repo, stepEffect }: { item: RecommendationView; org: string; repo: string; stepEffect?: string }) {
  const { rec } = item;
  return (
    <li className="rh-list__item rh-rec">
      <Text variant="subheader-1" color="secondary" className="rh-rec__n">
        {item.n}
      </Text>
      <Flex direction="column" gap={1} className="rh-rec__body">
        {/* заголовок — действие (глагол), ниже причина, как в отчете; кегль и ритм — как
            у строки категории */}
        <Text variant="subheader-1">{rec.action}</Text>
        <Text variant="body-1" color="complementary">
          {rec.problem}
        </Text>
        <Flex gap={2} wrap alignItems="center" className="rh-rec__basis">
          <Text variant="body-short" color="secondary">
            Показатель:
          </Text>
          <Popover trigger="click" placement={["bottom-start", "top-start"]} content={<FactProof item={item} />} aria-label={`Исходные данные: ${item.label}`}>
            <Label theme="info" size="xs" interactive>
              <Flex gap={1} alignItems="center">
                {item.label}
                <Icon data={ChevronDown} size={12} />
              </Flex>
            </Label>
          </Popover>
        </Flex>
        {rec.fixTemplate ? (
          <Flex gap={2} wrap alignItems="center" className="rh-rec__basis">
            <Text variant="body-short" color="secondary">
              Файл шаблона:
            </Text>
            <FixTemplateButton org={org} repo={repo} ruleId={rec.ruleId} meta={rec.fixTemplate} />
          </Flex>
        ) : null}
      </Flex>
      <div className="rh-rec__effect">
        {/* подписи над плашкой нет: плашка называет показатель сама («к HealthCraft
            Index», «Индекс 61») — подпись в каждой строке повторяла одно и то же */}
        {stepEffect !== undefined ? (
          <Label theme="unknown" size="xs" title="Индекс после этого шага, если выполнить и все шаги выше; в скобках – прирост шага">
            {`Индекс ${stepEffect}`}
          </Label>
        ) : item.effectPill ? (
          <>
            {/* зеленый цвет — только для здоровья, поэтому эффект — нейтральной серой плашкой */}
            <Label
              theme="unknown"
              size="xs"
              title={
                item.ceiling !== null
                  ? "Верхняя граница: столько индекс получит, если показатель этой рекомендации дойдет до максимума"
                  : "Прирост показателя, если выполнить только эту рекомендацию"
              }
            >
              {item.effect}
            </Label>
            {item.effectNote !== null && (
              <Text variant="caption-2" color="secondary">
                {item.effectNote}
              </Text>
            )}
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

/** Подписи лицензий в меню заготовки LICENSE; значения по умолчанию нет — лицензию выбирает автор. */
const LICENSE_TITLES: Record<string, string> = { mit: "MIT", "apache-2.0": "Apache 2.0" };

/** Текст тоста, если заготовка не скачалась (по коду ответа). */
export function fixFailureText(status: number): string {
  if (status === 0) return "Нет связи с сервером – проверьте подключение и попробуйте еще раз.";
  if (status === 429) return "Слишком много запросов – попробуйте через минуту.";
  if (status === 404) return "Заготовка для этого репозитория больше не нужна – обновите страницу.";
  return "Не удалось подготовить файл – попробуйте позже.";
}

/**
 * Заготовка файла для рекомендации — тихой кнопкой; у лицензии — меню выбора без значения
 * по умолчанию. Скачивание — fetch + blob, как у отчета: сбой показывается тостом, а не
 * сырым JSON вместо приложения.
 */
function FixTemplateButton({ org, repo, ruleId, meta }: { org: string; repo: string; ruleId: string; meta: NonNullable<RecommendationView["rec"]["fixTemplate"]> }) {
  const toaster = useToaster();
  const [busy, setBusy] = useState(false);
  const base = `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/fix/${encodeURIComponent(ruleId)}`;
  const download = async (license?: string): Promise<void> => {
    setBusy(true);
    const href = license ? `${base}?license=${encodeURIComponent(license)}` : base;
    try {
      let res: Response;
      try {
        res = await fetch(href);
      } catch {
        throw new ReportError(0, null);
      }
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("text/plain")) throw new ReportError(res.ok ? 500 : res.status, null);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = meta.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toaster.add({
        name: `fix-failed:${href}`,
        theme: "danger",
        title: `${meta.filename} не скачан`,
        content: fixFailureText(e instanceof ReportError ? e.status : 500),
      });
    } finally {
      setBusy(false);
    }
  };
  // поля заготовок (src/fix/templates.ts) – в угловых скобках `<…>`, у CODEOWNERS – `@login`
  const hint =
    ruleId === "readme-sections-missing"
      ? "Скачать заготовку: только недостающие разделы – добавьте их в свой README и заполните поля в угловых скобках <…>"
      : ruleId === "codeowners-missing"
        ? "Скачать заготовку: положите файл в корень репозитория и замените @login на логины ответственных"
        : "Скачать заготовку: положите файл в корень репозитория и заполните поля в угловых скобках <…>";
  if (meta.licenses && meta.licenses.length > 0) {
    return (
      <DropdownMenu
        size="m"
        popupProps={{ placement: "bottom-start" }}
        renderSwitcher={(props) => (
          <Button {...props} view="flat-secondary" size="s" aria-haspopup="menu" loading={busy} title="Скачать заготовку LICENSE: лицензию выбирает автор" className="rh-rec__fix">
            <Icon data={ArrowDownToLine} size={14} />
            {meta.filename}
            <Icon data={ChevronDown} size={14} />
          </Button>
        )}
        items={[
          { text: "Выберите тип лицензии", disabled: true, action: () => undefined },
          ...meta.licenses.map((id) => ({ text: LICENSE_TITLES[id] ?? id, action: () => void download(id) })),
        ]}
      />
    );
  }
  return (
    <Button view="flat-secondary" size="s" loading={busy} onClick={() => void download()} title={hint} className="rh-rec__fix">
      <Icon data={ArrowDownToLine} size={14} />
      {meta.filename}
    </Button>
  );
}

/** Поповер основания: заголовок-ярлык; по каждому факту — источник словами, время сбора, факт словами, сырые данные свернутыми и ключ мелко. */
function FactProof({ item }: { item: RecommendationView }) {
  return (
    <Flex direction="column" gap={3} className="rh-proof">
      <Text variant="subheader-1">{item.label}</Text>
      {item.facts.map(({ key, fact, missing }) => (
        <FactBlock key={key} factKey={key} fact={fact} missing={missing} />
      ))}
    </Flex>
  );
}

function FactBlock({ factKey, fact, missing }: { factKey: string; fact: Evidence | null; missing: boolean }) {
  if (!fact) {
    return (
      <Flex direction="column" gap={1}>
        {/* факта нет в анализе — так и говорим; закрыт доступом — про доступ (про AppSec —
            только у фактов Безопасности) */}
        <Text color="complementary">
          {missing
            ? "Этих данных нет в последнем анализе."
            : factKey.startsWith("appsec")
              ? `Эти данные вам недоступны. ${SECURITY_PUBLIC_NOTE}`
              : "Эти данные видны участникам репозитория."}
        </Text>
        <Text variant="caption-2" color="secondary">
          {factKey}
        </Text>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap={1}>
      <Flex gap={2} wrap alignItems="center">
        <Text variant="body-short" color="complementary">
          Источник: {sourceWord(fact.source)}
        </Text>
        <Text variant="body-short" color="secondary">
          собрано {fmtDateTime(fact.collectedAt)}
        </Text>
        {fact.status !== "ok" && (
          <Label theme={fact.status === "bad" ? "warning" : "unknown"} size="xs">
            {sentence(factStatusText(fact.status))}
          </Label>
        )}
      </Flex>
      {/* факт словами; сырое значение — свернутым под «Исходные данные» */}
      {factWords(fact.key, fact.status, fact.value).map((l) => (
        <Text key={l} variant="body-short">
          {l}
        </Text>
      ))}
      <Disclosure size="m" summary="Исходные данные" className="rh-proof__raw-toggle">
        <pre className="rh-code rh-proof__raw">{fmtFactValue(fact.value)}</pre>
      </Disclosure>
      <Text variant="caption-2" color="secondary">
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

/**
 * Иконка каждой подметрики. Не украшение: строк в раскрытой категории до девяти, все
 * одним кеглем, и глиф слева позволяет найти строку повторно, не перечитывая название.
 * Названия подметрик живут в словаре `src/report/submetrics.ts` (общем с MD и PDF),
 * иконки — здесь, это вид. Все из `@gravity-ui/icons`, своих рисунков не заводим;
 * незнакомый ключ получает нейтральную точку.
 */
const SUBMETRIC_ICONS: Record<string, IconData> = {
  "documentation.readme": FileText,
  "documentation.license": ScalesBalanced,
  "documentation.contributing": Persons,
  "documentation.codeowners": PersonGear,
  "cicd.config": Pipeline,
  "cicd.pass_rate": CircleCheck,
  "cicd.duration": Stopwatch,
  "cicd.stability": ChartLine,
  "security.density": Bug,
  "security.resolved": ShieldCheck,
  "security.secrets": Key,
  "activity.fresh": Clock,
  "activity.freq": Pulse,
  "activity.bus_factor": Persons,
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
  "issues.backlog_trend": ArrowUpArrowDown,
  "issues.monthly_flow": ChartColumn,
  "code.density": Flag,
  "code.old_share": CalendarXmark,
  "code.tests": CircleCheck,
  "code.root": FolderTree,
  "code.todo_total": Hashtag,
  // справочные показатели ревью PR и карта владельцев
  "activity.pr_review": CodePullRequest,
  "activity.pr_first_response": Comment,
  "activity.pr_waiting": Hourglass,
  "activity.pr_review_comments": Comments,
  "activity.pr_merge_time": CodeMerge,
  "code.ownership": Person,
};

function submetricIcon(category: string, sub: string): IconData {
  return SUBMETRIC_ICONS[`${category}.${sub}`] ?? Circle;
}

/**
 * Разбивка находок AppSec по движкам — счетчики из факта коллектора (`appsec.ts`,
 * поле `backlog.engines`), чтобы было видно, чем найдены находки.
 *
 * SCA — отдельной строкой: это другой класс находок (зависимости, а не свой код).
 * Находки SCA входят в общий счет открытых находок и плотность наравне с остальными;
 * отдельная строка – только для наглядности (формула от разбивки не зависит). Имя движка не
 * угадывается: в SCA-строку идет счетчик, чье имя похоже на SCA, остальные печатаются как есть.
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

/**
 * Находки AppSec по видам проверок — внутри раскрытия «Безопасности», под таблицей
 * подметрик и теми же строками (имя, лидер, значение). Колонки веса и балла — прочерк:
 * в балл категории разбивка не входит.
 */
function AppsecEngines({ card }: { card: Card }) {
  const breakdown = appsecBreakdown(card);
  if (!breakdown || (breakdown.engines.length === 0 && breakdown.sca === null)) return null;
  const rows: { name: string; count: number; note?: string }[] = [
    ...breakdown.engines.map(([name, count]) => ({ name, count })),
    ...(breakdown.sca
      ? [{ name: `${breakdown.sca[0]} (зависимости, SCA)`, count: breakdown.sca[1], note: "Находки в зависимостях входят в оценку Безопасности наравне с остальными. Здесь они показаны отдельной строкой для наглядности." }]
      : []),
  ];
  const notes = [
    breakdown.sca === null ? "SourceCraft не вернул отдельное число находок в зависимостях (SCA)." : null,
    breakdown.truncated ? "Список групп находок усечен предохранителем пагинации: счетчики показывают собранную часть." : null,
  ].filter((n): n is string => n !== null);
  return (
    <>
      <Text variant="caption-2" color="secondary" className="rh-subrows__group">
        {`Открытые находки по видам проверок${breakdown.openFindings !== null ? ` – всего ${fmtNumber(breakdown.openFindings)}` : ""}`}
      </Text>
      {rows.map((r) => (
        <div key={r.name} className="rh-subrow" title={r.note}>
          <span className="rh-subrow__head">
            <Text color="secondary" className="rh-subrow__icon">
              <Icon data={Bug} size={14} />
            </Text>
            <Text color="secondary" className="rh-subrow__name">
              {r.name}
            </Text>
            <span className="rh-subrow__lead" aria-hidden="true" />
            <Text color="secondary" className="rh-subrow__value">
              {fmtNumber(r.count)}
            </Text>
          </span>
          <Text className="rh-subrow__score" color="secondary">
            —
          </Text>
          <Text className="rh-subrow__score" color="secondary" title="Разбивка показывается для справки, в балл категории не входит">
            —
          </Text>
        </div>
      ))}
      {notes.map((n) => (
        <Text key={n} variant="body-1" color="complementary" className="rh-subrows__note rh-subrows__note_after">
          {n}
        </Text>
      ))}
    </>
  );
}

/**
 * Карта владельцев файлов — внутри раскрытия «Состояния кода», теми же строками, что
 * разбивка AppSec (на 375 px значение переносится, без перелива). Строки и тексты —
 * `ownershipView`, общий с MD/PDF; имя автора — из git, email не показывается никогда.
 * Колонки веса и балла — прочерк: в балл категории карта не входит.
 */
function OwnershipMap({ category }: { category: Parameters<typeof ownershipView>[0] }) {
  const view = ownershipView(category);
  if (!view) return null;
  return (
    <>
      <Text variant="caption-2" color="secondary" className="rh-subrows__group">
        {view.caption}
      </Text>
      {view.rows.map((r) => (
        <div key={r.dir} className="rh-subrow">
          <span className="rh-subrow__head">
            <Text color="secondary" className="rh-subrow__icon">
              <Icon data={FolderTree} size={14} />
            </Text>
            <Text color="secondary" className="rh-subrow__name rh-subrow__name_path">
              {r.dir}
            </Text>
            <span className="rh-subrow__lead" aria-hidden="true" />
            <Text color="secondary" className="rh-subrow__value rh-subrow__value_wrap">
              {`${r.owner} – ${r.share}${r.single ? ", единственный" : ""}, авторов ${r.authors}`}
            </Text>
          </span>
          <Text className="rh-subrow__score" color="secondary">
            —
          </Text>
          <Text className="rh-subrow__score" color="secondary" title="Карта показывается для справки, в балл категории не входит">
            —
          </Text>
        </div>
      ))}
      {view.notes.map((n) => (
        <Text key={n} variant="body-1" color="complementary" className="rh-subrows__note rh-subrows__note_after">
          {n}
        </Text>
      ))}
    </>
  );
}

// ---------- избранное на карточке ----------

/**
 * После успешного анализа своего репозитория незаполненная звезда один раз получает
 * неблокирующую зеленую подсветку (без модалки).
 * «Один раз» — на задание в пределах сессии браузера: ключ `<org>/<repo>:<jobId>`
 * в sessionStorage. Заполненная звезда не светится.
 */
function FavoriteStar({ org, repo, visibility, doneKey, loggedIn }: { org: string; repo: string; visibility: "public" | "internal" | "private" | "unknown"; doneKey: string | null; loggedIn: boolean | null }) {
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
    // Анониму звезда выключена без запроса: вход и так виден в /api/me, а 401 засорял
    // бы консоль. Пока сессия грузится — «проверяем», а не «войдите»
    if (loggedIn === null) {
      setState("loading");
      return;
    }
    if (!loggedIn) {
      setState("anon");
      return;
    }
    // Запрос идет при каждом переходе в «вошел», без флага «уже спрашивали»: /api/me
    // перезапрашивается, `loggedIn` на миг сбрасывается, и такой флаг навсегда оставил бы
    // звезду в состоянии «войдите». От гонки ответов защищает `stop`
    let stop = false;
    fetch(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`)
      .then(async (res) => {
        if (res.status === 401) {
          if (!stop) setState("anon");
          return;
        }
        // сбой сервера — не «войдите», а ошибка проверки
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
  // На время проверки кнопка не исчезает, а становится неактивной: иначе соседняя
  // иконка прыгала бы на ее место; состояние названо подсказкой
  const checking = state === "loading";
  const toggle = async () => {
    setError(null);
    if (state === "anon") return; // задизейблена: подсказка в title
    const next = state === "on" ? "off" : "on";
    setState(next);
    try {
      const res = await mutateJson<{ check?: FavoriteAddCheck; access?: { visibility?: "public" | "internal" | "private" | "unknown" } } | null>(
        `/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
        next === "on" ? "PUT" : "DELETE",
      );
      // Смену оттенка мелкой звезды не замечают, поэтому нужен тост. При добавлении
      // сервер сам проверяет права — тост говорит, чем кончилась проверка и поставлен
      // ли первый анализ своего репозитория
      toaster.add({
        name: `favorite:${org}/${repo}`,
        theme: next === "on" ? "success" : "info",
        title: next === "on" ? "Добавлено в избранное" : "Убрано из избранного",
        // видимость — из ответа или с карточки, иначе тост считал бы публичный репо закрытым
        content: next === "on" ? `${slugOf(org, repo)}. ${favoriteAddedText(res?.check, res?.access?.visibility ?? visibility)}` : slugOf(org, repo),
      });
      // первый анализ своего мог встать — «Задания» и карточка узнают сразу
      if (next === "on") announceJobsChanged();
    } catch (e) {
      setState(state); // откат — звезда не врёт
      toaster.add({
        name: `favorite-failed:${org}/${repo}`,
        theme: "danger",
        title: next === "on" ? "Не удалось добавить в избранное" : "Не удалось убрать из избранного",
        content: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const starTip = checking
    ? "Проверяем избранное…"
    : state === "anon"
      ? "Войдите через Я ID, чтобы добавлять в избранное"
      : "В избранное. Раздел «Избранное» содержит выбранные вами репозитории; права на закрытые данные сервис проверит сам при добавлении.";
  const starDisabled = state === "anon" || checking;
  const star = (
      /* Звезда — иконка из @gravity-ui/icons, а не юникодный символ: символ рисуется
          шрифтом и не совпадает по размеру и оптике с соседней иконочной кнопкой.
          Заполненная — янтарная (`warning`, контраст 8,18:1 в темной теме). */
      <Button
        size="s"
        view="flat"
        className={["rh-favorite-star", state === "on" ? "rh-favorite-star_on" : "", glow ? "rh-star-glow" : ""]
          .filter(Boolean)
          .join(" ")}
        disabled={starDisabled}
        /* Граница доступа объясняется там, где нажимают звезду: сервис не перечисляет
           репозитории зрителя сам (без токена с правами такого списка нет), поэтому
           «Избранное» — выбранные вручную репозитории, а не автоматический список. */
        title={starDisabled ? undefined : starTip}
        aria-label={starTip}
        onClick={() => void toggle()}
      >
        {/* 14px, как у соседней иконки перехода на sourcecraft.dev: кнопки стоят вплотную
            и должны совпадать по оптике (обе `size="s"`) */}
        <Icon data={state === "on" ? StarFill : Star} size={14} />
      </Button>
  );
  return (
    <Flex direction="column" gap={1}>
      {/* выключенная кнопка не получает наведения, и `title` на ней не показывается —
          причина подсказкой на обертке */}
      {starDisabled ? (
        <ActionTooltip title={starTip}>
          <span className="rh-disabled-tip" tabIndex={0} aria-label={starTip}>{star}</span>
        </ActionTooltip>
      ) : (
        star
      )}
      {error && <Text color="danger">{error}</Text>}
    </Flex>
  );
}
