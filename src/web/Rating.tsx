// Страница рейтинга: здоровье, а не популярность.
// Выборку считает сервер, страница только переводит состояние контролов в
// query-строку и обратно — поэтому отфильтрованным рейтингом можно
// поделиться ссылкой, и F5 его не теряет.
import { coverageLine } from "./ratingParams";
import { loadRatingScroll, rememberRatingHref, saveRatingScroll } from "./ratingReturn";
import { ArrowUpRightFromSquare, BarsAscendingAlignLeft, BarsDescendingAlignLeft, Flag, Gear, Magnifier, SparklesFill, SquareListUl, TriangleDownFill, TriangleUpFill } from "@gravity-ui/icons";
import {
  ActionTooltip,
  Alert,
  Button,
  Checkbox,
  DefinitionList,
  Flex,
  HelpMark,
  Icon,
  Label,
  Link,
  Pagination,
  Progress,
  SegmentedRadioGroup,
  Select,
  type SelectOption,
  Table,
  TableColumnSetup,
  type TableColumnConfig,
  type TableColumnSetupItem,
  Text,
  TextInput,
} from "@gravity-ui/uikit";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SortKey } from "../api/repos";
import type { MetaResponse, RatingResponse } from "./api";
import { useJson } from "./api";
import {
  activeRatingFilters,
  ciOptions,
  firstSortOrder,
  normalizeRatingSearch,
  nothingFoundDescription,
  pageBeyond,
  sizeOptions,
  sizeSummary,
  type FacetOption,
} from "./ratingParams";
import {
  CATEGORY_TITLES_RU,
  DEFINITION_NAME_WIDTH,
  FRAUD_EXPLAIN,
  FRAUD_TITLE,
  NO_DATA_SHORT,
  NO_SCORE,
  fmtCount,
  fmtCoverage,
  fmtDate,
  fmtNumber,
  fmtScore,
  scanStatusText,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  sentence,
} from "./format";
import { readRatingHidden, useMediaQuery, writeRatingHidden } from "./prefs";
import { linkProps, navigate, repoHref } from "./router";
import { Page, showAside, useAsideControl } from "./Shell";
import { categoryColorClass } from "./cardView";
import { AsideSection, EmptyState, LanguageName, MethodLink, PageHeader, RepoAvatar, RepoSlug, ScoreLegend, SkeletonRows, TIP_TARGET } from "./ui";
import { LANG_NONE, LANG_NONE_TITLE, langOptions, type Facets, type LangOptionData } from "./lang-filter";

type Item = RatingResponse["items"][number];

/**
 * Сводка выбранного в поле («Go, Rust +2»): имена идут, пока укладываются в
 * бюджет символов, остальное — «+N». Первое имя показывается всегда.
 * Бюджет измерен на поле шириной 220px: на текст остается ~117px, это ~18
 * знаков Inter 13px, из них 3-4 уходят на «+N».
 */
const LANG_SUMMARY_CHARS = 13;

const langTitle = (value: string): string => (value === LANG_NONE ? LANG_NONE_TITLE : value);

/** Сколько первых выбранных языков назвать по имени до «+N». */
function langSummaryNames(values: string[]): number {
  let used = 0;
  let shown = 0;
  for (const value of values) {
    const cost = langTitle(value).length + (shown > 0 ? 2 : 0);
    if (shown > 0 && used + cost > LANG_SUMMARY_CHARS) break;
    used += cost;
    shown++;
  }
  return shown;
}

/**
 * CI/CD и Security в публичный рейтинг не входят: API отдаёт их в строке
 * всегда null (данные каналов с правами не публикуются), поэтому в таблице
 * рейтинга этих колонок нет — они видны на карточке участникам репозитория.
 */
const NOT_IN_RATING = new Set(["cicd", "security"]);

/**
 * Категории на случай, когда /api/meta недоступен: имена из клиентских
 * констант в порядке `CATEGORY_ORDER` сервера. Веса неизвестны — колонки
 * рисуются, а панель методики весов не показывает.
 */
const FALLBACK_CATEGORIES: MetaResponse["categories"] = ["documentation", "cicd", "security", "activity", "issues", "code"].map((key) => ({
  key: key as MetaResponse["categories"][number]["key"],
  title: CATEGORY_TITLES_RU[key] ?? key,
  indexWeight: null,
  scoreWeight: 0,
}));

/**
 * Подписи колонок для списка «Колонки» — те же, что в шапке таблицы.
 * Категорийные колонки сюда не входят: их имена приходят из /api/meta.
 * В шапке место обозначено «#», но в списке знак ничего не называет —
 * там колонка зовется «Позиция».
 */
const COLUMN_TITLES: Record<string, string> = {
  rank: "Позиция",
  repo: "Репозиторий",
  index: "HealthCraft Index",
  lang: "Язык",
  likes: "Реакции",
  forks: "Ответвления",
  activity: "Обновлен",
  coverage: "Покрытие",
  scanned: "Анализ",
};

/**
 * «Реакции» и «Последняя активность» видны по умолчанию — узкими колонками
 * вторичным цветом. Рейтинг не про популярность (реакции в индекс не входят),
 * но прятать ее незачем: зритель видит популярность рядом и может сам
 * отсортировать по ней.
 */
const HIDDEN_BY_DEFAULT = ["lang", "forks", "coverage", "scanned"];

export function Rating({ search: rawSearch, meta, metaFailed = false }: { search: string; meta: MetaResponse | null; metaFailed?: boolean }) {
  // неверные sort/order/per_page/page из старой ссылки заменяются дефолтом,
  // адрес исправляется — сервер не получает заведомый 400
  const normalized = useMemo(() => normalizeRatingSearch(rawSearch), [rawSearch]);
  const search = normalized.search;
  useEffect(() => {
    if (normalized.changed) navigate(search === "" ? "/" : `/?${search}`, { replace: true });
  }, [normalized.changed, search]);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  // view — только режим показа страницы, серверу он не нужен
  const apiSearch = useMemo(() => {
    const p = new URLSearchParams(search);
    p.delete("view");
    return p.toString();
  }, [search]);
  // при смене фильтра, сортировки или страницы прежняя выдача остается на
  // экране приглушенной, пока не придет новая, — без скелетона, скачка
  // ширины вкладок и пропадающей пагинации
  const { state, reload } = useJson<RatingResponse>(`/api/repos${apiSearch ? `?${apiSearch}` : ""}`, { keepPrevious: true });
  // адрес выдачи запоминается для крошки «Рейтинг» на карточке, прокрутка
  // таблицы (или списка на телефоне) — при уходе; она возвращается, когда
  // выдача с тем же адресом снова на экране
  useEffect(() => rememberRatingHref(search), [search]);
  const restoredFor = useRef<string | null>(null);
  const scroller = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(".rh-table-fill .g-table__scroll-container") ?? document.querySelector<HTMLElement>(".rh-fill__content");
  // слушатель переподключается на смену адреса и появление контейнера, а не на
  // каждую перерисовку; восстановление — только когда на экране данные НОВОЙ
  // выдачи (при «назад» внутри рейтинга `useJson` еще показывает прежние строки)
  const hasData = state.kind === "ok";
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    const save = () => saveRatingScroll(search, el.scrollTop);
    el.addEventListener("scroll", save, { passive: true });
    return () => el.removeEventListener("scroll", save);
  }, [search, hasData]);
  const seenSearch = useRef<string | null>(null);
  const dataAtSearch = useRef<unknown>(null);
  useLayoutEffect(() => {
    if (seenSearch.current !== search) {
      seenSearch.current = search;
      dataAtSearch.current = state.kind === "ok" ? state.data : null;
    }
    if (state.kind !== "ok" || state.data === dataAtSearch.current || restoredFor.current === search) return;
    restoredFor.current = search;
    const top = loadRatingScroll(search);
    const el = scroller();
    if (el && top > 0) el.scrollTop = top;
  }, [state, search]);

  const sort = params.get("sort") ?? "index";
  const order = params.get("order") ?? "desc";
  const view = params.get("view") === "unscored" ? "unscored" : "scored";
  // `lang` повторяемый; старая ссылка с одним языком — набор из одного
  const langValues = params.getAll("lang").map((v) => (v === "" ? LANG_NONE : v));
  const qParam = params.get("q") ?? "";
  const aiOnly = params.get("ai") === "1";
  // размер повторяемый; пустое состояние называет все включенные фильтры
  const sizeValues = params.getAll("size");
  const ciValue = params.get("ci");
  const activeFilters = activeRatingFilters(search);
  const hasFilters = activeFilters.length > 0;
  // на телефоне таблица категорий не помещается — строки списком: место, имя, Score
  const isPhone = useMediaQuery("(max-width: 767px)");

  const [queryDraft, setQueryDraft] = useState(qParam);
  // внешняя смена URL (назад/вперёд, сброс) обязана вернуться в поле ввода
  useEffect(() => setQueryDraft(qParam), [qParam]);
  useEffect(() => {
    if (queryDraft === qParam) return;
    // правка строки поиска не должна засорять историю: replace, с паузой
    const timer = setTimeout(() => setParams({ q: queryDraft === "" ? null : queryDraft }, { replace: true }), 300);
    return () => clearTimeout(timer);
  }, [queryDraft, qParam]);

  // выбор колонок хранится в localStorage и переживает перезагрузку
  const [hidden, setHiddenState] = useState<string[]>(() => readRatingHidden(HIDDEN_BY_DEFAULT));
  const setHidden = (next: string[]): void => {
    setHiddenState(next);
    writeRatingHidden(next);
  };

  function setParams(patch: Record<string, string | string[] | null>, opts: { replace?: boolean; keepPage?: boolean } = {}): void {
    // база — ТЕКУЩИЙ адрес, а не снимок рендера: иначе отложенный таймер
    // поиска откатывает выбранные за 300 мс язык, сортировку или страницу
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      // массив — повторяемый параметр (`lang`, `size`): каждое значение отдельно
      if (Array.isArray(value)) for (const v of value) next.append(key, v);
      else if (value !== null) next.set(key, value);
    }
    // смена фильтра или сортировки сбрасывает страницу: иначе пользователь
    // попадает на пустую пятую страницу трёх результатов
    if (!opts.keepPage) next.delete("page");
    const qs = next.toString();
    navigate(qs === "" ? "/" : `/?${qs}`, { replace: opts.replace });
  }

  const data = state.kind === "ok" ? state.data : state.kind === "loading" ? (state.stale ?? null) : null;
  const refreshing = state.kind === "loading" && state.stale !== undefined;
  // страница за пределами выдачи (старая ссылка `?page=5` при трех
  // результатах) заменяется последней существующей, а не «Рейтинг еще пуст»
  const lastPage = state.kind === "ok" ? pageBeyond(state.data) : null;
  useEffect(() => {
    if (lastPage !== null) setParams({ page: lastPage === 1 ? null : String(lastPage) }, { replace: true, keepPage: true });
    // setParams читает текущий адрес — в зависимостях не нужен
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPage]);
  // пока грузится новый набор, список языков строится из фасетов последнего
  // успешного ответа — иначе на время загрузки пропадают все опции, кроме
  // выбранных, а у тех — цвет и счетчик. Фасеты от языкового фильтра не
  // зависят, поэтому прежние верны и для нового набора.
  const lastFacets = useRef<Facets>([]);
  if (data) lastFacets.current = data.facets.languages;
  // счетчики размера и CI — так же из последнего ответа (от фильтров не зависят)
  const lastFilterFacets = useRef<RatingResponse["facets"] | null>(null);
  if (data) lastFilterFacets.current = data.facets;
  // без /api/meta — имена из клиентских констант, а не ключи
  const categoryNames: Record<string, string> = useMemo(
    () => Object.fromEntries((meta?.categories ?? []).map((c) => [c.key, c.title])),
    [meta],
  );
  const titleOf = (key: string): string => categoryNames[key] ?? CATEGORY_TITLES_RU[key] ?? key;
  const categories = useMemo(() => (meta?.categories ?? FALLBACK_CATEGORIES).filter((c) => !NOT_IN_RATING.has(c.key)), [meta]);
  const onSort = (key: SortKey, next: "asc" | "desc"): void => setParams({ sort: key, order: next });
  const allColumns = useMemo(
    () => buildColumns(categories, { sort, order, onSort }),
    // `onSort` пересоздаётся каждый рендер (замыкает setParams) и в список
    // зависимостей не идёт намеренно: колонки перестраивает смена самой
    // сортировки, а не идентичность обработчика
    [categories, sort, order],
  );
  // у сортируемых колонок `name` — функция-заголовок, из нее подпись не
  // вывести (в списке оказался бы технический id), поэтому — из словаря
  const setupItems: TableColumnSetupItem[] = allColumns.map((c) => ({
    id: c.id,
    title: COLUMN_TITLES[c.id] ?? (typeof c.name === "string" ? c.name : c.id),
    selected: !hidden.includes(c.id),
    required: c.id === "rank" || c.id === "repo" || c.id === "index",
  }));
  const columns = allColumns.filter((c) => !hidden.includes(c.id));

  const toolbar = (
    <Flex direction="column" gap={3} style={{ marginBottom: "var(--g-spacing-3)" }}>
      <Flex gap={2} wrap alignItems="center">
        {/* flex-обертка: в блочной поле получалось 27.3px против 28px у соседних
            Select. Основа 160px держит тулбар в одну строку на экранах от 1366,
            поле растягивается на остаток */}
        <div style={{ flex: "1 1 160px", minWidth: 160, display: "flex" }}>
          {/* Плейсхолдер называет действие, перечень полей — в подсказке. Поиск
              идет подстрокой по org, repo и названию (`repos.ts`, matchesQ) —
              подсказка не обещает большего. Отступ справа у лупы — иначе
              «Поиск» слипается с иконкой. */}
          <TextInput
            size="m"
            placeholder="Поиск"
            value={queryDraft}
            onUpdate={setQueryDraft}
            hasClear
            startContent={
              <Icon
                data={Magnifier}
                size={14}
                style={{
                  marginInlineStart: "var(--g-spacing-2)",
                  marginInlineEnd: "var(--g-spacing-2)",
                  color: "var(--g-color-text-secondary)",
                }}
              />
            }
            endContent={
              <HelpMark iconSize="s" aria-label="По каким полям идет поиск" style={{ marginInlineEnd: "var(--g-spacing-2)" }}>
                Поиск по владельцу, репозиторию и заголовку
              </HelpMark>
            }
            controlProps={{ "aria-label": "Поиск по репозиториям" }}
          />
        </div>
        {/* Мультивыбор языка: чекбокс — неинтерактивный `Checkbox` в
            `renderOption` (штатная галочка `multiple` скрыта стилем попапа).
            Виртуализация выключена порогом: у виртуального списка своя
            высота, и CSS-ограничение высоты со скроллом на нем не работает. */}
        <Select
          label="Язык:"
          size="m"
          width={150}
          multiple
          hasClear
          placeholder="все"
          popupClassName="rh-lang-popup"
          virtualizationThreshold={1000}
          value={langValues}
          options={langOptions(lastFacets.current, langValues)}
          renderOption={(option) => <LangOption option={option} checked={langValues.includes(option.value)} />}
          renderSelectedOption={(option, index) => <LangSummaryPart value={option.value} index={index} values={langValues} />}
          onUpdate={(v) => setParams({ lang: v.length === 0 ? null : v.map((x) => (x === LANG_NONE ? "" : x)) })}
        />
        {/* Размер по строкам кода и наличие CI. Счетчики — из фасетов
            (по поиску, без фильтров); репо без данных о размере или CI не
            попадает ни в одно значение. */}
        <Select
          label="Размер:"
          size="m"
          width={150}
          multiple
          hasClear
          placeholder="любой"
          popupClassName="rh-lang-popup"
          value={sizeValues}
          options={sizeOptions(lastFilterFacets.current).map(facetSelectOption)}
          renderOption={(option) => <FilterOption option={option} checkbox checked={sizeValues.includes(option.value)} />}
          renderSelectedOption={(option, index) => <>{index === 0 ? sizeSummary(sizeValues) : ""}</>}
          onUpdate={(v) => setParams({ size: v.length === 0 ? null : v })}
        />
        <Select
          label="CI:"
          size="m"
          width={110}
          hasClear
          placeholder="все"
          value={ciValue === null ? [] : [ciValue]}
          options={ciOptions(lastFilterFacets.current).map(facetSelectOption)}
          renderOption={(option) => <FilterOption option={option} />}
          onUpdate={(v) => setParams({ ci: v[0] ?? null })}
        />
        <SegmentedRadioGroup
          size="m"
          value={view}
          onUpdate={(v) => setParams({ view: v === "unscored" ? "unscored" : null }, { keepPage: v === "scored" })}
          aria-label="Какие репозитории показать"
          className="rh-view-tabs"
        >
          <SegmentedRadioGroup.Option value="scored">Оценены{data ? ` ${fmtCount(data.total)}` : ""}</SegmentedRadioGroup.Option>
          <SegmentedRadioGroup.Option value="unscored">Без оценки{data ? ` ${fmtCount(data.nulls)}` : ""}</SegmentedRadioGroup.Option>
        </SegmentedRadioGroup>
        {/* фильтр «С AI-обзором» — путь к обзорам с первого экрана; кнопки нет,
            пока таких репо 0 (и фильтр не включен) */}
        {view === "scored" && data && (data.aiCount > 0 || aiOnly) && (
          <Button view="outlined" size="m" selected={aiOnly} onClick={() => setParams({ ai: aiOnly ? null : "1" })}>
            <Button.Icon side="start">
              <Icon data={SparklesFill} size={16} className="rh-ai-mark-icon" />
            </Button.Icon>
            {`С AI-обзором ${fmtCount(data.aiCount)}`}
          </Button>
        )}
        {/* настройка колонок — последней: в «Без оценки» ее нет, и стоявшая перед
            сегментами кнопка сдвигала их на 157px из-под курсора */}
        {view === "scored" && !isPhone && (
          <TableColumnSetup
            items={setupItems}
            showStatus
            onUpdate={(updated) => setHidden(updated.filter((i) => !i.selected).map((i) => i.id))}
            /* переключатель — иконкой, счетчик колонок — в подсказке:
               место в строке тулбара отдано фильтрам */
            renderSwitcher={({ onClick, onKeyDown }) => {
              const shown = setupItems.filter((i) => i.selected !== false).length;
              const label = `Колонки: ${shown} из ${setupItems.length}`;
              return (
                <ActionTooltip title={label}>
                  <Button view="outlined" size="m" onClick={onClick} onKeyDown={onKeyDown} aria-label={label}>
                    <Icon data={Gear} size={16} />
                  </Button>
                </ActionTooltip>
              );
            }}
          />
        )}
      </Flex>
    </Flex>
  );

  return (
    <Page
      mode="fill"
      // панель колонкой — только с 1600, чтобы на 1440 таблице хватило
      // ширины на «Реакции» и «Обновлен»
      asideColumnFrom={1600}
      crumbs={[{ text: "Рейтинг" }]}
      aside={<RatingAside meta={meta} metaFailed={metaFailed} generatedAt={data?.generatedAt ?? null} />}
      header={
        <>
          <PageHeader title="Рейтинг здоровья открытых репозиториев" description={ratingLead(meta)} />
          {toolbar}
        </>
      }
      footer={
        data && view === "scored" && data.total > data.perPage ? (
          <Pagination
            className="rh-pager"
            page={data.page}
            pageSize={data.perPage}
            total={data.total}
            // 20 — размер по умолчанию, без этой опции к нему не вернуться
            pageSizeOptions={isPhone ? undefined : [10, 20, 50, 100]}
            // поле номера страницы: Enter или уход фокуса — переход,
            // номер больше последнего — последняя страница
            showInput
            onUpdate={(page, pageSize) => setParams({ page: String(page), per_page: String(pageSize) }, { keepPage: true })}
          />
        ) : undefined
      }
    >
      {/* скелетон — только при первой загрузке, высотой как строка таблицы
          (56px), чтобы раскладка не прыгала; при обновлении — полоса сверху */}
      {state.kind === "loading" && !refreshing && <SkeletonRows rows={10} height={56} />}
      <div className={refreshing ? "rh-refresh-bar rh-refresh-bar_on" : "rh-refresh-bar"} role="progressbar" aria-hidden={!refreshing} aria-label="Обновляем рейтинг" />

      {/* перечитывание не удалось — строки прежние, и это надо показать:
          иначе новая сортировка подсвечена над старыми строками */}
      {state.kind === "ok" && state.refreshError && (
        <Alert
          theme="warning"
          view="outlined"
          size="s"
          message={`Данные могли устареть: обновить рейтинг не удалось – ${state.refreshError}`}
          actions={[{ text: "Повторить", handler: reload }]}
        />
      )}
      {state.kind === "error" && (
        <Alert
          theme="danger"
          view="outlined"
          title="Не удалось загрузить рейтинг"
          message={state.message}
          actions={[{ text: "Повторить", handler: reload }]}
        />
      )}

      {data &&
        view === "scored" &&
        (data.items.length === 0 ? (
          <NothingFound active={activeFilters} />
        ) : isPhone ? (
          <PhoneList items={data.items} refreshing={refreshing} />
        ) : (
          <Table
            className={refreshing ? "rh-table-fill rh-refreshing" : "rh-table-fill"}
            data={data.items}
            columns={columns}
            width="max"
            verticalAlign="middle"
            // строка целиком ведет в карточку, как строки списков SourceCraft;
            // клик по самой ссылке (и Ctrl/⌘-клик) обрабатывает ссылка
            onRowClick={(item, _index, e) => {
              if ((e.target as HTMLElement).closest("a")) return;
              // Ctrl/⌘-клик по строке — новая вкладка, как у ссылки
              if (e.ctrlKey || e.metaKey) {
                window.open(repoHref(item.org, item.repo), "_blank", "noopener");
                return;
              }
              navigate(repoHref(item.org, item.repo));
            }}
          />
        ))}

      {data && view === "unscored" && <UnscoredTable items={data.nullItems} meta={meta} active={activeFilters} refreshing={refreshing} />}
    </Page>
  );
}

/**
 * Один текст под заголовком: чем считается порядок (индекс по 4 публичным
 * категориям) и охват каталога числами из БД — «Оценены N» без знаменателя
 * читалось бы как «оценен весь каталог».
 *
 * Без `/api/meta` печатается только первая половина: соврать числом нельзя,
 * а смысл «что такое индекс» от знаменателя не зависит.
 */
function ratingLead(meta: MetaResponse | null): ReactNode {
  const about = "HealthCraft Index показывает состояние открытых репозиториев SourceCraft по 4 категориям: документация, активность, задачи и состояние кода.";
  if (!meta) return (
    <>
      {about} <HowCountedLink />
    </>
  );
  return (
    <>
      {about} <HowCountedLink />
      <br />
      {coverageLine(meta.repos)}
    </>
  );
}

/**
 * «Как считается» в подзаголовке: на узком экране открывает выезжающую
 * панель, на широком прокручивает к ней. Компонент, а не строка: состояние
 * панели живет в `Page`.
 */
function HowCountedLink() {
  const aside = useAsideControl();
  return (
    <Link
      href="#"
      onClick={(e) => {
        e.preventDefault();
        showAside(aside);
      }}
    >
      Как считается?
    </Link>
  );
}

function NothingFound({ active }: { active: string[] }) {
  if (active.length === 0) {
    return (
      <EmptyState
        icon={SquareListUl}
        title="Рейтинг еще пуст"
        description="Репозитории появятся здесь после первого обхода каталога и скана."
      />
    );
  }
  return (
    <EmptyState
      icon={Magnifier}
      title="Под фильтр ничего не подошло"
      description={nothingFoundDescription(active)}
      actions={[{ text: "Сбросить фильтры", view: "normal", onClick: () => navigate("/") }]}
    />
  );
}

/**
 * Репозитории без оценки (не хватило данных): отсутствие данных не
 * превращается в низкий балл, поэтому они не в рейтинге, а здесь.
 */
function UnscoredTable({ items, meta, active, refreshing }: { items: Item[]; meta: MetaResponse | null; active: string[]; refreshing: boolean }) {
  const titleOf = (key: string): string => meta?.categories.find((c) => c.key === key)?.title ?? CATEGORY_TITLES_RU[key] ?? key;
  const columns: TableColumnConfig<Item>[] = [
    { id: "repo", name: "Репозиторий", primary: true, template: (item) => <RepoCell item={item} /> },
    { id: "coverage", name: "Покрытие данными", align: "end", width: 160, template: (item) => fmtCoverage(item.coverage) },
    {
      id: "missing",
      name: "Не хватило данных",
      template: (item) => {
        const missing = Object.entries(item.categories)
          .filter(([key, value]) => value === null && !NOT_IN_RATING.has(key))
          .map(([key]) => titleOf(key));
        return <Text color="complementary">{missing.length > 0 ? missing.join(", ") : "—"}</Text>;
      },
    },
  ];

  if (items.length === 0) {
    return active.length > 0 ? (
      <NothingFound active={active} />
    ) : (
      <EmptyState icon={SquareListUl} title="Все проанализированные репозитории оценены" description="Покрытия данными хватило каждому репозиторию выборки." />
    );
  }
  // группа может быть огромной — таблица показывает первые 5, остальное
  // счетчиком «и еще N»
  const shown = items.slice(0, 5);
  const rest = items.length - shown.length;
  const failedScan = items.some((i) => i.scanStatus === "bad");
  return (
    <Flex direction="column" gap={3} className={refreshing ? "rh-refreshing" : undefined}>
      <Text variant="body-1" color="complementary">
        Эти репозитории не получили HealthCraft Index. При покрытии данных ниже
        {meta ? ` ${fmtCoverage(meta.coverageNullBelow)}` : " установленного порога"} оценка не рассчитывается. Отсутствующие
        данные не учитываются как нулевые значения.
        {failedScan && " У части репозиториев последний анализ завершился сбоем – для оценки он непригоден; повторный обход попробует снова."}
      </Text>
      <Table data={shown} columns={columns} width="max" verticalAlign="middle" />
      {rest > 0 && <Text color="complementary">…и еще {fmtNumber(rest)} – уточните поиск или фильтры, чтобы сузить список.</Text>}
    </Flex>
  );
}

function RatingAside({ meta, metaFailed = false, generatedAt }: { meta: MetaResponse | null; metaFailed?: boolean; generatedAt: string | null }) {
  // сбой /api/meta — не вечный скелетон: шкала из клиентских констант и
  // строка о том, чего не хватает
  if (!meta && metaFailed) {
    return (
      <>
        <ScoreLegend />
        <AsideSection title="Методика">
          <Text color="complementary">Веса категорий и версия методики появятся, когда загрузится справочник сервиса.</Text>
        </AsideSection>
      </>
    );
  }
  if (!meta) return <SkeletonRows rows={4} height={96} />;
  const ratingWeight = meta.categories.reduce((sum, c) => sum + (c.indexWeight ?? 0), 0);
  // доли считаются один раз: их читают и полоса, и легенда под ней
  const ratingCategories = meta.categories
    .filter((c) => !NOT_IN_RATING.has(c.key))
    .map((c) => ({
      key: c.key,
      title: c.title,
      weight: c.indexWeight,
      share: Math.round(((c.indexWeight ?? 0) / Math.max(1, ratingWeight)) * 100),
    }));
  return (
    <>
      {/* шкала — первой в панели: без нее числу не с чем сравниться */}
      <ScoreLegend coverageNullBelow={meta.coverageNullBelow} />

      <AsideSection title="Формула">
        <Text color="complementary">
          HealthCraft Index – взвешенное среднее 4 категорий. Категория без данных в индекс не входит, ее вес переходит к остальным.
        </Text>
        <MethodLink page="scores" />
      </AsideSection>

      <AsideSection
        title="Вклад категорий"
        help={
          <HelpMark iconSize="s" aria-label="Что показывает вклад категорий">
            Доля в HealthCraft Index. Категории CI/CD и Безопасность учитываются только в показателе Repo Health Score – он
            виден, если вашему токену доступны и CI/CD, и Безопасность репозитория
          </HelpMark>
        }
      >
        {/* Доли в сумме дают 100 — поэтому полоса-стек с легендой, как «Top
            languages» у SourceCraft: одно разделенное целое, а не четыре
            независимых числа. Цвет сегмента — по ключу категории, как на
            карточке, а не по шкале здоровья: иначе категория в красном
            читалась бы как плохая. */}
        <div className="rh-contrib">
          <div className="rh-contrib__bar">
            {ratingCategories.map((c) => (
              <i key={c.key} className={`rh-contrib__seg ${categoryColorClass(c.key)}`} style={{ width: `${c.share}%` }} />
            ))}
          </div>
          {ratingCategories.map((c) => (
            <div key={c.key} className="rh-contrib__row" title={`вес в HealthCraft Index – ${c.weight}`}>
              <i className={`rh-contrib__dot ${categoryColorClass(c.key)}`} />
              <Text variant="body-1">{c.title}</Text>
              <Text variant="body-1" color="secondary" className="rh-contrib__share">
                {c.share}%
              </Text>
            </div>
          ))}
        </div>
      </AsideSection>

      <AsideSection title="Расчет">
        <DefinitionList nameMaxWidth={DEFINITION_NAME_WIDTH}>
          <DefinitionList.Item
            name="Порог оценки"
            note="Оценка рассчитывается только при достаточном покрытии. Недостающие категории исключаются из расчета. Покрытие – доля веса открытых категорий с данными: веса как в Repo Health Score, всего 65"
          >
            покрытие от {fmtCoverage(meta.coverageNullBelow)}
          </DefinitionList.Item>
          <DefinitionList.Item name="Версия методики">
            <Label theme="normal" size="xs">
              {meta.modelVersion}
            </Label>
          </DefinitionList.Item>
          {/* Периодичность обхода, а не давность данных: generatedAt — момент
              запроса, дату не показываем. Две фазы планировщика: сверка каталога
              (SCHEDULER_CATALOG_INTERVAL_MS, 1 ч) и волна повторных анализов
              (SCHEDULER_INTERVAL_MS, 24 ч); в /api/meta интервалов нет, поэтому
              текст – по значениям по умолчанию. Колонка «Анализ» скрыта по
              умолчанию, поэтому подсказка ведет на карточку. */}
          <DefinitionList.Item name="Частота" note="Каталог сверяется ежечасно, новые репозитории сразу встают в очередь. Изменившиеся репозитории анализируются повторно ежесуточно. Дата последнего анализа – на карточке репозитория.">
            каталог – ежечасно
          </DefinitionList.Item>
        </DefinitionList>
      </AsideSection>
    </>
  );
}

/** Строка опции: неинтерактивный чекбокс (клик ловит сама опция), кружок языка, имя и счётчик. */
function LangOption({ option, checked }: { option: SelectOption<LangOptionData>; checked: boolean }) {
  const d = option.data;
  return (
    <Flex gap={2} alignItems="center" className="rh-lang-option">
      <Checkbox size="m" checked={checked} controlProps={{ tabIndex: -1, "aria-hidden": true }} style={{ pointerEvents: "none" }} />
      <LanguageName name={d?.title ?? option.value} color={d?.color ?? null} noLanguage={option.value === LANG_NONE} />
      {d?.count !== null && d?.count !== undefined && <Text color="secondary">{fmtCount(d.count)}</Text>}
    </Flex>
  );
}

/** Опция размера/CI для Select: подпись в `text`, счетчик в `data`. */
function facetSelectOption(o: FacetOption): SelectOption<FacetOption> {
  return { value: o.value, text: o.title, data: o };
}

/** Строка опции размера или CI: (чекбокс мультивыбора), подпись и счетчик — как у языка. */
function FilterOption({ option, checkbox = false, checked = false }: { option: SelectOption<FacetOption>; checkbox?: boolean; checked?: boolean }) {
  const d = option.data;
  return (
    <Flex gap={2} alignItems="center" className="rh-lang-option">
      {checkbox && <Checkbox size="m" checked={checked} controlProps={{ tabIndex: -1, "aria-hidden": true }} style={{ pointerEvents: "none" }} />}
      <span>{d?.title ?? option.value}</span>
      {d?.count !== null && d?.count !== undefined && <Text color="secondary">{fmtCount(d.count)}</Text>}
    </Flex>
  );
}

/** Сводка выбранного в поле: первые имена через запятую, остальное — «+N». */
function LangSummaryPart({ value, index, values }: { value: string; index: number; values: string[] }) {
  const shown = langSummaryNames(values);
  if (index < shown) return <>{`${index > 0 ? ", " : ""}${langTitle(value)}`}</>;
  if (index === shown) return <>{` +${values.length - shown}`}</>;
  return <></>;
}

function PhoneList({ items, refreshing }: { items: Item[]; refreshing: boolean }) {
  return (
    <ul className={refreshing ? "rh-list rh-refreshing" : "rh-list"}>
      {items.map((item) => (
        <li key={`${item.org}/${item.repo}`} className="rh-list__item">
          <Flex gap={3} alignItems="center">
            <div style={{ minWidth: 28, textAlign: "right" }}>
              <RankCell item={item} />
            </div>
            {/* сжимается только имя (с многоточием), число с полосой — нет:
                иначе полоса наезжает на имя */}
            <div style={{ flex: 1, minWidth: 0 }} className="rh-phone-name">
              <RepoCell item={item} compact />
            </div>
            <div style={{ flexShrink: 0 }}>
              <ScoreCell item={item} narrow />
            </div>
          </Flex>
        </li>
      ))}
    </ul>
  );
}

/**
 * Ячейка места: треугольник изменения за сутки (▲ зеленый / ▼ красный) и
 * место жирным; величина сдвига и вчерашнее место — в подсказке на всей
 * группе. Без изменения или без снимка прошлых суток — только место.
 */
function RankCell({ item }: { item: Item }) {
  if (item.rank === null) return <Text color="secondary">—</Text>;
  const d = item.rankDelta;
  const moved = d !== null && d !== 0;
  const up = moved && d! > 0;
  const cell = (
    <span className="rh-rank" {...(moved ? TIP_TARGET : {})}>
      {moved && (
        <span className={up ? "rh-rank__arrow rh-rank__arrow_up" : "rh-rank__arrow rh-rank__arrow_down"} role="img" aria-label={up ? "Место выросло за сутки" : "Место снизилось за сутки"}>
          <Icon data={up ? TriangleUpFill : TriangleDownFill} size={10} />
        </span>
      )}
      {/* цвет — явно основной: без него текст наследует вторичный цвет ячейки таблицы */}
      <Text color="primary" className="rh-rank__n">
        {fmtCount(item.rank)}
      </Text>
    </span>
  );
  return moved ? (
    <ActionTooltip title={`${up ? "Поднялся" : "Опустился"} на ${fmtCount(Math.abs(d!))} за сутки: вчера – ${fmtCount(item.rank + d!)} место`}>{cell}</ActionTooltip>
  ) : (
    cell
  );
}

/**
 * Строка репозитория: аватар, имя и название языка. Язык подписан словом:
 * цветной кружок без названия ничего не сообщает, пока не наведешь курсор.
 * Отсюда высота строки 56px (18px слага + 16px языка + аватар `m`) —
 * осознанная плата за читаемость.
 */
function RepoCell({ item, compact = false }: { item: Item; compact?: boolean }) {
  return (
    // потолок ширины — в CSS (`.rh-rating-repo`); на широких экранах он снят,
    // и колонка берет свободное место
    <Flex gap={3} alignItems="center" className={compact ? undefined : "rh-rating-repo"} style={compact ? { minWidth: 0 } : undefined}>
      <RepoAvatar repo={item.repo} logoUrl={item.logoUrl} size="m" />
      <Flex direction="column" gap={0} style={{ minWidth: 0 }}>
        <Flex gap={1} alignItems="center" style={{ minWidth: 0 }}>
          <Link {...linkProps(repoHref(item.org, item.repo))} view="primary" className="rh-rating-name">
            <RepoSlug org={item.org} repo={item.repo} variant="subheader-1" />
          </Link>
          {/* ссылка на репо в SourceCraft — первой из иконок строки; имя ведет
              на нашу карточку */}
          <ActionTooltip title="Открыть на sourcecraft.dev">
            <Link
              href={item.webUrl}
              target="_blank"
              rel="noreferrer"
              className="rh-rating-ext"
              aria-label={`Открыть ${item.org}/${item.repo} на sourcecraft.dev`}
            >
              <Icon data={ArrowUpRightFromSquare} size={14} />
            </Link>
          </ActionTooltip>
          {item.aiOverview && (
            <ActionTooltip title="Есть AI-обзор">
              <span className="rh-rating-ai" role="img" aria-label="Есть AI-обзор" {...TIP_TARGET}>
                <Icon data={SparklesFill} size={14} />
              </span>
            </ActionTooltip>
          )}
          {/* флаг накрутки — подозрение для человека, не приговор: на место и
              сортировку не влияет; тексты те же, что у плашки на карточке */}
          {item.fraud && (
            <ActionTooltip title={FRAUD_TITLE} description={FRAUD_EXPLAIN}>
              <span className="rh-rating-fraud" role="img" aria-label={FRAUD_TITLE} {...TIP_TARGET}>
                <Icon data={Flag} size={14} />
              </span>
            </ActionTooltip>
          )}
        </Flex>
        <Text variant="body-short" color="secondary" ellipsis>
          <LanguageName name={item.language} color={item.languageColor} />
        </Text>
      </Flex>
    </Flex>
  );
}

/**
 * Заголовок сортируемой колонки, как в таблицах SourceCraft. Сортировка
 * серверная (`sort`/`order` в query), поэтому `withTableSorting` uikit не
 * подходит — он сортирует данные страницы на клиенте. Здесь заголовок —
 * просто кнопка, меняющая query.
 */
function SortableHeader({
  label,
  columnKey,
  sort,
  order,
  onSort,
  wrap = false,
}: {
  label: string;
  columnKey: SortKey;
  sort: string;
  order: string;
  onSort: (key: SortKey, next: "asc" | "desc") => void;
  /** узкая колонка: подпись переносится в 2 строки, а не распирает колонку */
  wrap?: boolean;
}) {
  const active = sort === columnKey;
  // первый клик по «Репозиторию» — А→Я, по числам — по убыванию
  const next: "asc" | "desc" = active ? (order === "desc" ? "asc" : "desc") : firstSortOrder(columnKey);
  return (
    <Button
      view="flat"
      size="xs"
      className={wrap ? "rh-th-sort rh-th-sort_wrap" : "rh-th-sort"}
      onClick={() => onSort(columnKey, next)}
      title={active ? (order === "desc" ? "По убыванию – переключить на возрастание" : "По возрастанию – переключить на убывание") : `Сортировать по «${label}»`}
    >
      {label}
      <Icon
        data={order === "asc" && active ? BarsAscendingAlignLeft : BarsDescendingAlignLeft}
        size={12}
        className={active ? "rh-th-sort__mark rh-th-sort__mark_on" : "rh-th-sort__mark"}
      />
    </Button>
  );
}

function buildColumns(
  categories: MetaResponse["categories"],
  sortProps: { sort: string; order: string; onSort: (key: SortKey, next: "asc" | "desc") => void },
): TableColumnConfig<Item>[] {
  const sortable = (label: string, columnKey: SortKey, wrap = false) => () => <SortableHeader label={label} columnKey={columnKey} wrap={wrap} {...sortProps} />;
  const categoryColumns: TableColumnConfig<Item>[] = categories.map((c) => ({
    id: `cat:${c.key}`,
    name: c.title,
    align: "end",
    template: (item: Item) => <CategoryCell value={item.categories[c.key] ?? null} />,
  }));

  return [
    {
      id: "rank",
      name: "#",
      align: "end",
      sticky: "start",
      // настоящее место в рейтинге (поле `rank`), а не номер строки выдачи:
      // при поиске и фильтре «#» совпадает с местом на карточке
      template: (item: Item) => <RankCell item={item} />,
    },
    { id: "repo", name: sortable("Репозиторий", "name"), primary: true, sticky: "start", template: (item: Item) => <RepoCell item={item} /> },
    { id: "index", name: sortable("HealthCraft Index", "index"), align: "end", width: 136, template: (item: Item) => <ScoreCell item={item} /> },
    ...categoryColumns,
    // язык уже подписан в строке репозитория, поэтому колонка выключена по умолчанию
    { id: "lang", name: "Язык", template: (item: Item) => <LanguageName name={item.language} color={item.languageColor} /> },
    {
      id: "likes",
      name: sortable("Реакции", "likes"),
      align: "end",
      width: 96,
      template: (item: Item) => <Text color="secondary">{fmtNumber(item.likes)}</Text>,
    },
    { id: "forks", name: "Ответвления", align: "end", template: (item: Item) => fmtNumber(item.forks) },
    // не «Активность»: так называется категория Score, а это дата из каталога;
    // «Обновлен» — как «Updated» в списке Top repositories SourceCraft, и
    // заголовок встает в одну строку
    {
      id: "activity",
      name: sortable("Обновлен", "activity"),
      align: "end",
      width: 104,
      template: (item: Item) => <Text color="secondary">{fmtDate(item.lastActivityAt)}</Text>,
    },
    // сортировка идет по заголовкам, поэтому у покрытия своя колонка
    { id: "coverage", name: sortable("Покрытие", "coverage"), align: "end", template: (item: Item) => fmtCoverage(item.coverage) },
    {
      id: "scanned",
      name: "Анализ",
      align: "end",
      template: (item: Item) => (
        <Flex direction="column" gap={0} alignItems="flex-end">
          <Text>{fmtDate(item.scannedAt)}</Text>
          {/* при сбойном скане оценка держится на последнем удачном — объясняем это */}
          <Text
            variant="body-short"
            color="secondary"
            title={
              item.scanStatus === "bad"
                ? "Последний анализ завершился сбоем: часть источников не ответила. Оценка взята из последнего успешного анализа – сбой ее не снижает."
                : undefined
            }
          >
            {scanStatusText(item.scanStatus)}
          </Text>
        </Flex>
      ),
    },
  ];
}

/**
 * Колонка HealthCraft Index: полоса и число в строку, число справа.
 *
 * Полоса 80px (размеры — в layout.css): при 64px разница 83 и 80 занимала
 * меньше 2px и была невидима; различимость полосе дает прежде всего цвет.
 * Слот числа фиксирован (32px, `tabular-nums`) — иначе левая кромка полосы
 * гуляет по колонке и полосы перестают сравниваться между строками.
 */
function ScoreCell({ item, narrow = false }: { item: Item; narrow?: boolean }) {
  if (item.healthcraftIndex === null) {
    return (
      <Label theme="unknown" size="xs">
        {NO_SCORE}
      </Label>
    );
  }
  if (item.codeEmpty) {
    // пустой репо: число нейтральное и метка «нет кода», как в «Сравнении» —
    // 0 здесь значит «оценивать нечего», а не зону риска
    return (
      <Flex gap={2} alignItems="center" justifyContent="flex-end">
        <Label theme="unknown" size="xs" title="В репозитории нет кода – оценка 0 означает, что оценивать пока нечего">
          нет кода
        </Label>
        <Text color="secondary" className="rh-score-cell__num">
          {fmtScore(item.healthcraftIndex)}
        </Text>
      </Flex>
    );
  }
  return (
    <Flex gap={0} alignItems="center" justifyContent="flex-end">
      {/* «Из истории» — левее полосы: ярлык редкий и не должен раздвигать числовой ряд */}
      {item.staleFacts && (
        <Label theme="warning" size="xs" title="Часть данных взята из прошлого анализа: источник не ответил">
          Из истории
        </Label>
      )}
      <div className={narrow ? "rh-score-cell__bar rh-score-cell__bar_narrow" : "rh-score-cell__bar"}>
        <Progress value={item.healthcraftIndex} size="s" theme={scoreTheme(item.healthcraftIndex)} />
      </div>
      {/* уровень несет полоса, число нейтральное — как значение в строке Top
          repositories: в строке один цветной акцент, а не два */}
      <Text color="primary" className="rh-score-cell__num" title={sentence(scoreWord(item.healthcraftIndex))}>
        {fmtScore(item.healthcraftIndex)}
      </Text>
    </Flex>
  );
}

/**
 * Категория в таблице рейтинга. Цветом выделены только исключения: 40-69 и
 * <40 получают Label, значения от 70 — нейтральный текст. Цветные числа во
 * всех колонках читались как светофор и спорили с окраской индекса.
 *
 * Нет данных — другой тип ячейки: нейтральный Label с «н/д» и причиной в
 * `title`, никогда не красный и не ноль. Полное «Нет данных» в узкую колонку
 * не влезает — отсюда короткая форма.
 */
function CategoryCell({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <Label theme="unknown" size="xs" title="Нет данных: категория в оценке не участвует и ее не снижает">
        {NO_DATA_SHORT}
      </Label>
    );
  }
  if (scoreTheme(value) === "success") {
    return (
      <Text className="rh-cat-plain" style={{ fontVariantNumeric: "tabular-nums" }} title={sentence(scoreWord(value))}>
        {fmtScore(value)}
      </Text>
    );
  }
  return (
    <Label theme={scoreLabelTheme(value)} size="xs" className="rh-cat-chip" title={sentence(scoreWord(value))}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtScore(value)}</span>
    </Label>
  );
}
