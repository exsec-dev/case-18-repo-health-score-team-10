// RepoPage.tsx — единая карточка репозитория (план §5 В3 + К2 В4.1):
// HealthCraft Index и полный Repo Health Score (В4.3), шесть категорий с
// раскрытием submetrics, маркеры и рекомендации с доказательствами. Состав ответа
// собирает сервер по доступу зрителя: закрытые ему блоки CI/Security
// приходят без чисел и показываются заглушкой по причине доступа.
// Главное правило экрана — трекер-закон в UI: ни одной фразы без факта
// либо без честного объяснения, почему факта нет.
// Раскладка как у страницы репозитория SourceCraft: действия в ActionBar,
// содержимое во вкладках, итоговая оценка — в правой панели.
import {
  ArrowDownToLine,
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
  ACCESS_LOCK_SHORT,
  CATEGORY_TITLES_RU,
  NO_DATA,
  NO_DATA_SHORT,
  NOT_COUNTED,
  NO_SCORE,
  SECURITY_PUBLIC_NOTE,
  accessLockShort,
  analysisOutcome,
  fmtCount,
  fmtCoverage,
  fmtDate,
  fmtDateTime,
  fmtSigned,
  fmtFactValue,
  fmtNumber,
  fmtScore,
  fmtSubmetric,
  gitLimitsText,
  roundFacts,
  scanStatusText,
  scanTriggerText,
  DEFINITION_NAME_WIDTH,
  scoreColor,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  sentence,
  slugOf,
} from "./format";
import { linkProps, navigate, useQueryParam } from "./router";
import { Page, type Crumb } from "./Shell";
import { SLOT_EMPTY } from "./slots";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, RepoAvatar, RepoSlug, ScoreLegend, SkeletonRows } from "./ui";

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
      {/* Доводка 21.09: спиннер живёт в слоте `Button.Icon`, а не голым узлом
          рядом с текстом. Слот сам держит габарит в высоту кнопки и гасит
          паддинг отрицательным полем (`.g-button__icon`); голый `Spin` был
          обычным inline-block и вставал к тексту вплотную — крутящееся кольцо
          налезало на первую букву. */}
      {refresh.phase === "queued" && (
        <Button.Icon side="start">
          <Spin size="xs" />
        </Button.Icon>
      )}
      {refresh.phase === "queued" ? "Анализ в очереди" : "Обновить анализ"}
    </Button>
  );

  if (state.kind === "loading") {
    return (
      // В4.6 (У27): ритм скелетона = ритм содержимого — блок-полоса величины
      // (~150px) и шесть строк категорий по 45px, панель начинается с легенды
      <Page crumbs={crumbs} aside={<SkeletonRows rows={3} height={96} />}>
        <Flex direction="column" gap={3}>
          <SkeletonRows rows={1} height={150} />
          <SkeletonRows rows={6} height={45} />
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
          title={`Не удалось открыть ${slugOf(org, repo)}`}
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
      {card.score !== null && <ReportMenu mdHref={reportHref} pdfHref={`${cardUrl}/report.pdf`} pdfName={`${org}-${repo}-health.pdf`} />}
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
      {card.score !== null && <ScoreBand card={card} />}
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
              (jobStalled ? " Затянулось – смотрите панель заданий в разделе «Мои репозитории»." : "")
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
                      { text: card.scan ? "Добавьте токен в Настройках – и запустите анализ" : "Добавьте токен в Настройках – и запустите первый анализ", view: "action", size: "l", href: "/settings" },
                    ]
                  : undefined
            }
          />
        )
      ) : (
        <Flex direction="column" gap={4}>
          <Markers card={card} />
          <CardTabs card={card} meta={meta} />
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
function ReportMenu({ mdHref, pdfHref, pdfName }: { mdHref: string; pdfHref: string; pdfName: string }) {
  const toaster = useToaster();
  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async (): Promise<void> => {
    setPdfBusy(true);
    try {
      const res = await fetch(pdfHref);
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("application/pdf")) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `сервер ответил HTTP ${res.status}`);
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = pdfName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toaster.add({
        name: `report-pdf-failed:${pdfHref}`,
        theme: "danger",
        title: "PDF не скачан",
        content: `${e instanceof Error ? e.message : String(e)} Markdown-выгрузка работает – она в этом же меню.`,
      });
    } finally {
      setPdfBusy(false);
    }
  };
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
        { text: pdfBusy ? "PDF (.pdf) – готовим…" : "PDF (.pdf)", iconStart: <Icon data={FileText} size={16} />, disabled: pdfBusy, action: () => void downloadPdf() },
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
              content: "Сбор данных не удался – подробности в «Моих заданиях» раздела «Мои репозитории».",
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
            {/* В4.6 (У27): тот же компонент слага, что в строке рейтинга */}
            <RepoSlug org={r.org} repo={r.repo} variant="header-1" />
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
          {/* Реквизиты остаются в шапке (решение владельца 21.09 — перенос в
              панель отменён). Изменения к прежнему виду два: у языка иконки
              НЕТ (цветная точка сама его и обозначает), а дата снова названа
              словом «обновлен» — иконка часов без слова читалась как время
              скана, а не как активность репозитория. */}
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
              обновлен {fmtDate(r.lastActivityAt)}
            </MetaItem>
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
    // В4.6 круг 2 (Р16, замечание владельца 16): табы и коллапс-блоки обёрнуты
    // в контейнер с границами — тот же `Card view="outlined"`, что у блока
    // величины сверху. До этого верх карточки имел рамку, а список категорий
    // висел в воздухе: два одинаковых по весу блока читались по-разному.
    <Card view="outlined" className="rh-tabs-card">
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
    </Card>
  );
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
  "Публичная оценка по 4 категориям: документация, активность, issues и состояние кода. " +
  "Считается для всех открытых репозиториев и является основой общего рейтинга";

const FULL_HELP =
  "Рассчитывается по 6 категориям: 4 категориям HealthCraft Index, а также CI/CD и Security. " +
  "Показатель доступен только для репозиториев, к которым у вас есть доступ";

/** Короткая причина закрытия полного итога: первый закрытый канал (CI, затем Security). */
function fullLockShortReason(card: Card): string {
  return accessLockShort(card.access.cicd) ?? accessLockShort(card.access.appsec) ?? ACCESS_LOCK_SHORT["check-failed"];
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
      {score && <ScoreLegend coverageNullBelow={meta?.coverageNullBelow} />}

      {score && (
        <AsideSection title="Что учитывается">
          {/* В4.6 (У24): семистрочный абзац был набран вариантом для
              однострочных подписей. П1 дал body-2, П2.12 уменьшил его до
              body-1 13/18; complementary сохраняет контраст прозы. */}
          <Text as="p" variant="body-1" color="complementary">
            HealthCraft Index рассчитывается по 4 категориям на основе публичных данных. Категории CI/CD и Security учитываются
            только в Repo Health Score, доступном участникам репозитория.
            {meta ? ` При покрытии ниже ${threshold} соответствующий показатель не рассчитывается.` : ""}
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
      <AsideSection title="Параметры расчета">
        {scan ? (
          <DefinitionList nameMaxWidth={DEFINITION_NAME_WIDTH}>
            <DefinitionList.Item name="Завершен">{fmtDateTime(scan.finishedAt ?? scan.startedAt)}</DefinitionList.Item>
            <DefinitionList.Item name="Статус">
              <Label theme={scan.status === "ok" ? "success" : scan.status === "bad" ? "danger" : "warning"} size="xs">
                {sentence(scanStatusText(scan.status))}
              </Label>
            </DefinitionList.Item>
            <DefinitionList.Item name="Запуск">{scanTriggerText(scan.trigger)}</DefinitionList.Item>
            <DefinitionList.Item name="Номер">#{scan.id}</DefinitionList.Item>
            {/* В4.6 круг 2 (Р17, замечание владельца 17): версия модели —
                с фоном-выделением, как тот же реквизит в панели рейтинга
                (`Rating.tsx`, Label theme="normal" size="xs"): это код, а не
                проза, и читается он как код только в плашке. */}
            {score && (
              <DefinitionList.Item name="Модель">
                <Label theme="normal" size="xs">
                  {score.modelVersion}
                </Label>
              </DefinitionList.Item>
            )}
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
function ScoreBand({ card }: { card: Card }) {
  const score = card.score!;
  return (
    <Card view="outlined" className="rh-score-band">
      <Flex direction="column" gap={3}>
        <Flex gap={6} wrap>
          <ScoreFigure
            title="HealthCraft Index"
            help={INDEX_HELP}
            total={score.healthcraftIndex}
            coverage={score.indexCoverage}
            rank={score.rank}
            rankedTotal={score.rankedTotal}
            withBar
          />
          {score.fullLocked ? (
            <Flex direction="column" gap={1} style={{ flex: "1 1 240px", minWidth: 0 }}>
              <Flex gap={1} alignItems="center">
                <Text color="secondary">Repo Health Score</Text>
                {/* В4.6 круг 2 (Р13): в ЗАКРЫТОЙ ветке подсказки не было вовсе —
                    а именно здесь зритель и спрашивает, чем полный показатель
                    отличается от публичного. Теперь подсказка есть у обоих. */}
                <HelpMark iconSize="s" aria-label="Что такое «Repo Health Score»">
                  {FULL_HELP}
                </HelpMark>
              </Flex>
              {/* Закрытый показатель НЕ схлопывается в метку — это приём самой
                  платформы: у репозитория без рейтинга карточка `scoring-card`
                  держит свой габарит и наполняется приглашением («Rate this
                  repository» 15/20 500 + объяснение 13/18 приглушённым + сами
                  реакции нулями), а не исчезает. Здесь то же: заголовок говорит,
                  кому показатель виден, строка под ним — ПОЧЕМУ он закрыт именно
                  у этого зрителя, ссылка — что с этим сделать.
                  Причина берётся короткой формой (`ACCESS_LOCK_SHORT`): полная
                  несёт ещё и призыв, который здесь уже сказан ссылкой.
                  Пара по высоте сходится с левым показателем без распорок:
                  три строки против «число + полоса + покрытие». */}
              <Text variant="subheader-2">Виден участникам репозитория</Text>
              <Text variant="body-1" color="complementary">
                {fullLockShortReason(card)}
              </Text>
              <Text variant="body-1">
                <Link {...linkProps("/settings")}>Добавить токен доступа</Link>
              </Text>
            </Flex>
          ) : (
            <ScoreFigure
              title="Repo Health Score"
              help={FULL_HELP}
              total={score.repoHealthScore}
              coverage={score.repoHealthCoverage ?? 0}
              withBar
            />
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
  rank,
  rankedTotal,
  withBar = false,
}: {
  title: string;
  help: string;
  total: number | null;
  coverage: number;
  rank?: number | null;
  rankedTotal?: number | null;
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
        <Label theme="unknown" size="s">
          {NO_SCORE}
        </Label>
      ) : (
        <Flex gap={2} alignItems="baseline" wrap className="rh-score-figure__value">
          <Text variant="display-2">{fmtScore(total)}</Text>
          <Text color="secondary">из 100</Text>
          {/* В4.6 (У22): шкала вплотную к числу — иначе «83» не с чем сравнить.
              Круг 2 (Р12): размер чипа приведён к чипам правой панели
              (`size="s"`, легенда `ScoreLegend`) — у плашки «Здоров» были
              паддинги на шаг крупнее, и рядом с легендой это читалось как две
              разные сущности. Тема чипа не менялась. */}
          <Label theme={scoreLabelTheme(total)} size="s">
            {sentence(scoreWord(total))}
          </Label>
          {/* Доводка 21.09: место в рейтинге — не плашка, а серый текст на
              полступени жирнее соседей: оценку несёт цветной чип, позиция
              рядом с ним справка. Прижат к правому краю ПОЛОСЫ (та же мера
              360px), поэтому строка значения и полоса под ней заканчиваются
              на одной вертикали. */}
          {rank !== null && rank !== undefined && rankedTotal ? (
            <Text color="secondary" className="rh-score-figure__rank" title="Место в публичном рейтинге по HealthCraft Index">
              #{fmtCount(rank)} из {fmtCount(rankedTotal)}
            </Text>
          ) : null}
        </Flex>
      )}
      {/* В4.6 (У21): полоса измеряет САМ показатель, а не покрытие; мера 360px
          из варианта А — иначе на 1920 она превращается в декоративную линию */}
      {withBar && total !== null && (
        <div style={{ maxWidth: 360 }}>
          <Progress value={Math.round(total)} size="s" theme={scoreTheme(total)} />
        </div>
      )}
      {/* покрытие — строкой, без своей полосы (находка Z5 дизайн-пары).
          Круг 2 (Р12): «данных хватило: N%» → «Покрытие: N%» — прежняя фраза
          звучала как вердикт («хватило»), хотя это измеренная доля. */}
      <Text variant="body-short" color="secondary" style={{ marginBlockStart: 2 }}>
        Покрытие: {fmtCoverage(coverage)}
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

  /**
   * В4.6 круг 2 (Р14, замечание владельца 14): закрытые зрителю категории
   * больше НЕ занимают по строке каждая. Владелец прошла по живому интерфейсу:
   * два блока с замком и без чисел давали половину списка визуального шума.
   * Сведения при этом обязаны остаться (закон 2 и ТЗ §3.4 «сведения об
   * отсутствии данных») — они собраны в ОДНУ строку под Code health, и строка
   * называет ИМЕННО закрытые категории с их конкретной причиной.
   */
  const shown = entries.filter(([, cat]) => cat.locked === undefined);
  const locked = entries
    .filter(([, cat]) => cat.locked !== undefined)
    .map(([key, cat]) => ({ title: titleOf(key), reason: accessLockShort(cat.locked) ?? ACCESS_LOCK_SHORT["check-failed"] }));

  return (
    <>
      <ul className="rh-list" style={{ borderTop: 0 }}>
        {shown.map(([key, cat]) => (
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
      {locked.length > 0 && <LockedCategories items={locked} />}
    </>
  );
}

/**
 * Строка о недоступных категориях — ПОСЛЕДНЕЙ, под Code health (уточнение
 * владельца: не вверху).
 *
 * Фиксированная ветка под пару CI/CD+Security без PAT (П2.11) снята вместе со
 * своей ссылкой: переход к токену теперь стоит ОДИН раз — у самого показателя,
 * где зритель и упирается в закрытое число (решение владельца 21.09). Здесь
 * остаётся констатация и короткая причина, поэтому одна группировка на все
 * случаи — и на пару, и на одну категорию (см. tests/api.test.ts, ветка
 * «только CI», где фиксированная пара была бы ложью).
 */
function LockedCategories({ items }: { items: { title: string; reason: string }[] }) {
  const groups = new Map<string, string[]>();
  for (const item of items) groups.set(item.reason, [...(groups.get(item.reason) ?? []), item.title]);
  const sentences = [...groups].map(
    ([reason, titles]) =>
      `${titles.length > 1 ? "Категории" : "Категория"} ${titles.join(" и ")} ${titles.length > 1 ? "недоступны" : "недоступна"}. ${reason}`,
  );

  return <Alert theme="info" view="outlined" size="s" className="rh-locked-note" message={sentences.join(" ")} />;
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

  /**
   * В4.6 круг 2 (Р14): ветки закрытого канала здесь больше нет — закрытые
   * категории до строки не доходят (`Categories` их отфильтровывает и
   * собирает в одну строку под списком). Осталось tri-state: «нет данных» с
   * причиной и оговоркой про перенормировку.
   */
  const note =
    cat.score === null
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
      <span className="rh-category__tags">
        {cat.stale && (
          <Label theme="warning" size="xs">
            Факты из истории
          </Label>
        )}
      </span>
      <span className="rh-category__bar">
        {cat.score === null ? (
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
          опровергал собственный tri-state. Поэтому там стоит `NOT_COUNTED`.
          Круг 2 (Р14): вместо строки «вес N% → вклад M%» — ОДНА плашка в стиле
          чипа величины (`theme="normal"`), последней в сетке строки, то есть
          прижатой к правому краю. Номинальный вес не потерян: он в подсказке
          по наведению — на экране остаётся то, что зритель спрашивает
          («сколько эта категория дала»), а не то, из чего это выведено. */}
      <Label
        theme="normal"
        size="xs"
        className="rh-category__weight"
        title={`номинальный вес категории в Repo Health Score – ${cat.weight}% → вклад после перенормировки`}
      >
        {cat.score === null ? NOT_COUNTED : `Вклад ${contribution}%`}
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
      {note && (
        <div style={{ padding: "0 var(--g-spacing-3) var(--g-spacing-3) calc(16px + var(--g-spacing-6))", marginTop: "calc(-1 * var(--g-spacing-1))" }}>
          <Text variant="body-2" color="complementary">
            {note}
          </Text>
        </div>
      )}
      {/* В4.6 (У17): разбивка по движкам живёт под строкой Security — рядом с
          числом, которое она объясняет, и только когда факт есть и он ok */}
      {key === "security" && <AppsecEngines card={card} />}
      {open && (
        <div className="rh-subrows">
          {/* Доводка 21.09: шапка подписывает ТОЛЬКО числовые колонки — над
              именем метрики подпись не нужна, там и так имя. Подписи 11px
              приглушённые, без линии под ними (вариант B). Колонки общие со
              строками: сетка живёт на `.rh-subrows`, строки раскрываются в
              неё через `display: contents`, иначе у каждой строки был бы свой
              `auto` и подпись не встала бы над значениями. */}
          <div className="rh-subrows__head">
            <span>Значение</span>
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
                {/* В4.6 круг 2 (Р20): доля округляется до 2 знаков
                    (`roundFacts`), целое остаётся как есть — «0.87234042553»
                    на первом экране карточки было шумом, а не фактом. Поповер
                    «Основание» ниже печатает значение СЫРЫМ: это
                    доказательная база.
                    Доводка 21.09: слово «значение» из строки убрано — оно
                    повторялось в каждой из девяти строк; полная форма
                    осталась в подсказке. */}
                <Text
                  color="secondary"
                  className="rh-subrow__value"
                  title={`значение: ${fmtFactValue(roundFacts(sub.value))}${sub.note ? ` (${sub.note})` : ""}`}
                >
                  {fmtFactValue(roundFacts(sub.value))}
                  {sub.note ? ` (${sub.note})` : ""}
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

// ---------- маркеры расчёта ----------

/**
 * Маркеры расчёта (В4.6, З4 систематика): у них ДВА разных смысла, а рисовались
 * они одним жёлтым. Теперь `info` — граница данных (что источники смогли
 * отдать: лимит клона, усечённая история, пустой репозиторий), `warning` —
 * оговорка о самом расчёте (факты из истории, потолок CI без прогонов).
 * Порядок стопки: сначала оговорки, потом границы данных — оговорка меняет
 * чтение чисел, а граница объясняет их происхождение.
 */
function Markers({ card }: { card: Card }) {
  const m = card.markers;
  const rows: { key: string; label: string; text: string; theme: "info" | "warning" }[] = [];
  if (m.staleFacts) {
    rows.push({
      key: "stale",
      label: "Факты из истории",
      text: "Часть источников ответила сбоем канала, поэтому в расчет пошли последние успешные факты предыдущих сканов. Сбой трубы – не отсутствие данных, и он не превращается в премию или штраф.",
      theme: "warning",
    });
  }
  if (m.gitLimits) {
    rows.push({ key: "git-limits", label: "Репозиторий больше лимита сервиса", text: gitLimitsText(m.gitLimits), theme: "info" });
  }
  // Ф2.9 (LOW-9): маркер codeEmpty API отдаёт, но карточка молчала — зритель
  // видел Score 0 без объяснения, хотя это данные о проекте (Q&A №13)
  if (m.codeEmpty) {
    rows.push({
      key: "code-empty",
      label: "В репозитории нет кода",
      text: "В репозитории нет ни одного файла, поэтому по методике Score равен 0 – это данные о проекте («проекта нет»), а не отсутствие оценки или сбой сбора.",
      theme: "info",
    });
  }
  if (m.historyTruncatedSince) {
    rows.push({
      key: "truncated",
      label: "История усечена",
      text: `Репозиторий слишком велик для полного клона, сработал деградационный ярус: git-история видна с ${fmtDate(m.historyTruncatedSince)}. Метрики активности и возраста TODO посчитаны по видимой части.`,
      theme: "info",
    });
  }
  if (m.ciConfigOnlyCap) {
    rows.push({
      key: "ci-cap",
      label: "CI заявлен, прогоны недоступны",
      text: "Конфигурация CI в репозитории есть, но статусы прогонов закрыты правами (403 для чужих репозиториев). Заявленный CI дает максимум 50 из 100 – доказательства дают прогоны.",
      theme: "warning",
    });
  }
  if (rows.length === 0) return null;

  return (
    <Flex direction="column" gap={2} role="region" aria-label="Особенности расчета">
      {/* У27: один способ применения Alert вне кабинета — сбой страницы идёт
          размером по умолчанию, встроенная заметка `size="s"`; `view` всегда
          outlined, `theme` НЕСЁТ СМЫСЛ и больше не один на все случаи */}
      {[...rows].sort((a, b) => (a.theme === b.theme ? 0 : a.theme === "warning" ? -1 : 1)).map((row) => (
        <Alert key={row.key} theme={row.theme} view="outlined" size="s" title={row.label} message={row.text} />
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
      <ul className="rh-list" style={{ borderTop: 0 }}>
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
          {/* Доводка 21.09: «#1/#2/#3» снят. Он сообщал только позицию в
              списке, которая и так видна сверху вниз, и занимал место слева
              от заголовка — там, где у платформы стоит признак важности.
              Сам признак НЕ введён: `priority` в recommend.ts — это
              `r.priority = i + 1`, порядковый номер после сортировки, а не
              важность. Назвать его «Критический/Высокий» значило бы выдать
              позицию за оценку срочности. */}
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
        {/* Доводка 21.09: «Эффект» печатался рядом с чипом прироста и повторял
            его дословно («+2.3 к HealthCraft Index» чипом и «Эффект: +2.3 к
            HealthCraft Index» строкой). Строка остаётся там, где чипа с
            дельтой нет — у активационных рекомендаций она несёт другое
            («CI/CD: 50 → до 100 по фактическим прогонам»). */}
        {rec.expectedImpact && rec.deltaScore === null && <Text color="complementary">Эффект: {rec.expectedImpact}</Text>}
        <Flex gap={2} wrap alignItems="center">
          {/* В4.6 круг 2 (Р19, замечание владельца 19): «Основано на фактах» →
              «Основание». Прежняя формулировка была оправданием («мы не
              выдумали»), новая называет саму вещь: ниже стоят факты, по клику
              открывается их значение и источник. */}
          <Text variant="body-short" color="secondary">
            Основание:
          </Text>
          {rec.factRefs.map((ref) => (
            <Popover
              key={ref.key}
              trigger="click"
              placement={["bottom-start", "top-start"]}
              content={<FactProof factKey={ref.key} fact={evidence.get(ref.key)} />}
            >
              <Label theme={ref.missing ? "unknown" : "info"} size="xs" interactive>
                <Flex gap={1} alignItems="center">
                  {ref.key}
                  <Icon data={ChevronDown} size={12} />
                </Flex>
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
        Находки AppSec по движкам{breakdown.openFindings !== null ? ` (всего открытых: ${fmtNumber(breakdown.openFindings)})` : ""}:
      </Text>
      <DefinitionList nameMaxWidth={DEFINITION_NAME_WIDTH}>
        {breakdown.engines.map(([name, count]) => (
          <DefinitionList.Item key={name} name={name}>
            {fmtNumber(count)}
          </DefinitionList.Item>
        ))}
        {breakdown.sca && (
          <DefinitionList.Item name={`${breakdown.sca[0]} (зависимости, SCA)`} note="Находки в зависимостях показываются отдельно и в оценку Security не входят: формула категории не менялась.">
            {fmtNumber(breakdown.sca[1])}
          </DefinitionList.Item>
        )}
      </DefinitionList>
      {breakdown.sca === null && (
        <Text variant="body-2" color="complementary">
          Отдельного счетчика SCA платформа по этому скану не вернула – значит показывать его нечем.
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
      await mutateJson(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, next === "on" ? "PUT" : "DELETE");
      // Доводка 21.09: у действия появился отклик. Смена оттенка звезды —
      // единственное, что происходило, и на мелкой иконке её не замечали;
      // тост ещё и называет, КУДА репозиторий попал, — раздел «Мои
      // репозитории» иначе приходится искать самому.
      toaster.add({
        name: `favorite:${org}/${repo}`,
        theme: next === "on" ? "success" : "info",
        title: next === "on" ? "Добавлено в избранное" : "Убрано из избранного",
        content: next === "on" ? `${slugOf(org, repo)} — в разделе «Мои репозитории»` : slugOf(org, repo),
      });
    } catch (e) {
      setState(state); // откат — звезда не врёт
      setError(e instanceof Error ? e.message : String(e));
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
              : "В избранное. Раздел «Мои репозитории» содержит выбранные вами репозитории. Права на закрытые данные проверяются в Настройках."
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
