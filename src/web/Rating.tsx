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
import { useEffect, useMemo, useState } from "react";
import type { MetaResponse, RatingResponse } from "./api";
import { useJson } from "./api";
import { NO_SCORE, fmtCoverage, fmtDate, fmtNumber, fmtScore, scanStatusText, scoreTheme } from "./format";
import { useMediaQuery } from "./prefs";
import { linkProps, navigate, repoHref } from "./router";
import { Page } from "./Shell";
import { AsideSection, EmptyState, LanguageName, PageHeader, RepoAvatar, SkeletonRows } from "./ui";

type Item = RatingResponse["items"][number];

/** «Все языки» и «язык не определён» — не значения языка, а режимы фильтра. */
const LANG_ALL = " all";
const LANG_NONE = " none";

const SORT_OPTIONS = [
  { value: "index", content: "Score" },
  { value: "likes", content: "Лайки" },
  { value: "activity", content: "Последняя активность" },
  { value: "coverage", content: "Покрытие данными" },
  { value: "name", content: "Имя (org/repo)" },
];

/**
 * CI/CD и Security в публичный рейтинг не входят: API отдаёт их в строке
 * всегда null (данные каналов с правами не публикуются), поэтому в таблице
 * рейтинга этих колонок нет — они видны на карточке участникам репозитория.
 */
const NOT_IN_RATING = new Set(["cicd", "security"]);

/** Лайки — сортировкой и в настройке колонок, но не в виде по умолчанию: рейтинг не про популярность. */
const HIDDEN_BY_DEFAULT = ["likes", "forks", "activity", "scanned"];

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
  const categories = useMemo(() => (meta?.categories ?? []).filter((c) => !NOT_IN_RATING.has(c.key)), [meta]);
  const rankOffset = data ? (data.page - 1) * data.perPage : 0;
  const allColumns = useMemo(() => buildColumns(categories, rankOffset), [categories, rankOffset]);
  const setupItems: TableColumnSetupItem[] = allColumns.map((c) => ({
    id: c.id,
    title: typeof c.name === "string" ? c.name : c.id,
    selected: !hidden.includes(c.id),
    required: c.id === "rank" || c.id === "repo" || c.id === "score",
  }));
  const columns = allColumns.filter((c) => !hidden.includes(c.id));

  const toolbar = (
    <Flex direction="column" gap={3} style={{ marginBottom: "var(--g-spacing-3)" }}>
      <Flex gap={2} wrap alignItems="center">
        {/* flex-обертка: блочная давала полю 27.3px против 28px у соседних Select */}
        <div style={{ flex: "1 1 200px", minWidth: 200, display: "flex" }}>
          <TextInput
            size="m"
            placeholder="org, repo или название"
            value={queryDraft}
            onUpdate={setQueryDraft}
            hasClear
            startContent={<Icon data={Magnifier} size={14} style={{ marginInlineStart: "var(--g-spacing-2)", color: "var(--g-color-text-secondary)" }} />}
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
          <Select
            label="Сортировка:"
            size="m"
            width={230}
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
              aria-label={order === "desc" ? "По убыванию — переключить на возрастание" : "По возрастанию — переключить на убывание"}
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
          <PageHeader
            title="Рейтинг здоровья репозиториев"
            description="Порядок задает Repo Health Score — воспроизводимая оценка, а не число лайков."
          />
          {toolbar}
        </>
      }
      footer={
        data && view === "scored" && data.total > data.perPage ? (
          <Pagination
            page={data.page}
            pageSize={data.perPage}
            total={data.total}
            pageSizeOptions={isPhone ? undefined : [10, 25, 50, 100]}
            onUpdate={(page, pageSize) => setParams({ page: String(page), per_page: String(pageSize) }, { keepPage: true })}
          />
        ) : undefined
      }
    >
      {state.kind === "loading" && <SkeletonRows rows={10} height={48} />}

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
      description="Ни один репозиторий выборки не совпал с поиском и языком. Данные при этом на месте — сброс фильтров вернет полный рейтинг."
      actions={[{ text: "Сбросить фильтры", view: "normal", onClick: () => navigate("/") }]}
    />
  );
}

/** Группа «нет данных» — витрина закона 2: счётчик виден всегда, список — по переключателю. */
function UnscoredTable({ items, meta, hasFilters }: { items: Item[]; meta: MetaResponse | null; hasFilters: boolean }) {
  const titleOf = (key: string): string => meta?.categories.find((c) => c.key === key)?.title ?? key;
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
        Эти репозитории не получили Score: покрытие данными оказалось ниже порога
        {meta ? ` ${fmtCoverage(meta.coverageNullBelow)}` : ""}. Отсутствие данных — не плохая оценка и не ноль: пока
        источники недоступны, честного числа нет.
        {failedScan && " У части репозиториев последний скан завершился сбоем — для оценки он непригоден; повторный обход попробует снова."}
      </Text>
      <Table data={shown} columns={columns} width="max" verticalAlign="middle" />
      {rest > 0 && <Text color="complementary">…и ещё {fmtNumber(rest)} — уточните поиск или фильтры, чтобы сузить список.</Text>}
    </Flex>
  );
}

function RatingAside({ meta, generatedAt }: { meta: MetaResponse | null; generatedAt: string | null }) {
  if (!meta) return <SkeletonRows rows={4} height={64} />;
  const ratingWeight = meta.categories.reduce((sum, c) => sum + (c.indexWeight ?? 0), 0);
  return (
    <>
      <AsideSection title="О рейтинге">
        <Text color="complementary">
          Публичный рейтинг считают четыре категории: {meta.categories.filter((c) => !NOT_IN_RATING.has(c.key)).map((c) => c.title).join(", ")}.
          CI/CD и Security в общий рейтинг не вкладываются — они доступны в полном Repo Health Score на карточке
          репозитория участникам с доступом к этим данным. Лайки доступны сортировкой, но никогда не выбраны по умолчанию.
        </Text>
      </AsideSection>

      <AsideSection title="Вклад категорий">
        <DefinitionList nameMaxWidth={160}>
          {meta.categories
            .filter((c) => !NOT_IN_RATING.has(c.key))
            .map((c) => (
              <DefinitionList.Item key={c.key} name={c.title}>
                <span title={`вес в HealthCraft Index — ${c.indexWeight}`}>{Math.round(((c.indexWeight ?? 0) / Math.max(1, ratingWeight)) * 100)}%</span>
              </DefinitionList.Item>
            ))}
        </DefinitionList>
        <Text variant="body-short" color="secondary">
          Доля в Score рейтинга. CI/CD и Security считаются только в полном Score на карточке.
        </Text>
      </AsideSection>

      <AsideSection title="Расчет">
        <DefinitionList nameMaxWidth={160}>
          <DefinitionList.Item name="Порог оценки" note="Без данных честного числа нет: Score не выставляется, а не занижается.">
            покрытие от {fmtCoverage(meta.coverageNullBelow)}
          </DefinitionList.Item>
          <DefinitionList.Item name="Модель">
            <Label theme="normal" size="xs">
              {meta.modelVersion}
            </Label>
          </DefinitionList.Item>
          <DefinitionList.Item name="Данные на">{fmtDate(generatedAt ?? meta.generatedAt)}</DefinitionList.Item>
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

function RepoCell({ item }: { item: Item }) {
  return (
    <Flex gap={3} alignItems="center" style={{ minWidth: 180, maxWidth: 264 }}>
      <RepoAvatar repo={item.repo} logoUrl={item.logoUrl} size="m" />
      <Flex direction="column" gap={0} style={{ minWidth: 0 }}>
        <Link {...linkProps(repoHref(item.org, item.repo))} view="primary" title={`${item.org}/${item.repo}`}>
          <Text variant="subheader-1" ellipsis style={{ display: "block" }}>
            {item.org} / {item.repo}
          </Text>
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
    { id: "score", name: "Score", align: "end", width: 96, template: (item: Item) => <ScoreCell item={item} /> },
    ...categoryColumns,
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
                ? "Последний скан завершился сбоем: часть источников не ответила. Score посчитан по последнему успешному скану — сбой не понижает оценку."
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

function ScoreCell({ item }: { item: Item }) {
  if (item.healthcraftIndex === null) {
    return (
      <Label theme="unknown" size="xs">
        {NO_SCORE}
      </Label>
    );
  }
  return (
    <Flex direction="column" gap={1} alignItems="flex-end">
      <Flex gap={2} alignItems="center">
        {item.staleFacts && (
          <Label theme="warning" size="xs" title="Часть фактов взята из истории при сбое канала">
            Из истории
          </Label>
        )}
        <Text variant="subheader-2">{fmtScore(item.healthcraftIndex)}</Text>
      </Flex>
      <div style={{ width: 64 }}>
        <Progress value={item.healthcraftIndex} size="xs" theme={scoreTheme(item.healthcraftIndex)} />
      </div>
    </Flex>
  );
}

/** Категория без данных — «—» с причиной, не ноль (закон 2). */
function CategoryCell({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <Text color="secondary" title="категория без данных: исключена с перенормировкой, а не занижена">
        —
      </Text>
    );
  }
  return <Text>{fmtScore(value)}</Text>;
}
