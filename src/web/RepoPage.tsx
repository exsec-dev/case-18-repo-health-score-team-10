// RepoPage.tsx — единая карточка репозитория (план §5 В3 + К2 В4.1):
// HealthCraft Index и полный Repo Health Score (В4.3), шесть категорий с
// раскрытием submetrics, маркеры и рекомендации с доказательствами. Состав ответа
// собирает сервер по доступу зрителя: закрытые ему блоки CI/Security
// приходят без чисел и показываются заглушкой по причине доступа.
// Главное правило экрана — трекер-закон в UI: ни одной фразы без факта
// либо без честного объяснения, почему факта нет.
// Раскладка как у страницы репозитория SourceCraft: действия в ActionBar,
// содержимое во вкладках, итоговая оценка — в правой панели.
import { ArrowDownToLine, ArrowUpRightFromSquare, ChevronDown, Clock, CodeFork, FileText, Heart, Lock, LogoMarkdown, SquareListUl } from "@gravity-ui/icons";
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
  Popover,
  Progress,
  Spin,
  Tab,
  TabList,
  TabPanel,
  TabProvider,
  Text,
  useToaster,
} from "@gravity-ui/uikit";
import { useEffect, useRef, useState } from "react";
import type { CardCategory } from "../api/repos";
import type { MeResponse, MetaResponse, RepoCard } from "./api";
import { fetchJson, mutateJson, useJson } from "./api";
import {
  CATEGORY_TITLES_RU,
  NO_DATA,
  NO_DATA_SHORT,
  NO_SCORE,
  SECURITY_PUBLIC_NOTE,
  accessLockText,
  analysisOutcome,
  fmtCoverage,
  fmtDate,
  fmtDateTime,
  fmtSigned,
  fmtFactValue,
  fmtNumber,
  fmtScore,
  fmtSubmetric,
  gitLimitsText,
  scanStatusText,
  scanTriggerText,
  contributionText,
  scoreColor,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  sentence,
  summaryLine,
} from "./format";
import { linkProps, navigate, useQueryParam } from "./router";
import { Page, type Crumb } from "./Shell";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, RepoAvatar, ScoreLegend, SkeletonRows } from "./ui";

type Card = RepoCard;
type Category = CardCategory;
type Evidence = Card["evidence"][number];
type Recommendation = Card["recommendations"][number];

export function RepoPage({ org, repo, meta }: { org: string; repo: string; meta: MetaResponse | null }) {
  const cardUrl = `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const { state, reload } = useJson<Card>(cardUrl);
  const me = useJson<MeResponse>("/api/me");
  const loggedIn = me.state.kind === "ok" && me.state.data.login !== null;
  const canRefresh = loggedIn && me.state.kind === "ok" && me.state.data.hasPat;
  const sinceScanId = state.kind === "ok" ? (state.data.scan?.id ?? 0) : 0;
  // Ф2.9/Ф2.15: горизонт опросов анализа — лиз job из /api/meta, не хардкод
  const leaseMs = meta?.queue.leaseMs ?? 85 * 60_000;
  // З3 (круг 2 В4.4): после успешного старта карточка ПЕРЕЧИТЫВАЕТСЯ —
  // тело переключается в job-ветку («Анализ запланирован/Сканируем») вслед
  // за заголовком, а не спорит с ним до конца скана
  const refresh = useRefreshAnalysis(org, repo, cardUrl, sinceScanId, reload, leaseMs, reload);
  // M-4: честное ожидание — из лиза job (горизонт одного скана), не хардкод
  const etaNote = `обычно до ${Math.max(1, Math.round(leaseMs / 60_000))} минут`;

  // Ф2.15: живая job зрителя — опрос карточки каждые 3 с, пока заявка не
  // доедет до скана; не дольше leaseMs (худший случай одного скана).
  // UX-10 (круг 2 В4.4): после leaseMs опрос прекращается ЗАМЕТКОЙ «затянулось»
  // (симметрично кабинету), а не молчаливым зависанием спиннера
  const [jobStalled, setJobStalled] = useState(false);
  const jobLive = state.kind === "ok" && state.data.job !== null;
  useEffect(() => {
    if (!jobLive) {
      setJobStalled(false);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > leaseMs) {
        setJobStalled(true);
        return;
      }
      reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [jobLive, leaseMs, reload]);

  const crumbs: Crumb[] = [{ text: "Рейтинг", href: "/" }, { text: `${org} / ${repo}` }];
  const refreshButton = canRefresh && (
    <Button view="action" size="m" onClick={refresh.start} disabled={refresh.phase !== "idle"} loading={refresh.phase === "sending"}>
      {refresh.phase === "queued" && <Spin size="xs" />}
      {refresh.phase === "queued" ? "Анализ в очереди" : "Обновить анализ"}
    </Button>
  );

  if (state.kind === "loading") {
    return (
      <Page crumbs={crumbs} aside={<SkeletonRows rows={3} height={96} />}>
        <Flex direction="column" gap={4}>
          <SkeletonRows rows={1} height={48} />
          <SkeletonRows rows={6} />
        </Flex>
      </Page>
    );
  }
  if (state.kind === "error") {
    // UX-5 (круг 2 В4.4): «Обновить анализ» на error-странице скрыт — здесь
    // sinceScanId = 0, опрос взял бы первый СТАРЫЙ скан и отпраздновал
    // false-success без нового скана; повтор — только «Повторить» (reload)
    return (
      <Page crumbs={crumbs}>
        <Alert
          theme="danger"
          view="outlined"
          title={`Не удалось открыть ${org}/${repo}`}
          message={state.message}
          actions={[{ text: "Повторить", handler: reload }]}
        />
      </Page>
    );
  }

  const card = state.data;
  const reportHref = `${cardUrl}/report.md`;
  const actions = (
    <Flex gap={2} alignItems="center">
      {card.score !== null && <ReportMenu mdHref={reportHref} />}
      {refreshButton}
    </Flex>
  );

  return (
    <Page crumbs={crumbs} actions={actions} aside={<ScoreAside card={card} meta={meta} leaseMs={leaseMs} jobStalled={jobStalled} />}>
      <Header
        card={card}
        starDoneKey={refresh.doneKey}
        starLoggedIn={me.state.kind === "ok" && me.state.data.login !== null}
      />
      {card.score !== null && <ScoreBand card={card} meta={meta} />}
      {card.score === null ? (
        card.job ? (
          // Ф2.15: первый анализ — статус живой job вместо лжи «скана ещё не было»
          <EmptyState
            icon={SquareListUl}
            title={card.job.status === "queued" ? "Анализ запланирован" : "Сканируем…"}
            description={
              (card.job.status === "queued"
                ? `Заявка стоит в очереди – ее возьмут в работу, и здесь появится статус скана. ${etaNote}.`
                : `Скан собирает факты из репозитория; Score появится после завершения. ${etaNote}.`) +
              // UX-10 (круг 2 В4.4): симметричная кабинету заметка после leaseMs
              (jobStalled ? " Затянулось – смотрите панель заданий в кабинете." : "")
            }
          />
        ) : (
          // В4.4 (кластер E): «скана не было» ≠ «скан был — сбой/мало данных»;
          // CTA — по возможностям зрителя (запуск/токен/объяснение)
          <EmptyState
            icon={SquareListUl}
            title={card.scan ? "Скан был – данных для оценки не хватило" : "Репозиторий есть в каталоге, но еще не сканировался"}
            description={
              card.scan
                ? `Последний скан (${sentence(scanStatusText(card.scan.status))}) не собрал достаточно фактов для честного числа – это отсутствие данных, а не плохая оценка. Повторный анализ соберет факты заново.`
                : "Score появится после первого скана: его считает код по фактам, а фактов пока нет."
            }
            actions={
              canRefresh
                ? [{ text: card.scan ? "Повторить анализ" : "Запустить анализ", view: "action", size: "l", onClick: refresh.start }]
                : loggedIn
                  ? [
                      // UX-6 (круг 2 В4.4): на ветке «Скан был» анализа уже были —
                      // слово «первый» обещало то, чего не случится
                      { text: card.scan ? "Добавьте токен в кабинете – и запустите анализ" : "Добавьте токен в кабинете – и запустите первый анализ", view: "action", size: "l", href: "/me" },
                    ]
                  : undefined
            }
          />
        )
      ) : (
        <Flex direction="column" gap={4}>
          <Markers card={card} />
          <CardTabs card={card} meta={meta} />
        </Flex>
      )}
    </Page>
  );
}

/**
 * «Отчёт»: формат выбирается в меню. MD — тот же генератор, что рисует
 * страницу (§2.3); PDF заложен в интерфейс, генератора пока нет — пункт
 * виден, но ничего не делает.
 */
function ReportMenu({ mdHref }: { mdHref: string }) {
  return (
    <DropdownMenu
      size="m"
      popupProps={{ placement: "bottom-end" }}
      renderSwitcher={(props) => (
        <Button {...props} view="normal" size="m" aria-haspopup="menu">
          <Icon data={ArrowDownToLine} size={16} />
          Отчет
          <Icon data={ChevronDown} size={16} />
        </Button>
      )}
      items={[
        { text: "Markdown (.md)", iconStart: <Icon data={LogoMarkdown} size={16} />, href: mdHref },
        { text: "PDF (.pdf)", iconStart: <Icon data={FileText} size={16} />, action: () => {} },
      ]}
    />
  );
}

/**
 * «Обновить анализ» — зрителю с сессией и PAT (К2). Сервер проверяет доступ
 * PAT до постановки (К3); ответ показывается как есть, опрос карточки — до
 * появления нового завершённого скана, но не дольше leaseMs из /api/meta
 * (Ф2.9: раньше горизонт был зашит на 60 минут). Итог — тостом, как у платформы.
 */
function useRefreshAnalysis(org: string, repo: string, cardUrl: string, sinceScanId: number, onDone: () => void, leaseMs: number, onStarted: () => void) {
  const [phase, setPhase] = useState<"idle" | "sending" | "queued">("idle");
  /** ключ sessionStorage `<org>/<repo>:<jobId>` скана, чей переход active→done увиден в этой сессии (Ф2.20) */
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const jobIdRef = useRef<number | null>(null);
  const toaster = useToaster();

  useEffect(() => {
    if (phase !== "queued") return;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > leaseMs) {
        setPhase("idle");
        return;
      }
      try {
        const card = await fetchJson<Card>(cardUrl);
        if (card.scan && card.scan.id > sinceScanId) {
          // В4.4 (кластер E): исход — по статусу скана; bad больше не
          // празднуется success-тостом «Анализ завершен»
          const outcome = analysisOutcome(card.scan);
          if (outcome === "pending") return;
          setPhase("idle");
          if (outcome === "ok") {
            if (jobIdRef.current !== null) setDoneKey(`${org}/${repo}:${jobIdRef.current}`);
            toaster.add({ name: `scan-done:${org}/${repo}`, theme: "success", title: "Анализ завершен", content: "Карточка обновлена по новому скану." });
          } else {
            toaster.add({
              name: `scan-failed:${org}/${repo}`,
              theme: "danger",
              title: "Анализ завершился ошибкой",
              content: "Сбор данных не удался – подробности в «Моих заданиях» кабинета.",
            });
          }
          onDone();
        }
      } catch {
        /* карточки ещё нет — следующий тик */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [phase, cardUrl, sinceScanId, onDone, toaster, org, repo, leaseMs]);

  async function start() {
    setPhase("sending");
    try {
      const res = await mutateJson<{ queued?: boolean; jobId?: number }>(
        `/api/me/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/scan`,
        "POST",
      );
      jobIdRef.current = typeof res.jobId === "number" ? res.jobId : null;
      setPhase("queued");
      // З3: перечитывание сразу после постановки — card.job появляется и
      // подхватывает свой 3-секундный опрос
      onStarted();
      toaster.add({ name: `scan-queued:${org}/${repo}`, theme: "info", title: "Анализ в очереди", content: "Карточка обновится после скана." });
    } catch (e) {
      setPhase("idle");
      toaster.add({
        name: `scan-failed:${org}/${repo}`,
        theme: "danger",
        title: "Анализ не запущен",
        content: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { phase, start, doneKey };
}

function Header({ card, starDoneKey, starLoggedIn }: { card: Card; starDoneKey: string | null; starLoggedIn: boolean }) {
  const { repo: r } = card;
  return (
    <div style={{ marginBottom: "var(--g-spacing-4)" }}>
      {/* аватар l (42px) ровно на высоту блока «название 24 + мета 16» */}
      <div className="rh-repo-head">
        <RepoAvatar repo={r.repo} logoUrl={r.logoUrl} size="l" />
        <Flex direction="column" justifyContent="space-between" style={{ minWidth: 0 }}>
          <Flex gap={1} alignItems="center" style={{ minWidth: 0 }}>
            <Text variant="header-1" as="h1" ellipsis>
              {r.org} / {r.repo}
            </Text>
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
          <Meta>
            <MetaItem title="Язык">
              <LanguageName name={r.language} color={r.languageColor} />
            </MetaItem>
            <MetaItem icon={Heart} title="Лайки">
              {fmtNumber(r.likes)}
            </MetaItem>
            <MetaItem icon={CodeFork} title="Форки">
              {fmtNumber(r.forks)}
            </MetaItem>
            <MetaItem icon={Clock} title="Последняя активность">
              активность {fmtDate(r.lastActivityAt)}
            </MetaItem>
          </Meta>
        </Flex>
      </div>
      {r.title && r.title !== r.repo && (
        <Text as="p" color="complementary" style={{ margin: "var(--g-spacing-2) 0 0" }}>
          {r.title}
        </Text>
      )}
    </div>
  );
}

/**
 * В4.6 (У26, ДП7): значение таба живёт в query (`?tab=recommendations`), а не
 * в локальном состоянии. Раньше ссылку на рекомендации дать было нельзя,
 * «назад» из них не работал и привести зрителя прямо к следующему шагу (из
 * кабинета, из письма, из питча) было невозможно — именно это делало
 * следующий шаг спрятанным. `replace: true` у сброса на «Категории»: дефолт
 * не должен засорять историю браузера.
 */
export const TAB_RECOMMENDATIONS = "recommendations";

function CardTabs({ card, meta }: { card: Card; meta: MetaResponse | null }) {
  const tab = useQueryParam("tab") === TAB_RECOMMENDATIONS ? TAB_RECOMMENDATIONS : "categories";
  const setTab = (next: string): void => {
    const url = next === TAB_RECOMMENDATIONS ? `${window.location.pathname}?tab=${TAB_RECOMMENDATIONS}` : window.location.pathname;
    navigate(url, { replace: next !== TAB_RECOMMENDATIONS });
  };
  return (
    <TabProvider value={tab} onUpdate={setTab}>
      <TabList size="m">
        <Tab value="categories">Категории</Tab>
        <Tab value="recommendations" counter={card.recommendations.length}>
          Рекомендации
        </Tab>
      </TabList>
      <div style={{ paddingTop: "var(--g-spacing-3)" }}>
        <TabPanel value="categories">
          <Categories card={card} meta={meta} />
        </TabPanel>
        <TabPanel value="recommendations">
          <Recommendations card={card} />
        </TabPanel>
      </div>
    </TabProvider>
  );
}

// ---------- правая панель: итог ----------

/** Причина закрытия полного итога: первый закрытый канал (CI, затем Security). */
function fullLockReason(card: Card): string | null {
  return accessLockText(card.access.cicd) ?? accessLockText(card.access.appsec);
}

/**
 * В4.6 (вариант А компоновки, решение владельца 20.09): правая панель стала
 * ЧИСТО МЕТОДИЧЕСКОЙ. Величина уехала в главную колонку (`ScoreBand`), потому
 * что здесь она стояла на x = 80% ширины окна, последней в DOM и последней для
 * глаза при чтении слева направо. Осталось только «как читать оценку», «что
 * считаем», «каких данных не хватило» и реквизиты расчёта — панель впервые
 * получила однородное содержание (охранный пункт 10 не просто соблюдён, а
 * усилен: панель никуда не исчезает и в модальные окна не переезжает).
 */
function ScoreAside({ card, meta, leaseMs, jobStalled }: { card: Card; meta: MetaResponse | null; leaseMs: number; jobStalled: boolean }) {
  const { score, scan, job } = card;
  const threshold = meta ? fmtCoverage(meta.coverageNullBelow) : "порога";
  return (
    <>
      {/* В4.6 (У22): тот же блок, что на рейтинге — вариант А кладёт шкалу в методику карточки */}
      {score && <ScoreLegend />}

      {score && (
        <AsideSection title="Что считаем">
          {/* В4.6 (У24): ЭТО и есть находка ДП5 — семистрочный абзац был набран
              вариантом для однострочных подписей (body-short 13/16) и вторичным
              цветом. Стало body-2 13/18 + complementary: интерлиньяж абзаца и
              7,0:1 против 5,34:1 в тёмной теме. */}
          <Text as="p" variant="body-2" color="complementary">
            {meta ? `При покрытии данными ниже ${threshold} показатель не выставляется: без данных честного числа нет. ` : ""}
            HealthCraft Index строят 4 публичные категории; CI и Security входят только в Repo Health Score – он виден участникам
            репозитория с доступом к этим данным.
          </Text>
        </AsideSection>
      )}

      {score && score.noData.length > 0 && (
        <AsideSection title="Каких данных не хватило">
          <Flex as="ul" direction="column" gap={2} style={{ margin: 0, paddingInlineStart: "var(--g-spacing-4)" }}>
            {score.noData.map((raw) => (
              <li key={raw}>
                <Text color="complementary">{humanNoData(raw)}</Text>
              </li>
            ))}
          </Flex>
        </AsideSection>
      )}

      {/* В4.6 (вариант А): жаргон и идентификаторы (номер скана, версия модели)
          собраны ОДНИМ блоком под честным заголовком и стоят последними —
          первый взгляд просил убрать их с видного места, но не терять */}
      <AsideSection title="Реквизиты расчета">
        {scan ? (
          <DefinitionList nameMaxWidth={120}>
            <DefinitionList.Item name="Завершен">{fmtDateTime(scan.finishedAt ?? scan.startedAt)}</DefinitionList.Item>
            <DefinitionList.Item name="Статус">
              <Label theme={scan.status === "ok" ? "success" : scan.status === "bad" ? "danger" : "warning"} size="xs">
                {sentence(scanStatusText(scan.status))}
              </Label>
            </DefinitionList.Item>
            <DefinitionList.Item name="Запуск">{scanTriggerText(scan.trigger)}</DefinitionList.Item>
            <DefinitionList.Item name="Номер">#{scan.id}</DefinitionList.Item>
            {score && <DefinitionList.Item name="Модель">{score.modelVersion}</DefinitionList.Item>}
          </DefinitionList>
        ) : job ? (
          // Ф2.15: живая job зрителя — «в очереди/сканируем», а не «скана не было»; M-4 — ожидание по лизу.
          // UX-10 (круг 2 В4.4): после leaseMs — заметка «затянулось», не вечный спиннер
          jobStalled ? (
            <Label theme="warning" size="xs">
              затянулось – смотрите панель заданий
            </Label>
          ) : (
            <Flex gap={2} alignItems="center" title={`обычно до ${Math.max(1, Math.round(leaseMs / 60_000))} минут`}>
              <Spin size="xs" />
              <Text color="secondary">{job.status === "queued" ? "в очереди" : "сканируем…"}</Text>
            </Flex>
          )
        ) : (
          <Text color="secondary">Скана еще не было</Text>
        )}
      </AsideSection>
    </>
  );
}

/**
 * ВЕЛИЧИНА — блок-полоса первым экраном главной колонки (В4.6, вариант А
 * компоновки; замечание владельца 13 и корни ДП2/ДП4/ДП7 дизайн-пары).
 *
 * Что именно это лечит, числами замера 20.09: раньше «83» стояло на x = 1136
 * из 1418 (80% ширины окна вправо), `Page` рендерил `main` и только потом
 * `aside` — то есть главная величина была последней и для глаза, и для
 * скринридера, а первое, что попадало в главную колонку, — номинальные веса.
 * Контент колонки заканчивался на 59% её высоты, остальное был фон.
 *
 * Три яруса блока: величины, покрытие строкой, итог с действием.
 * Полоса покрытия СНЯТА (находка Z5 пары): рядом с 83 стояла полная полоса,
 * измеряющая не его, а покрытие данными — она конкурировала с самим
 * показателем. Покрытие осталось строкой текста, полоса отдана величине.
 */
function ScoreBand({ card, meta }: { card: Card; meta: MetaResponse | null }) {
  const score = card.score!;
  const titleOf = (key: string): string => meta?.categories.find((c) => c.key === key)?.title ?? CATEGORY_TITLES_RU[key] ?? key;
  const withDelta = card.recommendations.filter((r) => r.deltaScore !== null);
  const top = withDelta.length > 0 ? withDelta.reduce((a, b) => ((a.deltaScore ?? 0) >= (b.deltaScore ?? 0) ? a : b)) : null;
  const summary = summaryLine({
    categories: (Object.entries(score.categories) as [string, Category][]).map(([key, cat]) => ({ title: titleOf(key), score: cat.score })),
    recommendations: card.recommendations.length,
    top: top ? { problem: top.problem, impact: top.expectedImpact ?? fmtSigned(top.deltaScore!) } : null,
  });
  return (
    <Card view="outlined" className="rh-score-band">
      <Flex direction="column" gap={3}>
        <Flex gap={6} wrap>
          <ScoreFigure
            title="HealthCraft Index"
            help="Публичная оценка из 4 категорий: Документация, Активность, Issues, Code health. По ней репозитории сравниваются в общем рейтинге."
            total={score.healthcraftIndex}
            coverage={score.indexCoverage}
            withBar
          />
          {score.fullLocked ? (
            <Flex direction="column" gap={1} style={{ flex: "1 1 240px", minWidth: 0 }}>
              <Text color="secondary">Repo Health Score</Text>
              <Flex gap={2} alignItems="center">
                <Icon data={Lock} size={16} />
                <Text variant="subheader-2">закрыто</Text>
              </Flex>
              <Text variant="body-2" color="complementary">
                {fullLockReason(card)}
              </Text>
              {/* П-Z7 дизайн-пары: под текстом замка — переход туда, где замок снимается */}
              <Flex>
                <Button view="normal" size="s" {...linkProps("/me")}>
                  Открыть личный кабинет
                </Button>
              </Flex>
            </Flex>
          ) : (
            <Flex direction="column" gap={1} style={{ flex: "1 1 240px", minWidth: 0 }}>
              <ScoreFigure
                title="Repo Health Score"
                help="Полная оценка по всем 6 категориям (с CI и Security). Видна участникам репозитория с доступом к этим данным."
                total={score.repoHealthScore}
                coverage={score.repoHealthCoverage ?? 0}
              />
              {score.repoHealthScore !== null && score.healthcraftIndex !== null &&
                // К-Ф3.4: фактическая signed-дельта — знак не обещается (плохие
                // CI/Security опускают полный показатель ниже индекса);
                // M-13: |Δ| < 0.05 — «разницы нет», не «+0.0»
                (Math.abs(score.repoHealthScore - score.healthcraftIndex) < 0.05 ? (
                  <Text variant="body-2" color="complementary">
                    Разницы нет: CI и Security на этом скане нейтральны.
                  </Text>
                ) : (
                  <Text variant="body-2" color="complementary">
                    Разницу с HealthCraft Index дают CI и Security: {fmtSigned(score.repoHealthScore - score.healthcraftIndex)}.
                  </Text>
                ))}
            </Flex>
          )}
        </Flex>

        {/* нижний ярус: итог и следующий шаг, отделённые линией (У26 + У13) */}
        <Flex gap={3} alignItems="center" justifyContent="space-between" wrap className="rh-score-band__summary">
          <Text variant="body-1" color="complementary" style={{ flex: "1 1 320px" }}>
            {summary}
          </Text>
          {card.recommendations.length > 0 && (
            <Button view="normal" size="m" {...linkProps(`${window.location.pathname}?tab=${TAB_RECOMMENDATIONS}`)}>
              Что делать ({card.recommendations.length})
            </Button>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}

function ScoreFigure({
  title,
  help,
  total,
  coverage,
  withBar = false,
}: {
  title: string;
  help: string;
  total: number | null;
  coverage: number;
  withBar?: boolean;
}) {
  return (
    <Flex direction="column" gap={1} style={{ flex: "1 1 240px", minWidth: 0 }}>
      <Flex gap={1} alignItems="center">
        <Text color="secondary">{title}</Text>
        <HelpMark iconSize="s" aria-label={`Что такое «${title}»`}>
          {help}
        </HelpMark>
      </Flex>
      {total === null ? (
        <Label theme="unknown" size="m">
          {NO_SCORE}
        </Label>
      ) : (
        <Flex gap={2} alignItems="baseline" wrap>
          <Text variant="display-2">{fmtScore(total)}</Text>
          <Text color="secondary">из 100</Text>
          {/* В4.6 (У22): шкала вплотную к числу — иначе «83» не с чем сравнить */}
          <Label theme={scoreLabelTheme(total)} size="m">
            {sentence(scoreWord(total))}
          </Label>
        </Flex>
      )}
      {/* В4.6 (У21): полоса измеряет САМ показатель, а не покрытие; мера 360px
          из варианта А — иначе на 1920 она превращается в декоративную линию */}
      {withBar && total !== null && (
        <div style={{ maxWidth: 360 }}>
          <Progress value={Math.round(total)} size="s" theme={scoreTheme(total)} />
        </div>
      )}
      {/* покрытие — строкой, без своей полосы (находка Z5 дизайн-пары) */}
      <Text variant="body-short" color="secondary">
        данных хватило: {fmtCoverage(coverage)}
      </Text>
    </Flex>
  );
}

// ---------- категории ----------

function Categories({ card, meta }: { card: Card; meta: MetaResponse | null }) {
  const score = card.score!;
  const entries = Object.entries(score.categories) as [string, Category][];
  // фактический вклад после перенормировки: вес категории делится на сумму
  // весов тех категорий, у которых данные есть (§4 методики)
  const dataWeight = entries.reduce((sum, [, cat]) => (cat.score === null ? sum : sum + cat.weight), 0);
  const titleOf = (key: string): string => meta?.categories.find((c) => c.key === key)?.title ?? CATEGORY_TITLES_RU[key] ?? key;
  /**
   * В4.6 (вариант А): ХУДШАЯ категория раскрыта по умолчанию — низ экрана
   * занимают доказательства, а не фон (корень ДП4: контент главной колонки
   * заканчивался на 59% её высоты). Она же — то место, куда ведёт строка
   * итога «слабее всего», поэтому раскрытие совпадает с прочитанным.
   * Категории без данных в расчёт худшей не идут: «нет данных» не плохо.
   */
  const worstKey = entries
    .filter(([, cat]) => cat.score !== null)
    .sort((a, b) => (a[1].score ?? 0) - (b[1].score ?? 0))[0]?.[0];

  return (
    <ul className="rh-list" style={{ borderTop: 0 }}>
      {entries.map(([key, cat]) => (
        <CategoryRow
          key={key}
          categoryKey={key}
          title={titleOf(key)}
          cat={cat}
          contribution={cat.score === null ? 0 : Math.round((cat.weight / Math.max(1, dataWeight)) * 100)}
          card={card}
          defaultOpen={key === worstKey}
        />
      ))}
    </ul>
  );
}

function CategoryRow({
  categoryKey: key,
  title,
  cat,
  contribution,
  card,
  defaultOpen = false,
}: {
  categoryKey: string;
  title: string;
  cat: Category;
  contribution: number;
  card: Card;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const subs = Object.entries(cat.submetrics);
  const expandable = subs.length > 0;

  // причина закрытого канала уже написана в блоке Score правой панели — в строке
  // повторяем её, только если она отличается (иначе один текст стоит трижды)
  const lockNote = cat.locked !== undefined ? accessLockText(cat.locked) : null;
  const note =
    cat.locked !== undefined
      ? lockNote === fullLockReason(card) && card.score?.fullLocked
        ? null
        : lockNote
      : cat.score === null
        ? `${key === "security" ? securityNote(card) : humanNoData(`${key}: ${cat.no_data ?? ""}`)} Категория не снизила Score: ее вес выброшен, остальные перенормированы.`
        : cat.no_data
          ? humanNoData(`${key}: ${cat.no_data}`)
          : null;

  const row = (
    <>
      {expandable ? <ArrowToggle direction={open ? "bottom" : "right"} size={14} /> : <span />}
      <Text variant="subheader-1" ellipsis>
        {title}
      </Text>
      <span className="rh-category__bar">
        {cat.locked !== undefined ? (
          <Flex gap={1} alignItems="center">
            <Icon data={Lock} size={14} />
            <Text color="secondary" title={lockNote ?? undefined}>
              закрыто
            </Text>
          </Flex>
        ) : cat.score === null ? (
          <Text color="secondary">{NO_DATA}</Text>
        ) : (
          <Progress value={Math.round(cat.score)} size="s" theme={scoreTheme(cat.score)} />
        )}
      </span>
      {/* В4.6 (У20): число окрашено теми же порогами, что полоса; отсутствие данных —
          ДРУГОЙ тип ячейки (нейтральный Label), а не бледное значение (закон 2) */}
      {cat.score === null ? (
        <Label theme="unknown" size="xs" className="rh-category__value" title={NO_SCORE}>
          {NO_DATA_SHORT}
        </Label>
      ) : (
        <Text variant="subheader-2" color={scoreColor(cat.score)} className="rh-category__value" title={sentence(scoreWord(cat.score))}>
          {fmtScore(cat.score)}
        </Text>
      )}
      {/* В4.6 (У25, ДП6): у категории без данных «вклад 0%» превращался в
          «категория дала ноль» — единственное место, где продукт своими руками
          опровергал собственный tri-state. Теперь там «не учитывается». */}
      <Text variant="body-short" color="secondary" className="rh-category__weight" title="номинальный вес категории в Repo Health Score → вклад после перенормировки">
        вес {cat.weight}% → вклад {contributionText(cat.score, contribution)}
      </Text>
      <span className="rh-category__tags">
        {cat.stale && (
          <Label theme="warning" size="xs">
            Факты из истории
          </Label>
        )}
      </span>
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
      {note && (
        <div style={{ padding: "0 var(--g-spacing-3) var(--g-spacing-3) calc(16px + var(--g-spacing-6))", marginTop: "calc(-1 * var(--g-spacing-1))" }}>
          <Text variant="body-2" color="complementary">
            {note}
          </Text>
        </div>
      )}
      {open && (
        <div className="rh-subrows">
          {subs.map(([subKey, sub]) => (
            <div key={subKey} className="rh-subrow">
              <Text>{submetricTitle(key, subKey)}</Text>
              <Text color="complementary">
                {displayOnly(key, subKey) ? "показ, без веса" : sub.score === null ? NO_DATA : `${fmtSubmetric(sub.score)} / 100`}
              </Text>
              <Text color="secondary" wordBreak="break-word">
                значение: {fmtFactValue(sub.value)}
                {sub.note ? ` (${sub.note})` : ""}
              </Text>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

// ---------- маркеры расчёта ----------

function Markers({ card }: { card: Card }) {
  const m = card.markers;
  const rows: { key: string; label: string; text: string }[] = [];
  if (m.staleFacts) {
    rows.push({
      key: "stale",
      label: "Факты из истории",
      text: "Часть источников ответила сбоем канала, поэтому в расчет пошли последние успешные факты предыдущих сканов. Сбой трубы – не отсутствие данных, и он не превращается в премию или штраф.",
    });
  }
  if (m.gitLimits) {
    rows.push({ key: "git-limits", label: "Репозиторий больше лимита сервиса", text: gitLimitsText(m.gitLimits) });
  }
  // Ф2.9 (LOW-9): маркер codeEmpty API отдаёт, но карточка молчала — зритель
  // видел Score 0 без объяснения, хотя это данные о проекте (Q&A №13)
  if (m.codeEmpty) {
    rows.push({
      key: "code-empty",
      label: "В репозитории нет кода",
      text: "В репозитории нет ни одного файла, поэтому по методике Score равен 0 – это данные о проекте («проекта нет»), а не отсутствие оценки или сбой сбора.",
    });
  }
  if (m.historyTruncatedSince) {
    rows.push({
      key: "truncated",
      label: "История усечена",
      text: `Репозиторий слишком велик для полного клона, сработал деградационный ярус: git-история видна с ${fmtDate(m.historyTruncatedSince)}. Метрики активности и возраста TODO посчитаны по видимой части.`,
    });
  }
  if (m.ciConfigOnlyCap) {
    rows.push({
      key: "ci-cap",
      label: "CI заявлен, прогоны недоступны",
      text: "Конфигурация CI в репозитории есть, но статусы прогонов закрыты правами (403 для чужих репозиториев). Заявленный CI дает максимум 50 из 100 – доказательства дают прогоны.",
    });
  }
  if (rows.length === 0) return null;

  return (
    <Flex direction="column" gap={2} role="region" aria-label="Особенности расчета">
      {rows.map((row) => (
        <Alert key={row.key} theme="warning" view="outlined" size="s" title={row.label} message={row.text} />
      ))}
    </Flex>
  );
}

// ---------- рекомендации ----------

function Recommendations({ card }: { card: Card }) {
  const evidence = new Map(card.evidence.map((e) => [e.key, e]));
  if (card.recommendations.length === 0) {
    return (
      <EmptyState
        icon={SquareListUl}
        title="Рекомендаций нет"
        description="Правила движка не нашли, к чему придраться на текущих фактах."
      />
    );
  }
  return (
    <Flex direction="column" gap={3}>
      {/* В4.6 (У24): два предложения в полную ширину колонки — проза */}
      <Text variant="body-1" color="complementary">
        Порядок задан движком правил: сперва измеримый прирост Score, затем то, что открывает закрытую категорию,
        затем улучшения по уже собранным данным. Каждый факт открывается по клику.
      </Text>
      <ul className="rh-list">
        {card.recommendations.map((rec) => (
          <RecommendationRow key={rec.ruleId} rec={rec} evidence={evidence} />
        ))}
      </ul>
    </Flex>
  );
}

function RecommendationRow({ rec, evidence }: { rec: Recommendation; evidence: Map<string, Evidence> }) {
  return (
    <li className="rh-list__item">
      <Flex direction="column" gap={2}>
        <Flex gap={2} alignItems="baseline" wrap>
          <Text color="secondary">#{rec.priority}</Text>
          <Text variant="subheader-2">{rec.problem}</Text>
          {rec.deltaScore !== null ? (
            <Label theme="success" size="xs" title="Прирост показателя, если выполнить только эту рекомендацию">
              {fmtSigned(rec.deltaScore)} к {rec.channel ? "Repo Health Score" : "HealthCraft Index"}
            </Label>
          ) : rec.opensCategory ? (
            <Label theme="info" size="xs" title="Категория без данных станет считаемой">
              Откроет категорию
            </Label>
          ) : null}
        </Flex>
        <Text>{rec.action}</Text>
        {rec.expectedImpact && <Text color="complementary">Эффект: {rec.expectedImpact}</Text>}
        <Flex gap={2} wrap alignItems="center">
          <Text variant="body-short" color="secondary">
            Основано на фактах:
          </Text>
          {rec.factRefs.map((ref) => (
            <Popover
              key={ref.key}
              trigger="click"
              placement={["bottom-start", "top-start"]}
              content={<FactProof factKey={ref.key} fact={evidence.get(ref.key)} />}
            >
              <Label theme={ref.missing ? "unknown" : "info"} size="xs" interactive>
                {ref.key}
              </Label>
            </Popover>
          ))}
        </Flex>
      </Flex>
    </li>
  );
}

/** Содержимое поповера факта: значение либо объяснение, почему факта нет. */
function FactProof({ factKey, fact }: { factKey: string; fact: Evidence | undefined }) {
  if (!fact) {
    return (
      <Flex direction="column" gap={1} style={{ maxWidth: 420, padding: "var(--g-spacing-3)" }}>
        <Text variant="subheader-1">{factKey} – факта нет по построению</Text>
        <Text color="complementary">{SECURITY_PUBLIC_NOTE}</Text>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap={2} style={{ maxWidth: 480, padding: "var(--g-spacing-3)" }}>
      <Flex gap={2} wrap alignItems="center">
        <Text variant="subheader-1">{fact.key}</Text>
        <Label theme={fact.status === "ok" ? "success" : fact.status === "bad" ? "warning" : "unknown"} size="xs">
          {sentence(factStatusText(fact.status))}
        </Label>
      </Flex>
      <Text variant="body-short" color="secondary">
        источник {fact.source}, собрано {fmtDateTime(fact.collectedAt)}
      </Text>
      <pre className="rh-code" style={{ maxHeight: 280, overflow: "auto" }}>
        {fmtFactValue(fact.value)}
      </pre>
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
      return "сбой канала";
    default:
      return status;
  }
}

/**
 * Причины no-data движок пишет по-английски и кодами каналов — экран
 * переводит их в человеческую фразу, не теряя исходной строки смысла.
 */
export function humanNoData(raw: string): string {
  const [category = "", ...rest] = raw.split(":");
  const reason = rest.join(":").trim();
  const prefix = category === "security" ? "" : `${categoryWord(category)}: `;
  if (category === "security" || reason.startsWith("AppSec data unavailable")) return SECURITY_PUBLIC_NOTE;
  if (reason.startsWith("ci runs no-data")) {
    return `${prefix}прогоны CI недоступны (закрыты правами или их нет) – категория ограничена потолком 50.`;
  }
  if (reason === "git channel no-data") return `${prefix}git-канал не отдал данные (клон не удался или уперся в лимиты).`;
  if (reason === "git+rest channels no-data") return `${prefix}ни git-, ни REST-канал не отдали данных.`;
  if (reason === "issues channel no-data") return `${prefix}данные трекера задач недоступны.`;
  return `${prefix}${reason || NO_DATA}`;
}

function categoryWord(key: string): string {
  const words: Record<string, string> = {
    documentation: "Документация",
    cicd: "CI/CD",
    security: "Security",
    activity: "Активность",
    issues: "Issues",
    code: "Code health",
  };
  return words[key] ?? key;
}

/** Показ-без-веса (§7.3 методики): число объясняет картину, но в Score не идёт. */
const DISPLAY_ONLY = new Set([
  "activity.mirror_likeness",
  "activity.commits_90d",
  "activity.commits_365d",
  "activity.sync_bursts",
  "code.todo_total",
]);

function displayOnly(category: string, sub: string): boolean {
  return DISPLAY_ONLY.has(`${category}.${sub}`);
}

const SUBMETRIC_TITLES: Record<string, string> = {
  "documentation.readme": "README (наличие и качество)",
  "documentation.license": "Лицензия",
  "documentation.contributing": "CONTRIBUTING",
  "documentation.codeowners": "CODEOWNERS",
  "cicd.config": "Конфигурация CI со шагами",
  "cicd.pass_rate": "Доля успешных прогонов",
  "cicd.duration": "Медианная длительность пайплайна",
  "security.density": "Плотность находок на 10К строк",
  "security.resolved": "Доля закрытых находок",
  "security.secrets": "Отсутствие критичных утечек",
  "activity.fresh": "Свежесть последнего коммита человека",
  "activity.freq": "Частота коммитов",
  "activity.contributors": "Число авторов",
  "activity.pulls_90d": "Merge-request'ы за 90 дней",
  "activity.releases_12m": "Релизы за 12 месяцев",
  "activity.mirror_likeness": "Похожесть на зеркало",
  "activity.commits_90d": "Коммиты за 90 дней",
  "activity.commits_365d": "Коммиты за год",
  "activity.sync_bursts": "Всплески синхронизации",
  "issues.stale": "Доля зависших issues",
  "issues.close_days": "Медиана времени закрытия",
  "issues.resolution": "Доля решенных",
  "issues.first_resp": "Время до первого ответа",
  "issues.tracker_unused": "Трекер не ведется",
  "code.density": "Плотность TODO/FIXME",
  "code.old_share": "Доля старых TODO",
  "code.root": "Порядок в корне репозитория",
  "code.todo_total": "Всего маркеров TODO/FIXME",
};

function submetricTitle(category: string, sub: string): string {
  return SUBMETRIC_TITLES[`${category}.${sub}`] ?? sub;
}

/** Причина no-data Security при открытом канале — из факта appsec.findings (честный tri-state). */
function securityNote(card: Card): string {
  const fact = card.evidence.find((e) => e.key === "appsec.findings");
  const reason = fact && fact.status === "no-data" ? (fact.value as { reason?: string }).reason : undefined;
  if (reason === "access") {
    return "AppSec этого репозитория недоступен токену скана: право src.repositories.useAppSecScan не выдано. Это отсутствие данных, не ноль – вес категории выброшен.";
  }
  if (reason === "no-scan") {
    return "Завершенного скана AppSec нет (не запускался или еще идет). Это отсутствие данных, не ноль.";
  }
  if (reason === "incomplete") {
    return "AppSec API ответил неполно (канал/пагинация). Ошибка – не отсутствие уязвимостей: вес категории выброшен до успешного пересбора.";
  }
  return SECURITY_PUBLIC_NOTE;
}


// ========== ПОРТ 6 (hq-parallel): избранное на карточке ==========

/**
 * Ф2.20 (решение 18.09): после успешного own-скана НЕзаполненная звезда один
 * раз получает неблокирующий зелёный glow (модалка запрещена). «Один раз» =
 * переход active→done в текущей browser-session: ключ `<org>/<repo>:<jobId>`
 * в sessionStorage, DDL нет. Заполненная звезда не светится.
 */
function FavoriteStar({ org, repo, doneKey, loggedIn }: { org: string; repo: string; doneKey: string | null; loggedIn: boolean }) {
  const [state, setState] = useState<"loading" | "on" | "off" | "anon">("loading");
  const [error, setError] = useState<string | null>(null);
  const [glow, setGlow] = useState(false);
  const probed = useRef(false);
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
    if (!loggedIn) {
      setState("anon");
      return;
    }
    if (probed.current) return;
    probed.current = true;
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
  if (state === "loading") return null;
  const toggle = async () => {
    setError(null);
    if (state === "anon") return; // задизейблена: подсказка в title
    const next = state === "on" ? "off" : "on";
    setState(next);
    try {
      await mutateJson(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, next === "on" ? "PUT" : "DELETE");
    } catch (e) {
      setState(state); // откат — звезда не врёт
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Flex direction="column" gap={1}>
      <Button
        size="m"
        view="flat"
        className={glow ? "rh-star-glow" : undefined}
        disabled={state === "anon"}
        title={state === "anon" ? "Войдите через Я ID, чтобы добавлять в избранное" : "в избранное: права проверятся в кабинете"}
        onClick={() => void toggle()}
      >
        {state === "on" ? "★" : "☆"}
      </Button>
      {error && <Text color="danger">{error}</Text>}
    </Flex>
  );
}
