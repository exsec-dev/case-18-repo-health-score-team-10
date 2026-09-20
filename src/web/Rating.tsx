// Rating.tsx — страница рейтинга: здоровье, а не популярность (ТЗ 4).
// Вся выборка считается сервером (решение канвы «г»), страница только
// переводит состояние контролов в query-строку и обратно — поэтому
// отфильтрованным рейтингом можно поделиться ссылкой, и F5 его не теряет.
// Раскладка — как соседние разделы SourceCraft: крошки в ActionBar,
// тулбар одной строкой (size m), таблица, методика в правой панели.
import { BarsAscendingAlignLeft, BarsDescendingAlignLeft, Magnifier, SquareListUl } from "@gravity-ui/icons";
import {
  ActionTooltip,
  Alert,
  Button,
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
  Table,
  TableColumnSetup,
  type TableColumnConfig,
  type TableColumnSetupItem,
  Text,
  TextInput,
} from "@gravity-ui/uikit";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  scoreTheme,
  scoreWord,
  sentence,
} from "./format";
import { useMediaQuery } from "./prefs";
import { linkProps, navigate, repoHref } from "./router";
import { Page } from "./Shell";
import { AsideSection, EmptyState, LanguageName, PageHeader, RepoAvatar, RepoSlug, ScoreLegend, SkeletonRows } from "./ui";

type Item = RatingResponse["items"][number];

/** «Все языки» и «язык не определён» — не значения языка, а режимы фильтра. */
const LANG_ALL = " all";
const LANG_NONE = " none";

const SORT_OPTIONS = [
  { value: "index", content: "HealthCraft Index" },
  { value: "likes", content: "Лайки" },
  { value: "activity", content: "Последняя активность" },
  { value: "coverage", content: "Покрытие данными" },
  // В4.6 (У30, замечание владельца 5): прежняя подпись называла ФОРМУ ЗАПИСИ
  // слага вместо того, по чему идёт сортировка; зрителю нужно слово, а не
  // синтаксис. Сортировка сама не менялась — только её имя в списке.
  { value: "name", content: "Название" },
];

/**
 * CI/CD и Security в публичный рейтинг не входят: API отдаёт их в строке
 * всегда null (данные каналов с правами не публикуются), поэтому в таблице
 * рейтинга этих колонок нет — они видны на карточке участникам репозитория.
 */
const NOT_IN_RATING = new Set(["cicd", "security"]);

/** Лайки — сортировкой и в настройке колонок, но не в виде по умолчанию: рейтинг не про популярность. */
const HIDDEN_BY_DEFAULT = ["lang", "likes", "forks", "activity", "scanned"];

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
  const langParam = params.has("lang") ? (params.get("lang") === "" ? LANG_NONE : params.get("lang")!) : LANG_ALL;
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

  function setParams(patch: Record<string, string | null>, opts: { replace?: boolean; keepPage?: boolean } = {}): void {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    // смена фильтра или сортировки сбрасывает страницу: иначе пользователь
    // попадает на пустую пятую страницу трёх результатов
    if (!opts.keepPage) next.delete("page");
    const qs = next.toString();
    navigate(qs === "" ? "/" : `/?${qs}`, { replace: opts.replace });
  }

  const data = state.kind === "ok" ? state.data : null;
  // M-9: без /api/meta категории не сыплются ключами — имена из констант
  const categoryNames: Record<string, string> = useMemo(
    () => Object.fromEntries((meta?.categories ?? []).map((c) => [c.key, c.title])),
    [meta],
  );
  const titleOf = (key: string): string => categoryNames[key] ?? CATEGORY_TITLES_RU[key] ?? key;
  const categories = useMemo(() => (meta?.categories ?? []).filter((c) => !NOT_IN_RATING.has(c.key)), [meta]);
  const rankOffset = data ? (data.page - 1) * data.perPage : 0;
  const allColumns = useMemo(() => buildColumns(categories, rankOffset), [categories, rankOffset]);
  const setupItems: TableColumnSetupItem[] = allColumns.map((c) => ({
    id: c.id,
    title: typeof c.name === "string" ? c.name : c.id,
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
                Поиск по владельцу, имени репозитория и названию
              </HelpMark>
            }
            controlProps={{ "aria-label": "Поиск по репозиториям" }}
          />
        </div>
        <Select
          label="Язык:"
          size="m"
          width={180}
          value={[langParam]}
          options={langOptions(data)}
          onUpdate={(v) => {
            const picked = v[0] ?? LANG_ALL;
            setParams({ lang: picked === LANG_ALL ? null : picked === LANG_NONE ? "" : picked });
          }}
        />
        <Flex>
          {/* В4.6 круг 2 (Р21, находка приёмки круга 1 / ДП8): прежние 230px
              резали собственное значение контрола («Сортировка: HealthCraft
              In…»). `width="auto"` вместо нового магического числа: контрол
              берёт ширину по содержимому, то есть НЕ РЕЖЕТ ни одну опцию — в
              том числе самую длинную («Последняя активность») и в любой теме,
              где метрика шрифта другая. Фиксированное число пришлось бы
              пересчитывать при каждой правке списка сортировок. */}
          <Select
            label="Сортировка:"
            size="m"
            width="auto"
            pin="round-brick"
            value={[sort]}
            options={SORT_OPTIONS}
            onUpdate={(v) => setParams({ sort: v[0] ?? "index" })}
          />
          <ActionTooltip title={order === "desc" ? "По убыванию" : "По возрастанию"}>
            <Button
              view="outlined"
              size="m"
              pin="brick-round"
              onClick={() => setParams({ order: order === "desc" ? "asc" : "desc" })}
              aria-label={order === "desc" ? "По убыванию – переключить на возрастание" : "По возрастанию – переключить на убывание"}
            >
              <Icon data={order === "desc" ? BarsDescendingAlignLeft : BarsAscendingAlignLeft} size={16} />
            </Button>
          </ActionTooltip>
        </Flex>
      </Flex>

      <Flex gap={2} wrap alignItems="center" justifyContent="space-between">
        <SegmentedRadioGroup
          size="m"
          value={view}
          onUpdate={(v) => setParams({ view: v === "unscored" ? "unscored" : null }, { keepPage: v === "scored" })}
          aria-label="Какие репозитории показать"
        >
          <SegmentedRadioGroup.Option value="scored">Оценены{data ? ` ${data.total}` : ""}</SegmentedRadioGroup.Option>
          <SegmentedRadioGroup.Option value="unscored">Без оценки{data ? ` ${data.nulls}` : ""}</SegmentedRadioGroup.Option>
        </SegmentedRadioGroup>
        {view === "scored" && !isPhone && (
          <TableColumnSetup
            items={setupItems}
            showStatus
            onUpdate={(updated) => setHidden(updated.filter((i) => !i.selected).map((i) => i.id))}
          />
        )}
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
      <Text color="complementary">
        Эти репозитории не получили HealthCraft Index: покрытие данными оказалось ниже порога
        {meta ? ` ${fmtCoverage(meta.coverageNullBelow)}` : ""}. Недостаточно данных для расчета оценки. Отсутствующие
        данные не приравниваются к нулевому результату.
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
  return (
    <>
      {/* В4.6 (У22): шкала — первое, что читается в панели: без неё число не с чем сравнить */}
      <ScoreLegend />

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
            репозиториев, к которым у вас есть доступ.
          </HelpMark>
        }
      >
        <DefinitionList nameMaxWidth={DEFINITION_NAME_WIDTH}>
          {meta.categories
            .filter((c) => !NOT_IN_RATING.has(c.key))
            .map((c) => (
              <DefinitionList.Item key={c.key} name={c.title}>
                <span title={`вес в HealthCraft Index – ${c.indexWeight}`}>{Math.round(((c.indexWeight ?? 0) / Math.max(1, ratingWeight)) * 100)}%</span>
              </DefinitionList.Item>
            ))}
        </DefinitionList>
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

function langOptions(data: RatingResponse | null): { value: string; content: string }[] {
  const facets = data?.facets.languages ?? [];
  return [
    { value: LANG_ALL, content: "все" },
    ...facets.map((f) => ({
      value: f.language === null ? LANG_NONE : f.language,
      content: `${f.language ?? "не определен"} (${f.count})`,
    })),
  ];
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

function buildColumns(categories: MetaResponse["categories"], rankOffset: number): TableColumnConfig<Item>[] {
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
    { id: "repo", name: "Репозиторий", primary: true, sticky: "start", template: (item: Item) => <RepoCell item={item} /> },
    { id: "index", name: "HealthCraft Index", align: "end", width: 136, template: (item: Item) => <ScoreCell item={item} /> },
    ...categoryColumns,
    // В4.6 круг 2 (Р3): название языка снова стоит в строке репозитория;
    // колонка остаётся для сортируемого/копируемого вида, выключенной по умолчанию
    { id: "lang", name: "Язык", template: (item: Item) => <LanguageName name={item.language} color={item.languageColor} /> },
    { id: "likes", name: "Лайки", align: "end", template: (item: Item) => fmtNumber(item.likes) },
    { id: "forks", name: "Форки", align: "end", template: (item: Item) => fmtNumber(item.forks) },
    // не «Активность»: так называется категория Score, а это дата из каталога
    { id: "activity", name: "Последняя активность", align: "end", template: (item: Item) => fmtDate(item.lastActivityAt) },
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
 * В4.6 круг 2 (Р3): владелец прошла по живому рейтингу — «число меньше
 * жирности, полоса чуть ниже, отступ между ними меньше». Ширины НЕ
 * пересчитываются (равенство ширин пары и заголовка владелец отменила),
 * меняются три соседних шага шкал: число `subheader-3` → `body-3` (тот же
 * кегль 17/24, обычное начертание вместо полужирного), полоса `size="s"` →
 * `"xs"` (соседний шаг ProgressSize), зазор `gap={2}` → `gap={1}`.
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
    <Flex gap={1} alignItems="center" justifyContent="flex-end">
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
  return (
    <Text style={{ fontVariantNumeric: "tabular-nums" }} title={sentence(scoreWord(value))}>
      {fmtScore(value)}
    </Text>
  );
}
