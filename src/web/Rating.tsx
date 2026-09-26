// Rating.tsx — страница рейтинга: здоровье, а не популярность (ТЗ 4).
// Вся выборка считается сервером (решение канвы «г»), страница только
// переводит состояние контролов в query-строку и обратно — поэтому
// отфильтрованным рейтингом можно поделиться ссылкой, и F5 его не теряет.
// Раскладка — как соседние разделы SourceCraft: крошки в ActionBar,
// тулбар одной строкой (size m), таблица, методика в правой панели.
import { coverageLine } from "./ratingParams";
import { loadRatingScroll, rememberRatingHref, saveRatingScroll } from "./ratingReturn";
import { ArrowUpRightFromSquare, BarsAscendingAlignLeft, BarsDescendingAlignLeft, Flag, Gear, Magnifier, Sparkles, SquareListUl, TriangleDownFill, TriangleUpFill } from "@gravity-ui/icons";
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
import { FILTER_LIMITS_NOTE } from "../api/rating-filters";
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
  scoreColor,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  sentence,
} from "./format";
import { useMediaQuery } from "./prefs";
import { linkProps, navigate, repoHref } from "./router";
import { Page, showAside, useAsideControl } from "./Shell";
import { categoryColorClass } from "./cardView";
import { AsideSection, EmptyState, LanguageName, PageHeader, RepoAvatar, RepoSlug, ScoreLegend, SkeletonRows } from "./ui";
import { LANG_NONE, LANG_NONE_TITLE, langOptions, type Facets, type LangOptionData } from "./lang-filter";

type Item = RatingResponse["items"][number];

/**
 * «Язык не определён» — не значение языка, а режим фильтра (`lang=` пустым).
 * В4.7 (П2): опции «все» больше нет — все языки означает «ничего не выбрано»
 * (параметра `lang` нет), решение владельца.
 */

/**
 * Сводка выбранного в поле («Go, Rust +2»): имена идут, пока укладываются в
 * бюджет символов, остальное — «+N». Бюджет снят с живого поля (харнесс 21.09):
 * при ширине 220px на текст остаётся ~117px, это ~18 знаков Inter 13px, из
 * них 3-4 уходят на «+N». Первое имя показывается всегда.
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
 * В4.8.5 (К8.5.10, С5-3): категории рейтинга без /api/meta — имена из
 * клиентских констант (порядок `CATEGORY_ORDER` сервера); веса неизвестны —
 * панель методики их не рисует, колонки рисуются.
 */
const FALLBACK_CATEGORIES: MetaResponse["categories"] = ["documentation", "cicd", "security", "activity", "issues", "code"].map((key) => ({
  key: key as MetaResponse["categories"][number]["key"],
  title: CATEGORY_TITLES_RU[key] ?? key,
  indexWeight: null,
  scoreWeight: 0,
}));

/**
 * Подписи колонок — один словарь на шапку таблицы и на список «Колонки».
 * Категорийные колонки сюда не входят: их имена приходят из /api/meta.
 * «#» в шапке — знак, а не слово; в списке настройки он ничего не называл,
 * поэтому там колонка зовётся «Позиция» (решение владельца 21.09).
 */
const COLUMN_TITLES: Record<string, string> = {
  rank: "Позиция",
  repo: "Репозиторий",
  index: "HealthCraft Index",
  lang: "Язык",
  likes: "Реакции",
  forks: "Ответвления",
  activity: "Последняя активность",
  coverage: "Покрытие",
  scanned: "Анализ",
};

/**
 * В4.9 ч.2 (U10-b): «Реакции» и «Последняя активность» видны по умолчанию —
 * узкими колонками вторичным цветом. Рейтинг не про популярность, но это
 * держит вес индекса (реакции в него не входят и порядок не меняют), а не
 * скрытие колонки: зритель видит популярность рядом и сортирует по ней сам.
 */
const HIDDEN_BY_DEFAULT = ["lang", "forks", "coverage", "scanned"];

export function Rating({ search: rawSearch, meta, metaFailed = false }: { search: string; meta: MetaResponse | null; metaFailed?: boolean }) {
  // В4.8.5 (К8.5.10, С5-2): неверные sort/order/per_page/page из старой ссылки
  // заменяются дефолтом, адрес исправляется — сервер не получает заведомый 400
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
  // В4.7 круг 2 (Р2.6): при смене фильтра, сортировки или страницы прежняя
  // выдача остаётся на экране приглушённой, пока не придёт новая, — без
  // скелетона, скачка ширины вкладок и пропадающей пагинации
  const { state, reload } = useJson<RatingResponse>(`/api/repos${apiSearch ? `?${apiSearch}` : ""}`, { keepPrevious: true });
  // Ступень 4 (В-10): адрес выдачи — для крошки «Рейтинг» на карточке;
  // прокрутка таблицы (или списка телефона) — запоминается при уходе и
  // возвращается, когда выдача с тем же адресом снова на экране
  useEffect(() => rememberRatingHref(search), [search]);
  const restoredFor = useRef<string | null>(null);
  const scroller = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(".rh-table-fill .g-table__scroll-container") ?? document.querySelector<HTMLElement>(".rh-fill__content");
  // ревью кода R4: слушатель — на адрес выдачи и появление контейнера, а не на
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
  // В4.7 (П2): `lang` повторяемый; одиночная старая ссылка — набор из одного
  const langValues = params.getAll("lang").map((v) => (v === "" ? LANG_NONE : v));
  const qParam = params.get("q") ?? "";
  const aiOnly = params.get("ai") === "1";
  // В5.5 тур 2 (W3): размер (повторяемый) и CI; пустое состояние называет все включенные фильтры
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

  const [hidden, setHidden] = useState<string[]>(HIDDEN_BY_DEFAULT);

  function setParams(patch: Record<string, string | string[] | null>, opts: { replace?: boolean; keepPage?: boolean } = {}): void {
    // В4.8.5 (К8.5.10, С5-5): база — ТЕКУЩИЙ адрес, а не снимок рендера:
    // отложенный таймер поиска иначе откатывал выбранные за 300 мс язык,
    // сортировку или страницу
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      // массив — повторяемый параметр (`lang`, В4.7): каждое значение отдельно
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
  // В4.8.5 (К8.5.10, С5-1): страница за пределами выдачи (старая ссылка
  // `?page=5` при трёх результатах) — последняя существующая, а не «Рейтинг еще пуст»
  const lastPage = state.kind === "ok" ? pageBeyond(state.data) : null;
  useEffect(() => {
    if (lastPage !== null) setParams({ page: lastPage === 1 ? null : String(lastPage) }, { replace: true, keepPage: true });
    // setParams читает текущий адрес — в зависимостях не нужен
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPage]);
  // В4.7 круг 2 (Р2.1): пока грузится новый набор, список языков строится из
  // фасетов последнего успешного ответа — иначе на время загрузки из него
  // пропадали все опции, кроме выбранных, и у тех — цвет и счётчик. Фасеты
  // от языкового фильтра не зависят, поэтому прежние верны для нового набора.
  const lastFacets = useRef<Facets>([]);
  if (data) lastFacets.current = data.facets.languages;
  // В5.5 тур 2 (W3): счетчики размера и CI — так же из последнего ответа (от фильтров не зависят)
  const lastFilterFacets = useRef<RatingResponse["facets"] | null>(null);
  if (data) lastFilterFacets.current = data.facets;
  // M-9: без /api/meta категории не сыплются ключами — имена из констант
  const categoryNames: Record<string, string> = useMemo(
    () => Object.fromEntries((meta?.categories ?? []).map((c) => [c.key, c.title])),
    [meta],
  );
  const titleOf = (key: string): string => categoryNames[key] ?? CATEGORY_TITLES_RU[key] ?? key;
  // В4.8.5 (К8.5.10, С5-3): без /api/meta категорийные колонки строятся из
  // клиентских констант — плашка «показаны запасными значениями» больше не врёт
  const categories = useMemo(() => (meta?.categories ?? FALLBACK_CATEGORIES).filter((c) => !NOT_IN_RATING.has(c.key)), [meta]);
  const onSort = (key: SortKey, next: "asc" | "desc"): void => setParams({ sort: key, order: next });
  const allColumns = useMemo(
    () => buildColumns(categories, { sort, order, onSort }),
    // `onSort` пересоздаётся каждый рендер (замыкает setParams) и в список
    // зависимостей не идёт намеренно: колонки перестраивает смена самой
    // сортировки, а не идентичность обработчика
    [categories, sort, order],
  );
  // Доводка 21.09: у сортируемых колонок `name` — функция-заголовок, и прежний
  // фолбэк печатал в настройке технический id («repo», «index», «activity»).
  // Список настройки и шапка таблицы обязаны называть колонку ОДИНАКОВО,
  // поэтому подписи берутся из одного словаря, а не выводятся из разметки.
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
        {/* flex-обертка: блочная давала полю 27.3px против 28px у соседних Select.
            Тур 3 В5.5 (п.2): основа 160px — тулбар на экранах ПК от 1366 в одну строку,
            поле растягивается на остаток */}
        <div style={{ flex: "1 1 160px", minWidth: 160, display: "flex" }}>
          {/* В4.6 (У29, замечание владельца 3): плейсхолдер называет ДЕЙСТВИЕ,
              а перечень полей уезжает в подсказку у правого края инпута. Текст
              подсказки сверен по коду (`repos.ts`, matchesQ), а не написан на
              слух: поиск идёт подстрокой по org, repo и названию, без учёта
              регистра — обещать больше было бы неправдой.
              Круг 2 (Р1): у иконки появился отступ СПРАВА — без него «Поиск»
              слипался с лупой (замечание владельца 1); формулировка подсказки
              взята дословно из пункта 2 (Р2). */}
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
        {/* В4.7 (П2): мультивыбор языка. Чекбокс — неинтерактивный
            `Checkbox` в `renderOption` (штатная галочка `multiple` скрыта
            стилем попапа), у опции цветной кружок из фасета, список ограничен
            по высоте со скроллом, выбранное — сводкой «Go, Rust +2».
            Виртуализация выключена порогом: у виртуального списка своя
            высота, и CSS-ограничение со скроллом на нём не работает. */}
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
        {/* В5.5 тур 2 (W3, ТЗ §7): размер по строкам кода (мультивыбор, как язык) и
            наличие CI. Счетчики — из фасетов (по поиску, без фильтров); репо без
            данных о размере или CI не попадает ни в одно значение. */}
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
        {/* тематика и security status из ТЗ §7 — названное ограничение, а не фильтр */}
        <HelpMark iconSize="m" aria-label="О фильтрах: тематика, безопасность, CI">
          {FILTER_LIMITS_NOTE}
        </HelpMark>
        {/* Доводка 21.09: пара «Сортировка: …» + кнопка направления снята —
            сортировка живёт в заголовках колонок (`SortableHeader`), как в
            таблицах платформы. Освободившееся место занял второй ряд: выбор
            колонок и переключатель выборки поднялись сюда, и тулбар стал
            однострочным — поиск, язык, колонки, выборка. */}
        {view === "scored" && !isPhone && (
          <TableColumnSetup
            items={setupItems}
            showStatus
            onUpdate={(updated) => setHidden(updated.filter((i) => !i.selected).map((i) => i.id))}
            /* тур 3 В5.5 (п.2): переключатель — иконкой, счетчик колонок — в подсказке
               (место в строке тулбара отдано фильтрам) */
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
        {/* В5.2 (Б6, выбор 4C): фильтр «С AI-обзором» — путь к обзорам с первого экрана; кнопки
            нет, пока таких репо 0 (и фильтр не включен) */}
        {view === "scored" && data && (data.aiCount > 0 || aiOnly) && (
          <Button view="outlined" size="m" selected={aiOnly} onClick={() => setParams({ ai: aiOnly ? null : "1" })}>
            <Button.Icon side="start">
              <Icon data={Sparkles} size={16} className="rh-ai-mark-icon" />
            </Button.Icon>
            {`С AI-обзором ${fmtCount(data.aiCount)}`}
          </Button>
        )}
      </Flex>
    </Flex>
  );

  return (
    <Page
      mode="fill"
      // круг 2 (Н1): панель колонкой — только с 1600, чтобы на 1440 таблице
      // хватило ширины на «Реакции» и «Последнюю активность»
      asideColumnFrom={1600}
      crumbs={[{ text: "Рейтинг" }]}
      aside={<RatingAside meta={meta} metaFailed={metaFailed} generatedAt={data?.generatedAt ?? null} />}
      header={
        <>
          {/* В4.6 круг 2 (Р5, замечание владельца 5): заголовок, подзаголовок и
              абзац охвата были ТРЕМЯ текстами подряд. Владелец схлопнула их в
              один — формулировка её, размер прежнего подзаголовка (он и есть
              слот `description`). Охват по-прежнему НАЗВАН числами из БД
              (У15), а стратегия волн — словами; охранный пункт 3 дизайн-пары
              (прежний подзаголовок про лайки) отменён этим контрактом. */}
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
            // В4.6 (У21): дефолт стал 20 — без опции 20 к нему было бы не вернуться
            pageSizeOptions={isPhone ? undefined : [10, 20, 50, 100]}
            onUpdate={(page, pageSize) => setParams({ page: String(page), per_page: String(pageSize) }, { keepPage: true })}
          />
        ) : undefined
      }
    >
      {/* В4.6 (У27): скелетон держит РИТМ содержимого. Круг 2 (Р3) вернул в
          строку название языка, и её высота снова 56px — 46px оставили бы
          прыжок раскладки в момент загрузки, то есть ровно ту находку пары. */}
      {/* скелетон — только при первой загрузке; при обновлении — полоса сверху */}
      {state.kind === "loading" && !refreshing && <SkeletonRows rows={10} height={56} />}
      <div className={refreshing ? "rh-refresh-bar rh-refresh-bar_on" : "rh-refresh-bar"} role="progressbar" aria-hidden={!refreshing} aria-label="Обновляем рейтинг" />

      {/* Ступень 4 (Ф16): перечитывание не удалось — строки прежние, и это видно
          (как на карточке, К8.5.3): иначе новая сортировка подсвечена над старыми строками */}
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
              // Ступень 4 (Ф19): Ctrl/⌘-клик по строке — новая вкладка, как у ссылки
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
 * ОДИН текст под заголовком рейтинга (В4.6 круг 2, Р5 — формулировка
 * владельца). Что он обязан сказать и почему: чем считается порядок (индекс,
 * 4 публичные категории), что оценка воспроизводима из публичных данных, и —
 * честный охват каталога числами из БД (У15), потому что «Оценены N» без
 * знаменателя читалось как «оценен весь каталог». Стратегия волн названа
 * словами: обход идёт с самых заметных проектов, но на МЕСТО в рейтинге это
 * не влияет — порядок считает индекс.
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
 * В4.9 ч.2 (U14): «Как считается» в подзаголовке — ниже 1440 открывает
 * выезжающую панель (ту же, что кнопка ActionBar), на 1440+ прокручивает к
 * панели. Компонент, а не строка: состояние панели живет в `Page`.
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

/** Группа «нет данных» — витрина закона 2: счётчик виден всегда, список — по переключателю. */
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
  // Ф2.16: NULL-группа может быть огромной (весь не обходивший каталог) —
  // таблица показывает первые 5, остальное честным счётчиком «и ещё N»
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
  // В4.6 (У27): панель начинается с легенды шкалы (3 чипа + абзац) и двух блоков
  // В4.8.5 (К8.5.10, С5-3): сбой /api/meta — не вечный скелетон: шкала из
  // клиентских констант и честная строка о том, чего не хватает
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
      {/* В4.6 (У22): шкала — первое, что читается в панели: без неё число не с чем сравнить */}
      <ScoreLegend coverageNullBelow={meta.coverageNullBelow} />

      {/* В4.6 круг 2 (Р7, замечание владельца 7): первый блок панели —
          пересказ методики — удалён целиком. Он повторял то, что теперь стоит
          ОДНИМ текстом над таблицей (Р5), и панель начиналась с двух абзацев
          подряд. Сведения не потеряны: 4 публичные категории названы в тексте
          над таблицей, граница CI/CD и Security — в подсказке блока «Вклад
          категорий» ниже, а лайки-как-сортировка видны списком сортировок. */}

      <AsideSection
        title="Вклад категорий"
        /* В4.6 круг 2 (Р8, замечание владельца 8): абзац под списком удалён,
           его сведения переехали в иконку-подсказку рядом с заголовком —
           объяснение списка стоит у списка, а не отдельным абзацем панели. */
        help={
          <HelpMark iconSize="s" aria-label="Что показывает вклад категорий">
            Доля в HealthCraft Index. Категории CI/CD и Безопасность учитываются только в показателе Repo Health Score для
            репозиториев, к которым у вас есть доступ
          </HelpMark>
        }
      >
        {/* Доводка 21.09: доли, дающие в сумме сто, показаны полосой-стеком с
            легендой под ней — приём панели SourceCraft («Top languages»:
            точка, имя, доля). Пары «имя — число» в `DefinitionList` этого
            родства не показывали: было четыре независимых факта вместо одного
            разделённого целого.
            Цвета сегментов — оттенки ОДНОГО акцента, не шкала здоровья:
            зелёный и красный в этой панели уже заняты легендой оценки, и
            категория, покрашенная в красный, читалась бы как плохая. */}
        <div className="rh-contrib">
          <div className="rh-contrib__bar">
            {/* В4.9 ч.2 (А3): цвет — по ключу категории, как на карточке */}
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
          {/* В4.6 круг 2 (Р9, замечание владельца 9): пояснение порога —
              формулировка владельца; само число порога из БД остаётся на
              экране значением пункта. */}
          <DefinitionList.Item
            name="Порог оценки"
            note="Оценка рассчитывается только при достаточном покрытии. Недостающие категории исключаются из расчета"
          >
            покрытие от {fmtCoverage(meta.coverageNullBelow)}
          </DefinitionList.Item>
          <DefinitionList.Item name="Версия методики">
            <Label theme="normal" size="xs">
              {meta.modelVersion}
            </Label>
          </DefinitionList.Item>
          {/* M-7: «Данные на сегодня» врало (generatedAt = момент запроса) — честная свежесть ниже.
              В4.6 круг 2 (Р10, замечание владельца 10): пункт называется «Частота» —
              «Свежесть» обещала давность данных, а речь о периодичности обхода;
              значение и пояснение — формулировки владельца. */}
          {/* В4.9 ч.2 (Б): колонка «Скан» скрыта по умолчанию — подсказка ведет на карточку */}
          <DefinitionList.Item name="Частота" note="Обход каталога выполняется ежесуточно. Дата последнего анализа – на карточке репозитория.">
            ежесуточно
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

/** В5.5 тур 2 (W3): опция размера/CI для Select — подпись в `text`, счетчик в `data`. */
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
            {/* Круг 4 части 2: на телефоне строка репозитория сжимается (имя —
                с многоточием), а число с полосой не сжимаются — раньше мера
                строки в 180px выталкивала полосу поверх имени */}
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
 * Ячейка места. Тур 3 В5.5 (26.09, Екатерина — итог круга правок динамики):
 * треугольник направления за сутки (▲ зеленый / ▼ красный) рядом с местом;
 * место — основным цветом, жирным; величина сдвига и вчерашнее место — в
 * подсказке на группе «треугольник + место». Без изменения и без снимка прошлых суток — только место.
 * Вытесняет тур 1 (число под местом), отдельную колонку и число рядом с местом.
 */
function RankCell({ item }: { item: Item }) {
  if (item.rank === null) return <Text color="secondary">—</Text>;
  const d = item.rankDelta;
  const moved = d !== null && d !== 0;
  const up = moved && d! > 0;
  const cell = (
    <span className="rh-rank">
      {moved && (
        <span className={up ? "rh-rank__arrow rh-rank__arrow_up" : "rh-rank__arrow rh-rank__arrow_down"} role="img" aria-label={up ? "Место выросло за сутки" : "Место снизилось за сутки"}>
          <Icon data={up ? TriangleUpFill : TriangleDownFill} size={12} />
        </span>
      )}
      {/* цвет — явно основной: без него текст наследует вторичный цвет ячейки таблицы */}
      <Text color="primary" className="rh-rank__n">
        {fmtCount(item.rank)}
      </Text>
    </span>
  );
  // подсказка — на всей группе «треугольник + место» (слово владельца 26.09)
  return moved ? (
    <ActionTooltip title={`${up ? "Поднялся" : "Опустился"} на ${fmtCount(Math.abs(d!))} за сутки: вчера – ${fmtCount(item.rank + d!)} место`}>{cell}</ActionTooltip>
  ) : (
    cell
  );
}

/**
 * Строка репозитория: иконка, имя, НАЗВАНИЕ ЯЗЫКА (В4.6 круг 2, Р3 —
 * замечание владельца 3; частичная отмена З9 круга 1).
 *
 * Круг 1 уплотнил строку до 46px: название языка ушло в `title` цветной точки
 * и в колонку «Язык», выключенную по умолчанию. Владелец прошла по живому
 * рейтингу и вернула лэйаут: цветной кружок без названия ничего не сообщал —
 * язык узнавался только наведением, то есть для читающего глазами не
 * существовал. Высота строки 56px ПРИНЯТА решением владельца (18px слага +
 * 16px названия языка + аватар `m`), `perPage` 20 остаётся: видно ~15 строк
 * вместо 17, и это осознанная плата за читаемую строку.
 */
function RepoCell({ item, compact = false }: { item: Item; compact?: boolean }) {
  return (
    <Flex gap={3} alignItems="center" style={compact ? { minWidth: 0 } : { minWidth: 180, maxWidth: 264 }}>
      <RepoAvatar repo={item.repo} logoUrl={item.logoUrl} size="m" />
      <Flex direction="column" gap={0} style={{ minWidth: 0 }}>
        <Flex gap={1} alignItems="center" style={{ minWidth: 0 }}>
          <Link {...linkProps(repoHref(item.org, item.repo))} view="primary" className="rh-rating-name">
            {/* В4.6 (У27): слаг — один компонент на рейтинг и карточку */}
            <RepoSlug org={item.org} repo={item.repo} variant="subheader-1" />
          </Link>
          {/* тур 3 В5.5 (круг 3): ссылка на SourceCraft — первой из иконок строки. В5.5 тур 1 (Р3): внешняя ссылка на страницу репо в SourceCraft;
              имя по-прежнему ведет на нашу карточку */}
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
          {/* В5.2 (Б6, выбор 4C): у репо есть публичный AI-обзор — искра у имени */}
          {item.aiOverview && (
            <ActionTooltip title="Есть AI-обзор">
              <span className="rh-rating-ai" role="img" aria-label="Есть AI-обзор">
                <Icon data={Sparkles} size={14} />
              </span>
            </ActionTooltip>
          )}
          {/* В5.5 тур 1 (Р2): флаг проверки на накрутку — подозрение для человека,
              не приговор (на место и сортировку не влияет); формулировки — те же,
              что у плашки на карточке (format.ts FRAUD_*) */}
          {item.fraud && (
            <ActionTooltip title={FRAUD_TITLE} description={FRAUD_EXPLAIN}>
              <span className="rh-rating-fraud" role="img" aria-label={FRAUD_TITLE}>
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
 * Заголовок колонки, по которой можно сортировать.
 *
 * Доводка 21.09: сортировка переехала из тулбара в шапку таблицы — так она
 * устроена у платформы (таблица Labels: «Name ↑↓ · Updated date ↓»), и так её
 * ищет читатель: в самой колонке. Освободились 264px тулбара, которые занимали
 * `Select` шириной по содержимому и кнопка направления.
 *
 * Сортировка остаётся СЕРВЕРНОЙ (`sort`/`order` в query, выборку считает API),
 * поэтому `withTableSorting` не подходит — он про клиентскую сортировку
 * данных страницы. Здесь заголовок это просто кнопка, меняющая query.
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
  /** В4.9 ч.2 (U10-b): узкая колонка — подпись переносится в 2 строки, а не распирает колонку */
  wrap?: boolean;
}) {
  const active = sort === columnKey;
  // В4.8.5 (К8.5.10, С5-8): первый клик по «Репозиторию» — А→Я, по числам — по убыванию
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
      // Ступень 4 (В-4): настоящее место в рейтинге (поле `rank` ответа), а не номер
      // строки выдачи — при поиске и фильтре «#» совпадает с местом на карточке.
      // Тур 3 В5.5: место жирным, справа — динамика за сутки (▲/▼ и число)
      template: (item: Item) => <RankCell item={item} />,
    },
    { id: "repo", name: sortable("Репозиторий", "name"), primary: true, sticky: "start", template: (item: Item) => <RepoCell item={item} /> },
    { id: "index", name: sortable("HealthCraft Index", "index"), align: "end", width: 136, template: (item: Item) => <ScoreCell item={item} /> },
    ...categoryColumns,
    // В4.6 круг 2 (Р3): название языка снова стоит в строке репозитория;
    // колонка остаётся для сортируемого/копируемого вида, выключенной по умолчанию
    { id: "lang", name: "Язык", template: (item: Item) => <LanguageName name={item.language} color={item.languageColor} /> },
    {
      id: "likes",
      name: sortable("Реакции", "likes"),
      align: "end",
      width: 96,
      template: (item: Item) => <Text color="secondary">{fmtNumber(item.likes)}</Text>,
    },
    { id: "forks", name: "Ответвления", align: "end", template: (item: Item) => fmtNumber(item.forks) },
    // не «Активность»: так называется категория Score, а это дата из каталога
    {
      id: "activity",
      name: sortable("Последняя активность", "activity", true),
      align: "end",
      width: 132,
      template: (item: Item) => <Text color="secondary">{fmtDate(item.lastActivityAt)}</Text>,
    },
    // колонка заведена вместе с переносом сортировки: «Покрытие данными» было
    // в списке сортировок, но своей колонки не имело — сортировать стало бы не по чему
    { id: "coverage", name: sortable("Покрытие", "coverage"), align: "end", template: (item: Item) => fmtCoverage(item.coverage) },
    {
      id: "scanned",
      name: "Анализ",
      align: "end",
      template: (item: Item) => (
        <Flex direction="column" gap={0} alignItems="flex-end">
          <Text>{fmtDate(item.scannedAt)}</Text>
          {/* Ф2.16: пояснение при сбойном скане — Score держится на последнем удачном */}
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
 * Колонка HealthCraft Index (В4.6, У21 — замечание владельца 2): полоса и
 * число стоят В СТРОКУ, число справа.
 *
 * Измерено дизайн-раундом 20.09, а не выбрано на глаз: прежняя вертикаль
 * давала полосу 64x4px — 0,64px на балл, то есть разница 83 и 80 занимала
 * 1,9px и была невидима. Круг 1 развернул пару в строку и дал полосе 80px
 * длины; читаемость она получает не длиной, а цветом (после палитрового паса
 * контраст заливки к дорожке вырос с 1,95:1 до 4,40:1). Круг 2 (Р3) снизил
 * её высоту до `size="xs"` по замечанию владельца — в СТРОКЕ рейтинга полоса
 * стоит рядом с числом и не должна с ним спорить; полосы карточки остаются
 * `size="s"`, там они главная графика блока.
 *
 * Слот числа ФИКСИРОВАН на 32px и набран `tabular-nums` — иначе при
 * двузначных и трёхзначных значениях левая кромка полосы гуляет по колонке
 * и полосы перестают сравниваться между строками.
 *
 * В4.6 круг 3 П2.6 явно заменил типографику П1: число 14px/600, высота
 * полосы ровно 8px, зазор пары 0. Длина 80px и цвет по порогам сохранены.
 */
function ScoreCell({ item, narrow = false }: { item: Item; narrow?: boolean }) {
  if (item.healthcraftIndex === null) {
    return (
      <Label theme="unknown" size="xs">
        {NO_SCORE}
      </Label>
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
      <Text color={scoreColor(item.healthcraftIndex)} className="rh-score-cell__num" title={sentence(scoreWord(item.healthcraftIndex))}>
        {fmtScore(item.healthcraftIndex)}
      </Text>
    </Flex>
  );
}

/**
 * Категория в таблице рейтинга (В4.6 круг 2, Р4 — замечание владельца 4).
 *
 * Круг 1 красил число по `scoreTheme()` (корень ДП1: «26 и 98 набраны одним
 * цветом»). Владелец прошла по живому рейтингу и СНЯЛА цветовую индикацию со
 * всех категорийных колонок: четыре-шесть цветных чисел в строке читались как
 * светофор на всю таблицу и спорили с окраской самого индекса. Отмена
 * сознательная — оба дизайн-аудитора считали ДП1 критичной, поэтому вопрос
 * «как визуально передать категорию» заведён в парковку канвы, а не забыт.
 * Окраска ИНДЕКСА и его полосы остаётся; на КАРТОЧКЕ окраска категорийных
 * чисел тоже остаётся (там рядом с числом стоит полоса, она несёт цвет).
 *
 * Tri-state не двигается ни на йоту: отсутствие данных — ДРУГОЙ ТИП ячейки,
 * нейтральный `Label theme="unknown"` со словом «н/д» и причиной в `title`,
 * никогда не красный и никогда не ноль (закон 2, охранный пункт 1).
 * «Нет данных» полностью в узкую колонку (59px у Issues) не влезает — отсюда
 * короткая форма.
 */
function CategoryCell({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <Label theme="unknown" size="xs" title="Нет данных: категория в оценке не участвует и ее не снижает">
        {NO_DATA_SHORT}
      </Label>
    );
  }
  // Круг 3, пакет П3/1 отменяет Р4 круга 2: цвет возвращен только для исключений.
  // Значения >=70 остаются нейтральным текстом, 40-69 и <40 получают Label;
  // null сохраняет отдельное нейтральное состояние tri-state.
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
