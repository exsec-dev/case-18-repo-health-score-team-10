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
import { ArrowDownToLine, ArrowsRotateRight, ArrowUpRightFromSquare, Bug, Check, ChevronDown, CircleCheck, CircleInfo, Clock, CodeFork, Copy, Ellipsis, FaceRobot, FileText, Heart, LogoMarkdown, ScalesBalanced, SealCheck, Star, StarFill } from "@gravity-ui/icons";
import type { IconData } from "@gravity-ui/uikit";
import {
  ActionTooltip,
  Tooltip,
  Alert,
  ArrowToggle,
  Button,
  Card,
  ClipboardButton,
  CopyToClipboard,
  Skeleton,
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
  Sheet,
  Spin,
  Text,
  useToaster,
} from "@gravity-ui/uikit";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { COVERAGE_NULL_BELOW } from "../score/model";
import { factWords } from "../report/factWords";
import { FULL, INDEX, adjustmentLabel, adjustmentText, metricWeights, notInScoreNote, ownershipView, sourceWord, type BarHint, type OwnershipView } from "../report/sections";
import type { MetaResponse, RepoCard } from "./api";
import { dataOf, mutateJson, useJson, useVisible } from "./api";
import { CATEGORY_COLOR, LADDER_HELP, cardView, categoriesSummary, type CardView, type CategoryView, type PositionView, type RecommendationView } from "./cardView";
import { categoryBreakdown, fmtPoints, fmtSignedPoints, type BreakdownRow } from "./categoryBreakdown";
import { submetricIcon } from "./submetricIcons";
import { announceJobStarted, announceJobsChanged, useAnalysis, useAnalysisFinished, useSession } from "./session";
import {
  NO_SCORE,
  reportFailureText,
  favoriteAddedText,
  type FavoriteAddCheck,
  type PathPart,
  SECURITY_PUBLIC_NOTE,
  fmtCoverage,
  fmtDate,
  fmtDateTime,
  fmtFactValue,
  fmtNumber,
  fmtScore,
  noScoreText,
  reportFileName,
  scanStatusText,
  scanTriggerText,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  sentence,
  slugOf,
  notOwnReason,
  EMPTY_REPO_TEXT,
  rankText,
  roundScore,
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
import { repoKey, useTokenRepos } from "./tokenRepos";
import { repoWebUrl } from "../api/slug-input";
import { AiOverviewSection, BadgeButton, BadgeDialog, type BadgeTarget, CategoryAiGlyph, CategoryAiMark, CategoryAiNote, ActivityCheckCard, HistorySection, OPEN_CATEGORY_EVENT, categoryAiNote, categoryAnchor, useAiQuota } from "./RepoV5";
import { AsideSection, Collapse, EmptyState, LanguageName, Meta, MetaItem, MethodLink, ModelVersion, RepoAvatar, RepoSlug, ScoreLegend, SkeletonRows, VisibilityPill } from "./ui";

type Card = RepoCard;
type Evidence = Card["evidence"][number];

export function RepoPage({ org, repo, meta, onSection }: { org: string; repo: string; meta: MetaResponse | null; onSection?: (s: "rating" | "repos" | "me") => void }) {
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
  // Анализ по кнопке — своему репозиторию (`viewer.own`, из доступа, который карточка
  // и так резолвит) и публичному репозиторию организаций зрителя (он есть в списке по
  // токену); кнопка есть и не в избранном. Чужому, анониму и при неизвестном доступе
  // кнопки нет вовсе; пустому (ни одного коммита по живому списку) — тоже: оценивать
  // нечего. Окончательно решает сервер при запуске
  const withPat = data?.viewer?.auth === "pat";
  const ownRepo = data?.viewer?.own === true;
  const { repos: tokenRepos, recheck: recheckTokenRepos, checking: recheckingTokenRepos } = useTokenRepos(withPat);
  const listed = tokenRepos?.get(repoKey(org, repo)) ?? null;
  const emptyRepo = listed?.isEmpty === true;
  const canRefresh = withPat && !emptyRepo && (ownRepo || listed !== null);
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
  // страница). Закрытый (private/internal) в рейтинг не входит — его видят только
  // участники, и он стоит в их «Моих репозиториях»
  const closedRepo = data?.repo?.visibility === "private" || data?.repo?.visibility === "internal";
  useEffect(() => {
    if (data) onSection?.(closedRepo ? "repos" : "rating");
  }, [data !== null, closedRepo]); // eslint-disable-line react-hooks/exhaustive-deps
  const crumbs: Crumb[] = [closedRepo ? { text: "Мои репозитории", href: "/repos" } : { text: "Рейтинг", href: lastRatingHref() }, { text: slugOf(org, repo) }];
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
      // бейдж — только своему репо (он есть в «Моих репозиториях»); открытому из рейтинга
      // хватает публичного маршрута, закрытому — ключ из карточки
      badge={listed !== null && (card.repo.badge || card.repo.badgeKey !== undefined)}
      badgeTarget={{ org, repo, publicBaseUrl: meta?.publicBaseUrl ?? window.location.origin, league: card.score?.rankBadge != null, badgeKey: card.repo.badgeKey ?? null }}
      report={card.score !== null ? { mdHref: reportHref, pdfHref: `${cardUrl}/report.pdf`, pdfName: reportFileName(org, repo, "pdf") } : null}
      // без оценки запуск — главное действие заглушки под шапкой; вторая кнопка в шапке
      // его бы дублировала
      refresh={card.score !== null && refreshButton}
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
            title={emptyRepo ? "Анализировать пока нечего" : noScoreText(card.scan).title}
            description={emptyRepo ? EMPTY_REPO_TEXT : noScoreText(card.scan).description}
            actions={
              canRefresh
                ? [{ text: card.scan ? "Повторить анализ" : "Запустить анализ", view: "action", size: "l", onClick: start.start, loading: start.sending }]
                : emptyRepo
                  ? // первые коммиты могли прийти после того, как список прочитан (он живет 10 минут)
                    [{ text: "Проверить снова", view: "normal", size: "l", onClick: recheckTokenRepos, loading: recheckingTokenRepos }]
                  : card.viewer?.auth === "no-pat"
                  ? [
                      // без токена неизвестно, из ваших ли организаций репозиторий, поэтому
                      // анализ не обещаем: токен открывает CI/CD, Безопасность и анализ по кнопке
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
            {/* проверка активности — своей плашкой: у чужого на месте закрытого Repo Health
                Score, у своего — под плашками оценок; без индекса и в пустом репозитории
                проверять на накрутку и пересказывать нечего */}
            <ScoreBand
              card={card}
              view={view}
              check={
                card.score.healthcraftIndex === null || card.markers.codeEmpty
                  ? undefined
                  : (wide: boolean) => (
                      <ActivityCheckCard
                        card={card}
                        org={org}
                        repo={repo}
                        onChanged={reload}
                        loggedIn={loggedIn}
                        quota={aiQuota.quota}
                        onQuota={aiQuota.reload}
                        signIn={<LoginButton compact={false} inline />}
                        wide={wide}
                      />
                    )
              }
            />
          </Flex>
          {/* AI-обзор — над категориями: общий взгляд модели перед разбором по категориям */}
          {card.score.healthcraftIndex !== null && !card.markers.codeEmpty && <AiOverviewSection card={card} org={org} repo={repo} onChanged={reload} loggedIn={loggedIn} quota={aiQuota.quota} onQuota={aiQuota.reload} />}
          <Categories card={card} view={view} />
          <Recommendations view={view} org={org} repo={repo} />
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
 * Карточка репозитория из избранного или «Моих репозиториев», которого нет в каталоге
 * сервиса: закрытый репозиторий попадает в каталог только анализом по кнопке, а она
 * есть у своего репозитория (сохраненные права строки избранного, `last_access`) и у
 * любого репозитория из списка по токену. Остальным — объяснение, без обещаний.
 */
function FavoriteNotInCatalog({ org, repo, fallback, onRetry, onSection }: { org: string; repo: string; fallback: string; onRetry: () => void; onSection?: (s: "rating" | "repos" | "me") => void }) {
  const favs = useJson<{ entries: { org: string; repo: string; access: { visibility: string; own: boolean } | null }[] }>("/api/me/favorites");
  // опись по токену (кэш сервера): репозиторий из «Моих репозиториев», который еще не
  // анализировали, тоже получает «Оценки пока нет» с запуском, а не «не найден».
  // Без токена ответ — 409, это просто «не из описи»
  const { repos: tokenRepos, recheck, checking } = useTokenRepos(true);
  const key = repoKey(org, repo);
  const data = dataOf(favs.state);
  const fav = data?.entries.find((e) => repoKey(e.org, e.repo) === key) ?? null;
  const fromToken = tokenRepos?.get(key) ?? null;
  const section = fav !== null ? "me" : fromToken !== null ? "repos" : null;
  useEffect(() => {
    if (section) onSection?.(section);
  }, [section]); // eslint-disable-line react-hooks/exhaustive-deps
  const crumbs: Crumb[] =
    fav === null && fromToken !== null ? [{ text: "Мои репозитории", href: "/repos" }, { text: slugOf(org, repo) }] : [{ text: "Избранное", href: "/me" }, { text: slugOf(org, repo) }];
  if (favs.state.kind === "loading" || tokenRepos === null) {
    return (
      <Page crumbs={crumbs}>
        <SkeletonRows rows={1} height={150} />
      </Page>
    );
  }
  // видимость — из живого списка по токену, иначе из сохраненной проверки прав избранного
  const visibility = knownVisibility(fromToken?.visibility ?? fav?.access?.visibility);
  // пустой (ни одного коммита) — по живому списку: анализировать нечего; перепроверка —
  // перечитать список, если первые коммиты пришли после него
  const empty = fromToken?.isEmpty === true ? { recheck, checking } : null;
  if (fav !== null) {
    return (
      <FavoriteNotInCatalogState org={org} repo={repo} visibility={visibility} empty={empty} own={fav.access?.own === true || fromToken !== null} access={fav.access} crumbs={crumbs} onRetry={onRetry} />
    );
  }
  if (fromToken !== null) {
    // публичный из описи оценит и анализ по расписанию — запуск по кнопке только раньше
    const closed = visibility === "private" || visibility === "internal";
    return <FavoriteNotInCatalogState org={org} repo={repo} visibility={visibility} empty={empty} own access={null} crumbs={crumbs} onRetry={onRetry} fromToken scheduled={!closed} />;
  }
  return <NotInCatalog org={org} repo={repo} crumbs={[{ text: "Рейтинг", href: lastRatingHref() }, { text: slugOf(org, repo) }]} />;
}

const knownVisibility = (v: string | null | undefined): "public" | "internal" | "private" | "unknown" =>
  v === "public" || v === "internal" || v === "private" ? v : "unknown";

/**
 * Состояние «в избранном или в описи, но не в каталоге»: шапка репозитория и под ней
 * своему — «Запустить анализ» прямо здесь (сервер перепроверяет права живьем), итог
 * задания перечитывает страницу; пока идет анализ — без кнопки; пустому — без
 * запуска, анализировать нечего; чужому — объяснение.
 */
function FavoriteNotInCatalogState({
  org,
  repo,
  visibility,
  empty,
  own,
  access,
  crumbs,
  onRetry,
  fromToken = false,
  scheduled = false,
}: {
  org: string;
  repo: string;
  visibility: "public" | "internal" | "private" | "unknown";
  /** в репозитории нет ни одного коммита (живой список по токену): перепроверить список; null — не пустой */
  empty: { recheck: () => void; checking: boolean } | null;
  own: boolean;
  access: { visibility: string; own: boolean } | null | undefined;
  crumbs: Crumb[];
  onRetry: () => void;
  /** репозиторий из «Моих репозиториев» (список по токену), а не из избранного */
  fromToken?: boolean;
  /** публичный из описи: его оценит и анализ по расписанию */
  scheduled?: boolean;
}) {
  const slug = `${org}/${repo}`;
  const start = useStartAnalysis(org, repo);
  const analysis = useAnalysis();
  const live = analysis.live(slug);
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => j.slug === slug)) onRetry();
  });
  // каталога у репозитория нет — шапка без меты: только то, что известно без анализа
  const head = <RepoHead org={org} repo={repo} logoUrl={null} visibility={visibility} webUrl={repoWebUrl(org, repo)} starDoneKey={null} starLoggedIn />;
  if (live !== null) {
    return (
      <Page crumbs={crumbs}>
        {head}
        <EmptyState
          image={QueueIllustration}
          title={live.phase === "queued" ? "Анализ запланирован" : "Идет анализ"}
          description={live.phase === "queued" ? "Заявка стоит в очереди – ее возьмут в работу, и здесь появится итог." : "Данные собираются – итог появится здесь."}
        />
      </Page>
    );
  }
  if (empty && own) {
    return (
      <Page crumbs={crumbs}>
        {head}
        <EmptyState
          image={EmptyIllustration}
          title="Анализировать пока нечего"
          description={EMPTY_REPO_TEXT}
          actions={[{ text: "Проверить снова", view: "normal", size: "l", onClick: empty.recheck, loading: empty.checking }]}
        />
      </Page>
    );
  }
  return (
    <Page crumbs={crumbs}>
      {head}
      <EmptyState
        image={EmptyIllustration}
        title="Оценки пока нет"
        description={
          fromToken
            ? scheduled
              ? "Анализа этого публичного репозитория еще не было – его оценит анализ по расписанию. Запустить раньше можно здесь."
              : "Репозиторий доступен вашему токену, но анализа еще не было. Запустите его – итог появится здесь."
            : own
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
function CardActions({ org, repo, scored, badge, badgeTarget, report, refresh }: { org: string; repo: string; scored: boolean; badge: boolean; badgeTarget: BadgeTarget; report: ReportFiles | null; refresh: ReactNode }) {
  const phone = useMediaQuery("(max-width: 767px)");
  const anchor = useRef<HTMLSpanElement>(null);
  const compact = useCompactBar(anchor, phone);
  // хуки — до любого ветвления: ширина меняет раскладку на лету
  const compare = useCompareState(org, repo);
  const reportDl = useReportDownload(report);
  // доступность бейджа знает сервер (поля карточки) и список по токену, без пробного запроса badge.svg
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
        {scored && badgeOk && <BadgeButton target={badgeTarget} />}
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
    ...(scored && badgeOk ? [{ text: "Бейдж", iconStart: <Icon data={SealCheck} size={16} />, action: () => setBadgeOpen(true) }] : []),
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
      {badgeOk && <BadgeDialog target={badgeTarget} open={badgeOpen} onClose={() => setBadgeOpen(false)} />}
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
    <RepoHead
      org={r.org}
      repo={r.repo}
      logoUrl={r.logoUrl}
      visibility={r.visibility}
      shownVisibility={view.visibility}
      webUrl={r.webUrl}
      starDoneKey={starDoneKey}
      starLoggedIn={starLoggedIn}
      title={r.title}
      meta={
        // Две даты различены словом: «активность» — по каталогу SourceCraft, «анализ» —
        // момент анализа, та же дата, что в шапке отчета (`analysisDate`).
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
      }
    />
  );
}

/**
 * Шапка репозитория: аватар, имя, видимость и действия (скопировать, избранное,
 * открыть на SourceCraft). Одна для карточки и для репозитория, которого еще нет в
 * каталоге (закрытый до первого анализа): у второго нет меты каталога — только
 * то, что известно без анализа.
 */
function RepoHead({
  org,
  repo,
  logoUrl,
  visibility,
  shownVisibility = visibility,
  webUrl,
  starDoneKey,
  starLoggedIn,
  title = null,
  meta = null,
}: {
  org: string;
  repo: string;
  logoUrl: string | null;
  /** видимость для звезды (текст тоста) */
  visibility: "public" | "internal" | "private" | "unknown";
  /** видимость плашки у имени; «неизвестно» плашки не дает */
  shownVisibility?: string | null;
  webUrl: string;
  starDoneKey: string | null;
  starLoggedIn: boolean | null;
  /** описание репозитория, если оно не повторяет имя */
  title?: string | null;
  meta?: ReactNode;
}) {
  return (
    <div className="rh-card-head">
      {/* аватар l (42px) — по центру блока «название + мета» (layout.css) */}
      <div className="rh-repo-head">
        <RepoAvatar repo={repo} logoUrl={logoUrl} size="l" />
        <Flex direction="column" justifyContent="space-between" style={{ minWidth: 0 }}>
          <Flex gap={2} alignItems="center" className="rh-card-head__title">
            <RepoSlug org={org} repo={repo} variant="header-2" />
            {/* видимость в SourceCraft — той же плашкой, что в избранном */}
            <VisibilityPill value={shownVisibility} />
            <Flex gap={1} alignItems="center">
              <ClipboardButton text={slugOf(org, repo)} size="s" view="flat-secondary" tooltipInitialText="Скопировать адрес репозитория" tooltipSuccessText="Скопировано" />
              <FavoriteStar org={org} repo={repo} visibility={visibility} doneKey={starDoneKey} loggedIn={starLoggedIn} />
              <ActionTooltip title="Открыть на sourcecraft.dev">
                <Button view="flat-secondary" size="s" href={webUrl} target="_blank" rel="noreferrer" aria-label="Открыть репозиторий на sourcecraft.dev">
                  <Icon data={ArrowUpRightFromSquare} size={14} />
                </Button>
              </ActionTooltip>
            </Flex>
          </Flex>
          {meta}
        </Flex>
      </div>
      {title && title !== repo && (
        <Text as="p" className="rh-prose" color="complementary" style={{ margin: "var(--g-spacing-2) 0 0" }}>
          {title}
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
  const coverageHelp = `По какой доле категорий индекса собраны данные, с учетом веса категорий. Ниже ${threshold} оценку не ставим.`;
  const fullCoverageHelp = `По какой доле всех 6 категорий собраны данные, с учетом веса категорий. Ниже ${threshold} оценку не ставим.`;
  const full = score !== null && !score.fullLocked;
  // идет анализ репозитория без оценки — первый или повтор после неудачного (свой,
  // чужой или плановый): сведения появятся с итогом, до него — скелетон, а не пустая панель
  const pending = score === null && (analysis !== null || foreignRunning);
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
        {pending ? (
          <SkeletonRows rows={3} height={20} />
        ) : scan || score ? (
          <DefinitionList nameMaxWidth={ASIDE_NAME_WIDTH}>
            {score && (
              <DefinitionList.Item name="Место в рейтинге">
                {/* одно правило с отчетом и сравнением; без места — причина, а не «–» */}
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
                {score.repoHealthCoverage === null ? "–" : fmtCoverage(score.repoHealthCoverage)}
              </DefinitionList.Item>
            )}
            {scan && scan.status !== "running" && <DefinitionList.Item name="Данные собраны">{collectedText(scan.status)}</DefinitionList.Item>}
            {scan && scan.status !== "running" && <DefinitionList.Item name="Запуск">{scanTriggerText(scan.trigger)}</DefinitionList.Item>}
          </DefinitionList>
        ) : (
          <Text color="secondary">Анализа еще не было</Text>
        )}
      </AsideSection>

      {/* та же легенда, что на рейтинге */}
      {score && <ScoreLegend />}

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
function ScoreBand({ card, view, check }: { card: Card; view: CardView; check?: (wide: boolean) => ReactNode }) {
  const score = card.score!;
  const barOf = (name: string) => view.contributions.find((b) => b.title.endsWith(name)) ?? null;
  // закрытый Repo Health Score у чужого репозитория уступает место проверке активности:
  // почему он закрыт, уже сказано плашкой под «Категориями»
  const checkInSlot = check !== undefined && view.fullPath !== null;
  return (
    <div className="rh-score-cards">
      <Card view="outlined" className="rh-score-band">
        <ScoreFigure title="HealthCraft Index" help={INDEX_HELP} total={score.healthcraftIndex} position={view.position} codeEmpty={card.markers.codeEmpty} />
        {score.healthcraftIndex === null && <NoScoreReason view={view} />}
        <ContributionStrip bar={barOf("HealthCraft Index")} />
      </Card>
      {checkInSlot ? (
        check(false)
      ) : (
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
      )}
      {/* свой репозиторий: проверка — на всю ширину под оценками */}
      {check !== undefined && !checkInSlot && check(true)}
      {/* предупреждение CI при закрытом Repo Health Score — под плашками */}
      {checkInSlot && (
        <div className="rh-score-cards__wide">
          <Markers view={view} />
        </div>
      )}
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
                    // имя — название и значение; подробности озвучит подсказка (aria-describedby Tooltip)
                    aria-label={p.hint ? `${p.title} – ${p.value}` : undefined}
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
  const strengths = categoriesSummary(card);
  const notInScore = notInScoreNote(card);
  const withData = view.categories.filter((c) => c.score !== null);
  const aiEverywhere = card.ai !== undefined && withData.length > 1 && withData.every((c) => categoryAiNote(card, c.key) !== null);
  return (
    <section className="rh-section" aria-labelledby="rh-categories-title">
      <Card view="outlined" className="rh-section-card">
        {/* AI-разбор у каждой категории — одна искра у заголовка, а не в каждой
            строке; слева от названия, как искра у заголовка AI-обзора */}
        <Flex gap={2} alignItems="center" className="rh-section__title rh-categories__head">
          {aiEverywhere && <CategoryAiGlyph />}
          <Text variant="subheader-3" as="h2" id="rh-categories-title">
            Категории
          </Text>
        </Flex>
        {/* итог: сильнейшие категории и чего не хватает слабейшей — простыми словами (в MD/PDF — прежняя строка) */}
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
            <CategoryRow key={c.key} category={c} card={card} aiEverywhere={aiEverywhere} />
          ))}
        </ul>
        {/* плашки о закрытых CI/CD и Безопасности здесь нет: путь к полной оценке — у закрытого Repo Health Score */}
      </Card>
    </section>
  );
}

function CategoryRow({ category: c, card, aiEverywhere, defaultOpen = false }: { category: CategoryView; card: Card; aiEverywhere: boolean; defaultOpen?: boolean }) {
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
  const bd = categoryBreakdown(card, key);
  // у категории без данных раскрывать нечего
  const expandable = c.score !== null && ((bd !== null && (bd.rows.length > 0 || bd.refs.length > 0)) || c.partialNote !== null);
  // вторая строка — только когда балл объясняет не набор показателей: нет данных
  // (причина) или поправка к сумме — причиной без чисел: балл стоит рядом, величина
  // поправки — строкой в раскрытии; прежняя проза «Сильная сторона… Слабее…»
  // повторяла раскрытие — она остается описанием для скринридера
  // вторая строка — только причина отсутствия данных; поправка объяснена своей строкой в раскрытии
  const second = c.score === null ? c.why : null;
  // полоса — цветом зоны; значки показателей — серые: цвет беды у полного круга
  // («не найдены 20 из 20» в красной категории) читался как тревога
  const color = c.score === null ? ZONE_COLOR.misc : ZONE_COLOR[scoreTheme(c.score)];
  // блоки раскрытия: показатели и справочные — колонками, находки AppSec и карта
  // владельцев — под ними во всю ширину; каждый — когда есть что показать
  const appsec = key === "security" ? appsecView(card) : null;
  const owners = key === "code" ? ownershipView(cat) : null;
  const hasRows = bd !== null && bd.rows.length > 0;
  const hasRefs = bd !== null && bd.refs.length > 0;
  const subsId = `${categoryAnchor(key)}-subs`;

  const row = (
    <>
      {expandable ? <ArrowToggle direction={open ? "bottom" : "right"} size={14} className="rh-category__chevron" /> : <span />}
      <span className="rh-category__name">
        <span className="rh-category__title">
          <Text variant="subheader-1">{c.title}</Text>
          {/* искра — у категории есть AI-разбор; у всех сразу — одна отметка над списком */}
          {!aiEverywhere && <CategoryAiMark card={card} categoryKey={key} hasData={c.score !== null} />}
          {c.stale && (
            <Label theme="warning" size="xs">
              {STALE_CATEGORY_MARK}
            </Label>
          )}
        </span>
        {second !== null ? (
          <Text variant="body-1" color="complementary" className="rh-category__why" id={`${categoryAnchor(key)}-why`}>
            {second}
          </Text>
        ) : (
          <span className="rh-sr-only" id={`${categoryAnchor(key)}-why`}>
            {c.why}
          </span>
        )}
      </span>
      {/* полоса — слитная, цветом зоны («Здоров», «Требует внимания», «В зоне риска»),
          недобранное — штриховкой */}
      <span className="rh-category__bar" aria-hidden="true">
        {c.score === null ? null : <CategoryBar color={color} score={c.score} />}
      </span>
      <Text variant="subheader-2" color={c.score === null ? "secondary" : undefined} className="rh-category__value">
        {c.scoreText}
      </Text>
      {/* плашка — только без данных; иначе последней ячейки нет, и балл стоит у края, над концом таблицы */}
      {c.score === null && (
        <Label theme={c.chip.theme} size="xs" className="rh-category__word">
          {c.chip.text}
        </Label>
      )}
    </>
  );

  return (
    <li className="rh-list__item" style={{ padding: 0 }} id={categoryAnchor(key)}>
      {/* строка — заголовок H3 (аккордеон: кнопка внутри заголовка), между категориями
          можно ходить по заголовкам */}
      <h3 className="rh-category__h">
        {expandable ? (
          <button
            type="button"
            className="rh-category"
            aria-expanded={open}
            aria-controls={`${categoryAnchor(key)}-subs`}
            // имя заголовка — название и балл; основание — описанием, а не частью имени
            aria-label={`${c.title}, ${c.scoreText === "–" ? "нет данных" : `${c.scoreText} из 100`}`}
            aria-describedby={`${categoryAnchor(key)}-why`}
            onClick={() => setOpen(!open)}
          >
            {row}
          </button>
        ) : (
          <span className="rh-category">{row}</span>
        )}
      </h3>
      {/* раскрытие — анимацией высоты; содержимое в DOM и у свернутой (inert) */}
      {expandable && (
        <Collapse open={open}>
          <div className="rh-cbd" id={subsId}>
            {/* примечание частичной нехватки данных — внутри раскрытия (в MD его нет в строке) */}
            {c.partialNote && (
              <Text as="p" variant="body-1" color="complementary" className="rh-cbd__note">
                {c.partialNote}
              </Text>
            )}
            {/* без вкладок: показатели слева заканчиваются итогом, справочные справа —
                с пометкой в углу, что в балл они не входят; на узком экране колонки
                встают друг под другом */}
            {(hasRows || hasRefs) && (
              <div className={hasRows && hasRefs ? "rh-cbd__cols rh-cbd__cols_two" : "rh-cbd__cols"}>
                {hasRows && (
                  <div className="rh-cbd__block rh-cbd__tile rh-cbd__tile_main">
                    <TileHead title="Показатели" />
                    <div className="rh-cbd__table" role="table" aria-label={`Показатели категории «${c.title}»`}>
                      {bd.rows.map((r) => (
                        <Fragment key={r.sub}>
                          <BreakdownLine glyph={r.state === "counted" ? r.score : null} icon={submetricIcon(key, r.sub)} title={r.title} value={r.value} earned={r.earned} weight={r.weight} hint={breakdownHint(r)} />
                          {r.parts?.map((p) => <BreakdownLine key={p.title} part glyph={null} title={p.title} value={p.value} earned={p.earned} weight={p.weight} hint={null} />)}
                        </Fragment>
                      ))}
                      {bd.adjustment !== null && (
                        <BreakdownLine
                          glyph="adjust"
                          title={`Поправка: ${cat.adjustment ? adjustmentLabel(cat).toLowerCase() : "балл скорректирован"}`}
                          value=""
                          earned={bd.adjustment}
                          weight={null}
                          hint={[adjustmentText(cat) ?? "Балл категории скорректирован после суммы показателей."]}
                        />
                      )}
                      {c.score !== null && <TotalLine score={c.score} />}
                    </div>
                  </div>
                )}
                {hasRefs && (
                  <div className="rh-cbd__block rh-cbd__block_refs rh-cbd__tile">
                    {/* у справочных нет колонок балла — пометка в углу объясняет почему */}
                    <TileHead title="Справочные показатели" aside="в балл не входят" />
                    <div className="rh-cbd__table rh-cbd__table_refs" role="table" aria-label={`Справочные показатели категории «${c.title}», в балл не входят`}>
                      {bd.refs.map((r) => (
                        <RefLine key={r.sub} icon={submetricIcon(key, r.sub)} title={r.title} value={r.value} hint={r.aside !== null ? [`${sentence(r.aside)}.`] : null} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {appsec !== null && (
              <section className="rh-cbd__block rh-cbd__block_below rh-cbd__tile" aria-labelledby={`${subsId}-appsec`}>
                <TileHead id={`${subsId}-appsec`} title="Находки AppSec" aside="в балл не входят" />
                <AppsecTable data={appsec} />
              </section>
            )}
            {owners !== null && (
              <section className="rh-cbd__block rh-cbd__block_below rh-cbd__tile" aria-labelledby={`${subsId}-owners`}>
                <TileHead id={`${subsId}-owners`} title="Карта владельцев" aside="в балл не входит" />
                {/* под картой — только легенда: оговорки о полноте обхода остаются в отчете */}
                <OwnershipTree rows={owners.rows} thresholdPct={owners.thresholdPct} />
              </section>
            )}
            {aiNote !== null && <CategoryAiNote note={aiNote} card={card} />}
          </div>
        </Collapse>
      )}
    </li>
  );
}

/**
 * Число с одним знаком, выровненное по запятой: целая часть — вправо, дробь — в
 * слоте постоянной ширины, поэтому «8» стоит разрядом под «9» у «49,9».
 */
function AlignedNumber({ text }: { text: string }) {
  const i = text.indexOf(",");
  return (
    <>
      {i === -1 ? text : text.slice(0, i)}
      <span className="rh-num__frac">{i === -1 ? "" : text.slice(i)}</span>
    </>
  );
}

/** Подсказка строки показателя: одна строка расчета, ниже — пояснение к значению. */
function breakdownHint(r: BreakdownRow): string[] {
  const aside = r.aside !== null ? [`${sentence(r.aside)}.`] : [];
  if (r.state !== "counted" || r.score === null || r.weight === null || r.earned === null) {
    // у доли тестов причина уже в пояснении
    return aside.length > 0 ? aside : ["В балл категории не входит: балла у показателя нет, его вес перенесен на остальные."];
  }
  // процент с одним знаком: «8% от 25 = 2,1» при пересчете не сходилось
  return [`Набрано ${fmtPoints(r.score * 100)}% от ${fmtPoints(r.weight)} = ${fmtPoints(r.earned)}`, ...aside];
}

/**
 * Шапка плашки раскрытия: название слева, пометка «в балл не входит» — в правом
 * углу, тише названия: она поясняет плашку, а не называет ее.
 */
function TileHead({ id, title, aside }: { id?: string; title: string; aside?: string }) {
  return (
    <div className="rh-cbd__tilehead">
      <Text variant="caption-2" color="secondary" id={id}>
        {title}
      </Text>
      {aside !== undefined && (
        <Text variant="caption-2" color="hint">
          {aside}
        </Text>
      )}
    </div>
  );
}

/**
 * Итог под показателями: балл категории «из 100» — левая колонка и есть то, что
 * входит в балл. Тот же округленный балл, что в строке категории, но с одним
 * знаком после запятой, как у строк выше: «85,0 из 100,0».
 */
function TotalLine({ score }: { score: number }) {
  return (
    <div className="rh-cbd__row rh-cbd__row_total" role="row">
      <span role="cell" className="rh-cbd__glyph" />
      <span role="cell" className="rh-cbd__name">
        <Text variant="subheader-1" className="rh-cbd__title">
          Итого
        </Text>
        <span className="rh-cbd__lead" aria-hidden="true" />
      </span>
      <Text role="cell" variant="subheader-1" className="rh-cbd__earned">
        <AlignedNumber text={fmtPoints(roundScore(score))} />
      </Text>
      <Text role="cell" color="secondary" className="rh-cbd__of">
        из <AlignedNumber text={fmtPoints(100)} />
      </Text>
    </div>
  );
}

/** Содержимое подсказки — строками. */
function BreakdownTip({ lines }: { lines: string[] }) {
  return (
    <div className="rh-cbd-tip">
      {/* ключ — позиция: строки могут совпадать (два автора с замаскированным именем и равной долей) */}
      {lines.map((l, i) => (
        <Text key={i} variant="caption-2" color={i === 0 ? undefined : "secondary"}>
          {l}
        </Text>
      ))}
    </div>
  );
}

/**
 * Значок строки с подсказкой: фокус с клавиатуры (и касание на телефоне) открывает
 * ту же подсказку, что наведение, а скринридер читает ее как имя значка.
 */
function TipGlyph({ hint, children }: { hint: string[] | null; children: ReactNode }) {
  if (hint === null) return <>{children}</>;
  return (
    <span className="rh-cbd__tipglyph" tabIndex={0} role="img" aria-label={hint.join(" ")}>
      {children}
    </span>
  );
}

/**
 * Строка разбивки: значок, имя и пунктир, значение (под полосой категории),
 * «N» (под баллом категории) и «из веса». Значок у расчетных — серый сектор по
 * баллу (полный круг, сектор, пустое кольцо); у строк вне расчета — иконка
 * показателя. Части README — без значка, с отступом. Наведение подсвечивает
 * строку и показывает расчет.
 */
function BreakdownLine({
  glyph,
  icon,
  title,
  value,
  earned,
  weight,
  hint,
  part = false,
}: {
  glyph: number | null | "adjust";
  icon?: IconData;
  title: string;
  value: string;
  earned: number | null;
  weight: number | null;
  hint: string[] | null;
  part?: boolean;
}) {
  const row = (
    <div className={part ? "rh-cbd__row rh-cbd__row_part" : "rh-cbd__row"} role="row">
      <span role="cell" className="rh-cbd__glyph">
        {part ? null : (
          <TipGlyph hint={hint}>
            {/* иконка показателя, а не сектор по баллу: «N из веса» стоит рядом, сектор
                его повторял; иконки — те же, что у дополнительных */}
            {glyph !== "adjust" && icon ? (
              <Text color="secondary" className="rh-cbd__icon">
                <Icon data={icon} size={14} />
              </Text>
            ) : (
              <SectorGlyph value={glyph} />
            )}
          </TipGlyph>
        )}
      </span>
      <span role="cell" className="rh-cbd__name">
        <Text color={part ? "complementary" : earned === null ? "secondary" : undefined} className="rh-cbd__title">
          {title}
        </Text>
        {/* пунктир — до самого значения: значение в той же ячейке, у ее правого края */}
        {/* пунктир — у всех строк, и без значения (поправка, README): ведет к числам */}
        <span className="rh-cbd__lead" aria-hidden="true" />
        {value !== "" && (
          <Text color="secondary" className="rh-cbd__value">
            {value}
          </Text>
        )}
      </span>
      <Text role="cell" color={part || earned === null ? "secondary" : undefined} className="rh-cbd__earned">
        {earned === null ? "–" : <AlignedNumber text={glyph === "adjust" ? fmtSignedPoints(earned) : fmtPoints(earned)} />}
      </Text>
      <Text role="cell" color="secondary" className="rh-cbd__of">
        {/* «из» — по правому краю со слотом дроби: «из 100» итога встает разряд под разрядом с «из 35,0» */}
        {weight === null ? "" : <>из <AlignedNumber text={fmtPoints(weight)} /></>}
      </Text>
    </div>
  );
  if (hint === null) return row;
  return (
    <Tooltip content={<BreakdownTip lines={hint} />} placement={["top-end", "bottom-end"]} openDelay={150} closeDelay={0}>
      {row}
    </Tooltip>
  );
}

/** Справочная строка: иконка, имя, пунктир, значение; без колонок балла и веса. */
function RefLine({ icon, title, value, hint }: { icon: IconData; title: string; value: string; hint: string[] | null }) {
  const row = (
    <div className="rh-cbd__row rh-cbd__row_ref" role="row">
      <span role="cell" className="rh-cbd__glyph">
        <TipGlyph hint={hint}>
          <Text color="secondary" className="rh-cbd__icon">
            <Icon data={icon} size={14} />
          </Text>
        </TipGlyph>
      </span>
      {/* баллов у справочных нет — ячейка до правого края, значение — под последней колонкой основных */}
      <span role="cell" className="rh-cbd__name rh-cbd__name_wide">
        <Text color="complementary" className="rh-cbd__title">
          {title}
        </Text>
        <span className="rh-cbd__lead" aria-hidden="true" />
        <Text color="secondary" className="rh-cbd__value">
          {value}
        </Text>
      </span>
    </div>
  );
  if (hint === null) return row;
  return (
    <Tooltip content={<BreakdownTip lines={hint} />} placement={["top-end", "bottom-end"]} openDelay={150} closeDelay={0}>
      {row}
    </Tooltip>
  );
}

/** Значок состояния показателя — серый сектор по баллу внутри кольца (контраст с фоном не ниже 3:1). */
function SectorGlyph({ value }: { value: number | null | "adjust" }) {
  const ring = "currentColor";
  let inner: ReactNode;
  if (value === null) inner = <circle cx="7" cy="7" r="5.5" fill="none" stroke={ring} strokeWidth="1.25" strokeDasharray="2.2 2" />;
  else if (value === "adjust")
    inner = (
      <>
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={ring} strokeWidth="1.25" />
        <path d="M4.5 7h5" stroke={ring} strokeWidth="1.5" strokeLinecap="round" />
      </>
    );
  else if (value >= 0.995) inner = <circle cx="7" cy="7" r="6" fill="currentColor" />;
  else if (value <= 0.005) inner = <circle cx="7" cy="7" r="5.5" fill="none" stroke={ring} strokeWidth="1.25" />;
  else {
    const a = value * 2 * Math.PI;
    const x = Math.round((7 + 6 * Math.sin(a)) * 100) / 100;
    const y = Math.round((7 - 6 * Math.cos(a)) * 100) / 100;
    inner = (
      <>
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={ring} strokeWidth="1.25" />
        <path d={`M7 7 L7 1 A6 6 0 ${value > 0.5 ? 1 : 0} 1 ${x} ${y} Z`} fill="currentColor" />
      </>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="rh-cbd__sector">
      {inner}
    </svg>
  );
}

/** Цвет полосы по зоне — те же токены, что у полосы Gravity (`Progress`) прежней карточки. */
const ZONE_COLOR: Record<ReturnType<typeof scoreTheme>, string> = {
  success: "var(--g-color-base-positive-medium)",
  warning: "var(--g-color-base-warning-medium)",
  danger: "var(--g-color-base-danger-medium)",
  misc: "var(--g-color-base-neutral-medium)",
};

/**
 * Полоса категории — слитная: заливка — балл категории цветом зоны,
 * недобранное — штриховкой, как «не набрано» у полосы вклада под индексом.
 * По показателям полоса не делится: кусочки без подписей ничего не сообщали —
 * разбивка живет в раскрытии.
 */
function CategoryBar({ color, score }: { color: string; score: number }) {
  return (
    <span className="rh-catbar" style={{ color }}>
      <span className="rh-catbar__seg">
        <i style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </span>
    </span>
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
 * серьезности, затем по приросту индекса — числу или потолку у правил без числа.
 * Строка — точка цвета категории, действие, причина, ниже тихо: «Источник данных»
 * (источник, время сбора, сырые данные) и файл-заготовка; справа — прирост.
 * Если индекс ниже 70 и есть шаги к зоне «Здоров», раздел начинается с итога, а
 * список идет одной сеткой: критичные, шаги (под приростом — индекс после шага),
 * остальные.
 */
function Recommendations({ view, org, repo }: { view: CardView; org: string; repo: string }) {
  const ladder = view.ladder;
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
          <Text variant="subheader-3" as="h2" id="rh-recommendations-title" className="rh-section__title">
            Рекомендации
          </Text>
          {ladder !== null ? (
            <>
              {/* вариант V1 (19.10.2026): один список на одной сетке — критичные, шаги, остальные;
                  индекс после шага — под приростом, а не отдельной осью */}
              <Flex gap={1} alignItems="center" className="rh-recs__headline">
                <Text variant="body-2">{ladder.headline}</Text>
                <HelpMark iconSize="s" aria-label="Как считаются шаги">
                  {LADDER_HELP}
                </HelpMark>
              </Flex>
              <ol className="rh-list rh-recs" style={{ borderTop: 0 }}>
                {ladder.first.map((r) => (
                  <RecommendationRow key={r.rec.ruleId} item={r} org={org} repo={repo} />
                ))}
                {ladder.steps.map((s, i) => (
                  <RecommendationRow
                    key={s.item.rec.ruleId}
                    item={{ ...s.item, gain: s.gain, scale: null, ceiling: s.gain.startsWith("до") ? (s.item.ceiling ?? 0) : null }}
                    org={org}
                    repo={repo}
                    index={{ text: s.after, good: s.healthy || s.reach }}
                    // после шагов — линия ярче: дальше рекомендации вне лесенки
                    lastStep={i === ladder.steps.length - 1 && ladder.rest.length > 0}
                  />
                ))}
                {ladder.rest.map((r) => (
                  <RecommendationRow key={r.rec.ruleId} item={r} org={org} repo={repo} />
                ))}
              </ol>
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

function RecommendationRow({
  item,
  org,
  repo,
  index = null,
  lastStep = false,
}: {
  item: RecommendationView;
  org: string;
  repo: string;
  /** индекс после шага лесенки; good — зона «Здоров» достигнута (или может быть) */
  index?: { text: string; good: boolean } | null;
  lastStep?: boolean;
}) {
  return (
    <li className={lastStep ? "rh-list__item rh-rec rh-rec_last-step" : "rh-list__item rh-rec"}>
      <Text variant="subheader-1" color="secondary" className="rh-rec__n">
        {item.n}
      </Text>
      <RecommendationBody item={item} org={org} repo={repo} gain={<RecommendationGain gain={item.gain} scale={item.scale} ceiling={item.ceiling !== null} index={index} effect={item} inline />} />
      <RecommendationGain gain={item.gain} scale={item.scale} ceiling={item.ceiling !== null} index={index} effect={item} />
    </li>
  );
}

/**
 * Действие, причина и тихая строка под ними: заготовка файла (кнопка с именем
 * файла) и «Источник данных». Эффект словами (у правил без
 * числа и потолка) — строкой под причиной, а не абзацем у правого края.
 */
function RecommendationBody({ item, org, repo, gain }: { item: RecommendationView; org: string; repo: string; gain: ReactNode }) {
  const { rec } = item;
  return (
    <Flex direction="column" gap={1} className="rh-rec__body">
      {/* действие — заголовком строки 15px, как у списков SourceCraft: первым читается что сделать, а не число */}
      <Text variant="subheader-2" className="rh-rec__action">
        {/* точка цвета категории — как в полосе вклада под индексом, без подписи */}
        {item.categoryKey !== null && <span className={`rh-rec__dot ${CATEGORY_COLOR[item.categoryKey]}`} title={item.category ?? undefined} aria-hidden="true" />}
        {rec.action}
        {item.critical && (
          <Label theme="danger" size="xs" className="rh-rec__crit">
            Критично
          </Label>
        )}
      </Text>
      {/* телефон: прирост — под действием, колонки справа нет */}
      {gain}
      <Text variant="body-1" color="complementary">
        {rec.problem}
      </Text>
      {/* «Источник данных» — первым: он есть у каждой строки, файл — только у части */}
      <Flex gap={2} wrap alignItems="center" className="rh-rec__meta">
        <Popover trigger="click" placement={["bottom-start", "top-start"]} content={<FactProof item={item} />} aria-label={`Исходные данные: ${item.label}`}>
          <Button view="flat-secondary" size="s" className="rh-rec__proof">
            Источник данных
            <Icon data={ChevronDown} size={14} />
          </Button>
        </Popover>
        {rec.fixTemplate ? <FixTemplateButton org={org} repo={repo} ruleId={rec.ruleId} meta={rec.fixTemplate} /> : null}
      </Flex>
    </Flex>
  );
}

/**
 * Прирост: число справа (на телефоне — под действием, `inline`). Прирост к Repo
 * Health Score — серым, шкала названа словами в тихой строке. У потолка «до +N» —
 * подсказка Gravity, она открывается и с клавиатуры (title на телефоне не открыть).
 */
function RecommendationGain({
  gain,
  scale,
  ceiling,
  index = null,
  effect = null,
  inline = false,
}: {
  gain: string | null;
  scale: string | null;
  ceiling: boolean;
  index?: { text: string; good: boolean } | null;
  /** эффект словами у правил без числа: коротко в колонке, полностью — в подсказке */
  effect?: Pick<RecommendationView, "effect" | "effectShort"> | null;
  inline?: boolean;
}) {
  const cls = inline ? "rh-rec__gain-inline" : "rh-rec__effect";
  if (gain === null) {
    if (!effect || effect.effectShort === null) return inline ? null : <span className={cls} />;
    const full = `${sentence(effect.effect)}${/[.!?]$/.test(effect.effect) ? "" : "."}`;
    return (
      <span className={cls}>
        <ActionTooltip title={full}>
          <span className="rh-rec__effect-word" tabIndex={0} aria-label={full}>
            {effect.effectShort}
          </span>
        </ActionTooltip>
      </span>
    );
  }
  // индекс после шага — тихо под приростом (на телефоне — рядом); зона «Здоров» — зеленым
  const after =
    index !== null ? (
      <Text variant="caption-2" color={index.good ? "positive" : "secondary"} className="rh-rec__after">
        {`${INDEX} ${index.text}`}
        {index.good && <span className="rh-sr-only">, зона «Здоров»</span>}
      </Text>
    ) : null;
  const number = (
    <Text variant="subheader-2" color={scale !== null ? "secondary" : undefined} className="rh-rec__gain">
      {gain}
    </Text>
  );
  return (
    <span className={cls}>
      {ceiling ? (
        <ActionTooltip title="Верхняя граница" description="Столько индекс получит, если показатель дойдет до максимума; зависит от объема работы.">
          <span className="rh-rec__gain-tip" tabIndex={0}>
            {number}
          </span>
        </ActionTooltip>
      ) : (
        number
      )}
      {after}
      {/* шкала прироста, если это не индекс, — под числом (на телефоне — рядом), как «HealthCraft Index N» */}
      {scale !== null && (
        <Text variant="caption-2" color="secondary" className="rh-rec__after">
          {scale}
        </Text>
      )}
    </span>
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

/** Куда положить заготовку — одна фраза под именем файла. */
function templateWhere(ruleId: string): string {
  if (ruleId === "readme-sections-missing") return "Только недостающие разделы – перенесите их в свой README.md и заполните поля в угловых скобках <…>.";
  if (ruleId === "codeowners-missing") return "Положите файл в корень репозитория и замените @login на логины ответственных.";
  if (ruleId === "license-missing") return "Положите файл в корень репозитория. Лицензию выбирает автор – выберите ее выше.";
  return "Положите файл в корень репозитория и заполните поля в угловых скобках <…>.";
}

/**
 * Заготовка файла для рекомендации: тихая кнопка с именем файла открывает окно —
 * куда положить, текст заготовки, «Скопировать» и «Скачать». Текст читается при
 * первом открытии (fetch, как у отчета: сбой — строкой в окне, а не сырым JSON) и
 * им же скачивается — второго запроса нет. У лицензии значения по умолчанию нет:
 * текст появляется после выбора.
 */
function FixTemplateButton({ org, repo, ruleId, meta }: { org: string; repo: string; ruleId: string; meta: NonNullable<RecommendationView["rec"]["fixTemplate"]> }) {
  const [open, setOpen] = useState(false);
  // телефон: лист снизу — всплывающее окно над кнопкой уходило за верх экрана
  const phone = useMediaQuery("(max-width: 480px)");
  const [license, setLicense] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, { text: string } | { error: string }>>({});
  const base = `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/fix/${encodeURIComponent(ruleId)}`;
  const needsLicense = (meta.licenses?.length ?? 0) > 0;
  const key = needsLicense ? license : "";
  const loaded = key === null ? undefined : texts[key];

  useEffect(() => {
    if (!open || key === null || texts[key] !== undefined) return;
    const ctrl = new AbortController();
    const href = key ? `${base}?license=${encodeURIComponent(key)}` : base;
    fetch(href, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("text/plain")) throw new ReportError(res.ok ? 500 : res.status, null);
        const text = await res.text();
        setTexts((prev) => ({ ...prev, [key]: { text } }));
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setTexts((prev) => ({ ...prev, [key]: { error: fixFailureText(e instanceof ReportError ? e.status : 0) } }));
      });
    return () => ctrl.abort();
  }, [open, key, base, texts]);

  const text = loaded && "text" in loaded ? loaded.text : null;
  const download = (): void => {
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = meta.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const content = (
    <div className="rh-tpl">
      <Flex direction="column" gap={1}>
        <Text variant="subheader-1" className="rh-tpl__name">
          {meta.filename}
        </Text>
        <Text variant="body-1" color="complementary">
          {templateWhere(ruleId)}
        </Text>
      </Flex>
      {needsLicense && (
        <SegmentedRadioGroup size="m" value={license ?? ""} onUpdate={(v) => setLicense(v)} aria-label="Лицензия">
          {meta.licenses!.map((id) => (
            <SegmentedRadioGroup.Option key={id} value={id}>
              {LICENSE_TITLES[id] ?? id}
            </SegmentedRadioGroup.Option>
          ))}
        </SegmentedRadioGroup>
      )}
      {/* текст заготовки — моноширинно, с прокруткой; без выбора лицензии — подсказка */}
      {key === null ? (
        <Text variant="body-1" color="secondary" className="rh-tpl__empty">
          Выберите лицензию – текст появится здесь.
        </Text>
      ) : loaded === undefined ? (
        <Skeleton className="rh-tpl__skeleton" aria-busy="true" aria-label="Загружаем заготовку" />
      ) : "error" in loaded ? (
        <Flex gap={2} alignItems="center" wrap className="rh-tpl__empty">
          <Text variant="body-1" color="danger" role="status">
            {loaded.error}
          </Text>
          <Button view="outlined" size="s" onClick={() => setTexts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)))}>
            Повторить
          </Button>
        </Flex>
      ) : (
        <pre className="rh-tpl__code" tabIndex={0} aria-label={`Текст ${meta.filename}`}>
          {loaded.text}
        </pre>
      )}
      <Flex gap={2}>
        <CopyToClipboard text={text ?? ""} timeout={1500}>
          {(status) => (
            <Button view="normal" size="m" disabled={text === null}>
              <Icon data={status === "success" ? Check : Copy} size={16} />
              {status === "success" ? "Скопировано" : "Скопировать"}
            </Button>
          )}
        </CopyToClipboard>
        <Button view="flat" size="m" disabled={text === null} onClick={download}>
          <Icon data={ArrowDownToLine} size={16} />
          Скачать
        </Button>
      </Flex>
    </div>
  );

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    // сбой не запоминается: следующее открытие окна попробует снова
    if (!next) setTexts((prev) => Object.fromEntries(Object.entries(prev).filter(([, v]) => "text" in v)));
  };
  const button = (
    <Button view="outlined" size="s" aria-haspopup="dialog" aria-expanded={open} className="rh-rec__fix" onClick={phone ? () => onOpenChange(true) : undefined}>
      <Icon data={FileText} size={14} />
      {meta.filename}
      <Icon data={ChevronDown} size={14} />
    </Button>
  );
  if (phone) {
    return (
      <>
        {button}
        <Sheet visible={open} onClose={() => onOpenChange(false)} id={`rh-tpl-${ruleId}`} contentClassName="rh-tpl-sheet">
          {content}
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange} trigger="click" placement={["bottom-start", "top-start"]} content={content} aria-label={`Заготовка ${meta.filename}`}>
      {button}
    </Popover>
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
      {factWords(fact.key, fact.status, fact.value).map((l, i) => (
        <Text key={i} variant="body-short">
          {l}
        </Text>
      ))}
      {/* служебный ключ факта — внутри «Исходных данных», под самим значением */}
      <Disclosure size="m" summary="Исходные данные" className="rh-proof__raw-toggle">
        {/* один слой внутри — для анимации высоты (стили .g-disclosure__content) */}
        <div className="rh-collapse__inner">
          <pre className="rh-code rh-proof__raw">{fmtFactValue(fact.value)}</pre>
          <Text variant="caption-2" color="secondary" className="rh-proof__key">
            {fact.key}
          </Text>
        </div>
      </Disclosure>
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
}

function appsecBreakdown(card: Card): AppsecBreakdown | null {
  const fact = card.evidence.find((e) => e.key === "appsec.findings");
  if (!fact || fact.status !== "ok") return null;
  const backlog = (fact.value as { backlog?: { engines?: Record<string, number>; open_findings?: number | null } } | null)?.backlog;
  if (!backlog || typeof backlog.engines !== "object" || backlog.engines === null) return null;
  const all = Object.entries(backlog.engines).sort((a, b) => b[1] - a[1]);
  const sca = all.find(([name]) => /sca|composition|depend/i.test(name)) ?? null;
  return {
    engines: all.filter((pair) => pair !== sca),
    sca,
    openFindings: typeof backlog.open_findings === "number" ? backlog.open_findings : null,
  };
}

/** Находки AppSec по видам проверок — строки для вкладки «Находки AppSec». */
function appsecView(card: Card): { rows: { name: string; count: number; note?: string }[]; total: number } | null {
  const breakdown = appsecBreakdown(card);
  if (!breakdown || (breakdown.engines.length === 0 && breakdown.sca === null)) return null;
  const rows: { name: string; count: number; note?: string }[] = [
    ...breakdown.engines.map(([name, count]) => ({ name, count })),
    ...(breakdown.sca
      ? [{ name: `${breakdown.sca[0]} (зависимости, SCA)`, count: breakdown.sca[1], note: "Находки в зависимостях входят в оценку Безопасности наравне с остальными. Здесь они показаны отдельной строкой для наглядности." }]
      : []),
  ];
  return { rows, total: breakdown.openFindings ?? rows.reduce((a, r) => a + r.count, 0) };
}

/** Вкладка «Находки AppSec»: справочные строки (в балл категории разбивка не входит). */
function AppsecTable({ data }: { data: NonNullable<ReturnType<typeof appsecView>> }) {
  return (
    <>
      <div className="rh-cbd__table rh-cbd__table_refs" role="table" aria-label="Открытые находки AppSec по видам проверок">
        {data.rows.map((r) => (
          <RefLine key={r.name} icon={Bug} title={r.name} value={fmtNumber(r.count)} hint={r.note !== undefined ? [r.note] : null} />
        ))}
      </div>
    </>
  );
}

/**
 * Карта владельцев деревом (вариант T1, 19.10.2026): каталоги по числу изменений,
 * у каждого — полоса доли главного автора с чертой порога «единственного
 * владельца» (желтая — порог пройден), доля и имя. Подкаталоги — ветвями под
 * шевроном; у анализа старым сборщиком их нет, и дерево — один уровень.
 */
function OwnershipTree({ rows, thresholdPct }: { rows: OwnershipView["rows"]; thresholdPct: number }) {
  return (
    <div className="rh-owners">
      <ul className="rh-otree" aria-label="Карта владельцев файлов">
        {rows.map((r) => (
          <OwnerNode key={r.dir} row={r} thresholdPct={thresholdPct} child={false} />
        ))}
      </ul>
      <Flex gap={2} alignItems="center" className="rh-owners__legend">
        <span className="rh-owners__swatch rh-owners__swatch_single" aria-hidden="true" />
        <Text variant="caption-2" color="secondary">{`Единственный владелец – от ${thresholdPct}% изменений`}</Text>
      </Flex>
    </div>
  );
}

/**
 * Полоса долей авторов каталога: главный — первым сегментом (стальным, если он
 * единственный владелец), второй и третий — светлее, остаток — «другие». Черта —
 * порог единственного владельца. Подсказка (и фокус) — все доли словами.
 */
function SharesBar({ row: r, share, thresholdPct }: { row: OwnershipView["rows"][number]; share: number; thresholdPct: number }) {
  const parts = r.shares.length > 0 ? r.shares : [{ name: r.owner, share: share / 100 }];
  const pct = (v: number): number => Math.round(v * 100);
  const rest = Math.max(0, 100 - parts.reduce((a, p) => a + pct(p.share), 0));
  const lines = [...parts.map((p) => `${authorText(p.name)} – ${pct(p.share)}%`), ...(rest > 0 ? [`другие – ${rest}%`] : [])];
  return (
    <Tooltip content={<BreakdownTip lines={lines} />} placement={["top", "bottom"]} openDelay={150} closeDelay={0}>
      <span className="rh-otree__bar" tabIndex={0} role="img" aria-label={`Доли авторов: ${lines.join(", ")}`}>
        {parts.map((p, i) => (
          <i key={`${p.name}:${i}`} className={`rh-otree__seg rh-otree__seg_${i + 1}${i === 0 && r.single ? " rh-otree__seg_single" : ""}`} style={{ width: `${pct(p.share)}%` }} />
        ))}
        <b className="rh-otree__tick" style={{ left: `${thresholdPct}%` }} />
      </span>
    </Tooltip>
  );
}

const BOT_SUFFIX = /\s*[([]bot[)\]]$/i;

/** Имя автора: «(bot)» в конце — иконкой робота, а не текстом. */
function AuthorName({ name }: { name: string }) {
  if (!BOT_SUFFIX.test(name)) return <>{name}</>;
  return (
    <>
      {name.replace(BOT_SUFFIX, "")}
      <span className="rh-otree__bot" role="img" aria-label="бот" title="Бот">
        <Icon data={FaceRobot} size={14} />
      </span>
    </>
  );
}

/** Имя автора для подсказки: «(bot)» — словом. */
function authorText(name: string): string {
  return BOT_SUFFIX.test(name) ? `${name.replace(BOT_SUFFIX, "")}, бот` : name;
}

function OwnerNode({ row: r, thresholdPct, child }: { row: OwnershipView["rows"][number]; thresholdPct: number; child: boolean }) {
  const [open, setOpen] = useState(false);
  const kids = r.children;
  const share = parseInt(r.share, 10) || 0;
  return (
    <li className={child ? "rh-otree__item rh-otree__item_child" : "rh-otree__item"}>
      <div className="rh-otree__row">
        {/* шеврон — справа от имени, как у групп меню SourceCraft; ветки — уголками */}
        {kids.length > 0 ? (
          <button type="button" className="rh-otree__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Text color={child ? "secondary" : "complementary"} className="rh-otree__name">
              {r.dir}
            </Text>
            <ArrowToggle direction={open ? "top" : "bottom"} size={14} />
          </button>
        ) : (
          <Text color={child ? "secondary" : "complementary"} className="rh-otree__name">
            {r.dir}
          </Text>
        )}
        <SharesBar row={r} share={share} thresholdPct={thresholdPct} />
        {/* доля и автор — своими колонками общей сетки: проценты разряд под разрядом */}
        <span className="rh-otree__who">
          <Text className="rh-otree__share">{r.share}</Text>
          <Text color="secondary" className="rh-otree__owner">
            <AuthorName name={r.owner} />
            {`, авторов ${r.authors}`}
          </Text>
        </span>
      </div>
      {/* подкаталоги — анимацией высоты; обертка продолжает общую сетку дерева */}
      {kids.length > 0 && (
        <Collapse open={open} className="rh-otree__fold">
          <ul className="rh-otree__kids" aria-label={`Подкаталоги ${r.dir}`}>
            {kids.map((k) => (
              <OwnerNode key={k.dir} row={k} thresholdPct={thresholdPct} child />
            ))}
          </ul>
        </Collapse>
      )}
    </li>
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
