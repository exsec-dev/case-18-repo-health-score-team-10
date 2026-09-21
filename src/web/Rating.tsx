// Rating.tsx — страница рейтинга: здоровье, а не популярность (ТЗ 4).
// Вся выборка считается сервером (решение канвы «г»), страница только
// переводит состояние контролов в query-строку и обратно — поэтому
// отфильтрованным рейтингом можно поделиться ссылкой, и F5 его не теряет.
// Раскладка — как соседние разделы SourceCraft: крошки в ActionBar,
// тулбар одной строкой (size m), таблица, методика в правой панели.
import { BarsAscendingAlignLeft, BarsDescendingAlignLeft, Magnifier, SquareListUl } from "@gravity-ui/icons";
import {
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SortKey } from "../api/repos";
import type { MetaResponse, RatingResponse } from "./api";
import { useJson } from "./api";
import {
  CATEGORY_TITLES_RU,
  DEFINITION_NAME_WIDTH,
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
import { Page } from "./Shell";
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
  likes: "Лайки",
  forks: "Форки",
  activity: "Последняя активность",
  coverage: "Покрытие",
  scanned: "Скан",
};

/** Лайки — сортировкой и в настройке колонок, но не в виде по умолчанию: рейтинг не про популярность. */
const HIDDEN_BY_DEFAULT = ["lang", "likes", "forks", "activity", "coverage", "scanned"];

export function Rating({ search, meta }: { search: string; meta: MetaResponse | null }) {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  // view — только режим показа страницы, серверу он не нужен
  const apiSearch = useMemo(() => {
    const p = new URLSearchParams(search);
    p.delete("view");
    return p.toString();
  }, [search]);
  const { state, reload } = useJson<RatingResponse>(`/api/repos${apiSearch ? `?${apiSearch}` : ""}`);

  const sort = params.get("sort") ?? "index";
  const order = params.get("order") ?? "desc";
  const view = params.get("view") === "unscored" ? "unscored" : "scored";
  // В4.7 (П2): `lang` повторяемый; одиночная старая ссылка — набор из одного
  const langValues = params.getAll("lang").map((v) => (v === "" ? LANG_NONE : v));
  const qParam = params.get("q") ?? "";
  const hasFilters = qParam !== "" || params.has("lang");
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
    const next = new URLSearchParams(search);
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

  const data = state.kind === "ok" ? state.data : null;
  // В4.7 круг 2 (Р2.1): пока грузится новый набор, список языков строится из
  // фасетов последнего успешного ответа — иначе на время загрузки из него
  // пропадали все опции, кроме выбранных, и у тех — цвет и счётчик. Фасеты
  // от языкового фильтра не зависят, поэтому прежние верны для нового набора.
  const lastFacets = useRef<Facets>([]);
  if (data) lastFacets.current = data.facets.languages;
  // M-9: без /api/meta категории не сыплются ключами — имена из констант
  const categoryNames: Record<string, string> = useMemo(
    () => Object.fromEntries((meta?.categories ?? []).map((c) => [c.key, c.title])),
    [meta],
  );
  const titleOf = (key: string): string => categoryNames[key] ?? CATEGORY_TITLES_RU[key] ?? key;
  const categories = useMemo(() => (meta?.categories ?? []).filter((c) => !NOT_IN_RATING.has(c.key)), [meta]);
  const rankOffset = data ? (data.page - 1) * data.perPage : 0;
  const onSort = (key: SortKey, next: "asc" | "desc"): void => setParams({ sort: key, order: next });
  const allColumns = useMemo(
    () => buildColumns(categories, rankOffset, { sort, order, onSort }),
    // `onSort` пересоздаётся каждый рендер (замыкает setParams) и в список
    // зависимостей не идёт намеренно: колонки перестраивает смена самой
    // сортировки, а не идентичность обработчика
    [categories, rankOffset, sort, order],
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
        {/* flex-обертка: блочная давала полю 27.3px против 28px у соседних Select */}
        <div style={{ flex: "1 1 200px", minWidth: 200, display: "flex" }}>
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
          width={220}
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
          />
        )}
        <SegmentedRadioGroup
          size="m"
          value={view}
          onUpdate={(v) => setParams({ view: v === "unscored" ? "unscored" : null }, { keepPage: v === "scored" })}
          aria-label="Какие репозитории показать"
        >
          <SegmentedRadioGroup.Option value="scored">Оценены{data ? ` ${data.total}` : ""}</SegmentedRadioGroup.Option>
          <SegmentedRadioGroup.Option value="unscored">Без оценки{data ? ` ${data.nulls}` : ""}</SegmentedRadioGroup.Option>
        </SegmentedRadioGroup>
      </Flex>
    </Flex>
  );

  return (
    <Page
      mode="fill"
      crumbs={[{ text: "Рейтинг" }]}
      aside={<RatingAside meta={meta} generatedAt={data?.generatedAt ?? null} />}
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
      {state.kind === "loading" && <SkeletonRows rows={10} height={56} />}

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
          <NothingFound hasFilters={hasFilters} />
        ) : isPhone ? (
          <PhoneList items={data.items} rankOffset={rankOffset} />
        ) : (
          <Table
            className="rh-table-fill"
            data={data.items}
            columns={columns}
            width="max"
            verticalAlign="middle"
            // строка целиком ведет в карточку, как строки списков SourceCraft;
            // клик по самой ссылке (и Ctrl/⌘-клик) обрабатывает ссылка
            onRowClick={(item, _index, e) => {
              if ((e.target as HTMLElement).closest("a")) return;
              navigate(repoHref(item.org, item.repo));
            }}
          />
        ))}

      {data && view === "unscored" && <UnscoredTable items={data.nullItems} meta={meta} hasFilters={hasFilters} />}
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
  const about = "HealthCraft Index показывает состояние открытых репозиториев SourceCraft по 4 категориям: документация, активность, issues и состояние кода.";
  if (!meta) return about;
  const { scored, catalog } = meta.repos;
  return (
    <>
      {about}
      <br />
      Оценено {fmtCount(scored)} из {fmtCount(catalog)} репозиториев.
    </>
  );
}

function NothingFound({ hasFilters }: { hasFilters: boolean }) {
  if (!hasFilters) {
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
      description="Ни один репозиторий выборки не совпал с поиском и языком. Данные при этом на месте – сброс фильтров вернет полный рейтинг."
      actions={[{ text: "Сбросить фильтры", view: "normal", onClick: () => navigate("/") }]}
    />
  );
}

/** Группа «нет данных» — витрина закона 2: счётчик виден всегда, список — по переключателю. */
function UnscoredTable({ items, meta, hasFilters }: { items: Item[]; meta: MetaResponse | null; hasFilters: boolean }) {
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
    return hasFilters ? (
      <NothingFound hasFilters />
    ) : (
      <EmptyState icon={SquareListUl} title="Все репозитории оценены" description="Покрытия данными хватило каждому репозиторию выборки." />
    );
  }
  // Ф2.16: NULL-группа может быть огромной (весь не обходивший каталог) —
  // таблица показывает первые 5, остальное честным счётчиком «и ещё N»
  const shown = items.slice(0, 5);
  const rest = items.length - shown.length;
  const failedScan = items.some((i) => i.scanStatus === "bad");
  return (
    <Flex direction="column" gap={3}>
      <Text variant="body-1" color="complementary">
        Эти репозитории не получили HealthCraft Index. При покрытии данных ниже
        {meta ? ` ${fmtCoverage(meta.coverageNullBelow)}` : " установленного порога"} оценка не рассчитывается. Отсутствующие
        данные не учитываются как нулевые значения.
        {failedScan && " У части репозиториев последний скан завершился сбоем – для оценки он непригоден; повторный обход попробует снова."}
      </Text>
      <Table data={shown} columns={columns} width="max" verticalAlign="middle" />
      {rest > 0 && <Text color="complementary">…и еще {fmtNumber(rest)} – уточните поиск или фильтры, чтобы сузить список.</Text>}
    </Flex>
  );
}

function RatingAside({ meta, generatedAt }: { meta: MetaResponse | null; generatedAt: string | null }) {
  // В4.6 (У27): панель начинается с легенды шкалы (3 чипа + абзац) и двух блоков
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
            Доля в HealthCraft Index. Категории CI/CD и Security учитываются только в показателе Repo Health Score для
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
            {ratingCategories.map((c, i) => (
              <i key={c.key} className={`rh-contrib__seg rh-contrib__seg_${i + 1}`} style={{ width: `${c.share}%` }} />
            ))}
          </div>
          {ratingCategories.map((c, i) => (
            <div key={c.key} className="rh-contrib__row" title={`вес в HealthCraft Index – ${c.weight}`}>
              <i className={`rh-contrib__dot rh-contrib__seg_${i + 1}`} />
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
          <DefinitionList.Item name="Модель">
            <Label theme="normal" size="xs">
              {meta.modelVersion}
            </Label>
          </DefinitionList.Item>
          {/* M-7: «Данные на сегодня» врало (generatedAt = момент запроса) — честная свежесть ниже.
              В4.6 круг 2 (Р10, замечание владельца 10): пункт называется «Частота» —
              «Свежесть» обещала давность данных, а речь о периодичности обхода;
              значение и пояснение — формулировки владельца. */}
          <DefinitionList.Item name="Частота" note="Обход каталога выполняется ежесуточно. Дата последнего анализа указана в колонке «Скан»">
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

/** Сводка выбранного в поле: первые имена через запятую, остальное — «+N». */
function LangSummaryPart({ value, index, values }: { value: string; index: number; values: string[] }) {
  const shown = langSummaryNames(values);
  if (index < shown) return <>{`${index > 0 ? ", " : ""}${langTitle(value)}`}</>;
  if (index === shown) return <>{` +${values.length - shown}`}</>;
  return <></>;
}

function PhoneList({ items, rankOffset }: { items: Item[]; rankOffset: number }) {
  return (
    <ul className="rh-list">
      {items.map((item, index) => (
        <li key={`${item.org}/${item.repo}`} className="rh-list__item">
          <Flex gap={3} alignItems="center">
            <Text color="secondary" style={{ minWidth: 24, textAlign: "right" }}>
              {rankOffset + index + 1}
            </Text>
            <div style={{ flex: 1, minWidth: 0 }}>
              <RepoCell item={item} />
            </div>
            <ScoreCell item={item} />
          </Flex>
        </li>
      ))}
    </ul>
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
function RepoCell({ item }: { item: Item }) {
  return (
    <Flex gap={3} alignItems="center" style={{ minWidth: 180, maxWidth: 264 }}>
      <RepoAvatar repo={item.repo} logoUrl={item.logoUrl} size="m" />
      <Flex direction="column" gap={0} style={{ minWidth: 0 }}>
        <Link {...linkProps(repoHref(item.org, item.repo))} view="primary">
          {/* В4.6 (У27): слаг — один компонент на рейтинг и карточку */}
          <RepoSlug org={item.org} repo={item.repo} variant="subheader-1" />
        </Link>
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
}: {
  label: string;
  columnKey: SortKey;
  sort: string;
  order: string;
  onSort: (key: SortKey, next: "asc" | "desc") => void;
}) {
  const active = sort === columnKey;
  const next: "asc" | "desc" = active && order === "desc" ? "asc" : "desc";
  return (
    <Button
      view="flat"
      size="xs"
      className="rh-th-sort"
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
  rankOffset: number,
  sortProps: { sort: string; order: string; onSort: (key: SortKey, next: "asc" | "desc") => void },
): TableColumnConfig<Item>[] {
  const sortable = (label: string, columnKey: SortKey) => () => <SortableHeader label={label} columnKey={columnKey} {...sortProps} />;
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
      width: 36,
      sticky: "start",
      template: (_item: Item, index: number) => <Text color="secondary">{rankOffset + index + 1}</Text>,
    },
    { id: "repo", name: sortable("Репозиторий", "name"), primary: true, sticky: "start", template: (item: Item) => <RepoCell item={item} /> },
    { id: "index", name: sortable("HealthCraft Index", "index"), align: "end", width: 136, template: (item: Item) => <ScoreCell item={item} /> },
    ...categoryColumns,
    // В4.6 круг 2 (Р3): название языка снова стоит в строке репозитория;
    // колонка остаётся для сортируемого/копируемого вида, выключенной по умолчанию
    { id: "lang", name: "Язык", template: (item: Item) => <LanguageName name={item.language} color={item.languageColor} /> },
    { id: "likes", name: sortable("Лайки", "likes"), align: "end", template: (item: Item) => fmtNumber(item.likes) },
    { id: "forks", name: "Форки", align: "end", template: (item: Item) => fmtNumber(item.forks) },
    // не «Активность»: так называется категория Score, а это дата из каталога
    { id: "activity", name: sortable("Последняя активность", "activity"), align: "end", template: (item: Item) => fmtDate(item.lastActivityAt) },
    // колонка заведена вместе с переносом сортировки: «Покрытие данными» было
    // в списке сортировок, но своей колонки не имело — сортировать стало бы не по чему
    { id: "coverage", name: sortable("Покрытие", "coverage"), align: "end", template: (item: Item) => fmtCoverage(item.coverage) },
    {
      id: "scanned",
      name: "Скан",
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
                ? "Последний скан завершился сбоем: часть источников не ответила. Score посчитан по последнему успешному скану – сбой не понижает оценку."
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
function ScoreCell({ item }: { item: Item }) {
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
        <Label theme="warning" size="xs" title="Часть фактов взята из истории при сбое канала">
          Из истории
        </Label>
      )}
      <div className="rh-score-cell__bar">
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
      <Label theme="unknown" size="xs" title={`${NO_SCORE}: категория исключена с перенормировкой, а не занижена`}>
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
