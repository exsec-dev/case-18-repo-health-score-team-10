// ComparePage.tsx — раздел «Сравнение» (В5.3 круг 4, К-1 / К5.15).
//
// Решения — TASK.md §2 «В5.3, круг 4 — сравнение: …» (25.09, Екатерина):
// вход только третьим пунктом rail; 2-3 репозитория, чью карточку зритель
// может открыть (А2); матрица A — столбцы-репо, строки — реквизиты, индекс с
// полосой, 4 категории с подметриками в раскрытии (справочные — внутри
// «Активности»), блок «Полная оценка», если он открыт у всех; лидер строки —
// стрелка и подложка; набор — в адресе. Дизайн — `reports/2026-09-25-m53-
// compare-design.md`. Все утверждения о наборе (лидер, заметки, видимость
// строк) считает `compareView.ts`; значения подметрик, причины «нет данных» и
// поправки — те же функции, что карточка (одна копия).
//
// Таблица — CSS-грид с явной расстановкой ячеек и ролями ARIA (`role=table`):
// у Gravity `Table` нет объединенных ячеек и подстрок, а на телефоне подпись
// строки встает над ячейками — у нативной `<table>` это снимало бы роли.
import { ArrowToggle, Alert, Button, Icon, Label, Link, Progress, Skeleton, Text, TextInput } from "@gravity-ui/uikit";
import { CaretUp, CircleQuestion, Magnifier, Plus, ScalesBalanced, Xmark } from "@gravity-ui/icons";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CompareCard, CompareItem, CompareResponse } from "../api/compare";
import type { FavoriteEntry } from "../api/me";
import type { RatingResponse } from "../api/repos";
import { parseFavoriteInput } from "../api/slug-input";
import { CATEGORY_TITLES } from "../report/categories";
import { adjustmentText, analysisDate, FULL, INDEX } from "../report/sections";
import { displayOnly, submetricContext, submetricShownValue, submetricTitle } from "../report/submetrics";
import type { CategoryKey } from "../score/model";
import { dataOf, fetchJson, RequestError, type AsyncState } from "./api";
import {
  COMPARE_BAD_INPUT_TEXT,
  COMPARE_DUPLICATE_TEXT,
  COMPARE_FOOTER,
  COMPARE_FULL_PARTIAL,
  COMPARE_LEADER_LEGEND,
  COMPARE_LIMIT_TEXT,
  COMPARE_MAX,
  COMPARE_ONE_TEXT,
  COMPARE_PLACEHOLDER,
  COMPARE_TITLE,
  COMPARE_UNAVAILABLE_TITLE,
  INDEX_KEYS,
  categoriesCountedText,
  checkFailedText,
  comparabilityNotes,
  compareApiUrl,
  compareHref,
  compareSlugsOf,
  fullRows,
  indexCategoriesCounted,
  rowLeaders,
  scoredCard,
  unavailableText,
  type LeaderInput,
} from "./compareView";
import { forgetCompareSet, lastCompareSet, rememberCompareSet } from "./compareReturn";
import { NO_DATA, NO_SCORE, emptyCategoryText, fmtCount, fmtDate, fmtScore, fmtSubmetric, middleEllipsis, noScoreText, roundScore, scoreColor, scoreLabelTheme, scoreTheme, scoreWord, sentence } from "./format";
import { useMediaQuery } from "./prefs";
import { linkProps, navigate, repoHref } from "./router";
import { useSession } from "./session";
import { SLOT_EMPTY } from "./slots";
import { Page } from "./Shell";
import { EmptyState, LanguageName, PageHeader, RepoAvatar, VisibilityPill } from "./ui";

// ---------- данные ----------

/** Загрузка набора: без слагов запроса нет; смена набора держит прежнюю таблицу до ответа. */
function useCompare(slugs: string[]): { state: AsyncState<CompareResponse> | null; reload: () => void } {
  const url = slugs.length === 0 ? null : compareApiUrl(slugs);
  const [state, setState] = useState<AsyncState<CompareResponse> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (url === null) {
      setState(null);
      return;
    }
    const ctrl = new AbortController();
    setState((prev) => {
      const data = prev ? dataOf(prev) : null;
      return data ? { kind: "loading", stale: data } : { kind: "loading" };
    });
    fetchJson<CompareResponse>(url, ctrl.signal)
      .then((data) => setState({ kind: "ok", data }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        const message = e instanceof Error ? e.message : String(e);
        setState((prev) => {
          const data = prev ? dataOf(prev) : null;
          return data ? { kind: "ok", data, refreshError: message } : { kind: "error", message, status: e instanceof RequestError ? e.status : undefined };
        });
      });
    return () => ctrl.abort();
  }, [url, attempt]);
  return { state, reload: () => setAttempt((n) => n + 1) };
}

// ---------- страница ----------

export function ComparePage({ search }: { search: string }) {
  const slugs = useMemo(() => compareSlugsOf(search), [search]);
  const { me } = useSession();
  const meData = dataOf(me);
  const loggedIn = meData?.login != null;
  const hasPat = meData?.hasPat === true;

  // Д2 (§2 25.09): пункт rail без набора подставляет последний набор вкладки
  useEffect(() => {
    if (slugs.length > 0) {
      rememberCompareSet(slugs);
      return;
    }
    if (new URLSearchParams(search).getAll("r").length > 0) return;
    const last = lastCompareSet();
    if (last.length > 0) navigate(compareHref(last), { replace: true });
  }, [slugs, search]);

  const { state, reload } = useCompare(slugs);
  const data = state ? dataOf(state) : null;
  // ответ прежнего набора не рисуется под новым адресом: столбцы — по слагам запроса
  const items: CompareItem[] | null = data && sameSlugs(data.slugs, slugs) ? data.items : null;
  const loading = state?.kind === "loading";

  const setSlugs = (next: string[]) => {
    if (next.length === 0) forgetCompareSet();
    navigate(compareHref(next));
  };
  const remove = (slug: string) => setSlugs(slugs.filter((s) => s !== slug));

  const [announce, setAnnounce] = useState("");
  const add = (slug: string): string | null => {
    if (slugs.includes(slug)) return COMPARE_DUPLICATE_TEXT;
    if (slugs.length >= COMPARE_MAX) return COMPARE_LIMIT_TEXT;
    setSlugs([...slugs, slug]);
    setAnnounce(`Добавлен ${slug}. В сравнении ${slugs.length + 1} из ${COMPARE_MAX}.`);
    return null;
  };

  const shownItems = items;
  const notes = shownItems ? comparabilityNotes(shownItems) : [];
  const full = shownItems ? fullRows(shownItems) : { rows: [], partial: false };
  const error = state?.kind === "error" ? state.message : state?.kind === "ok" && state.refreshError ? state.refreshError : null;

  return (
    <Page crumbs={[{ text: "Сравнение" }]} mode="document">
      <div className="rh-cmp-page">
        <PageHeader title={COMPARE_TITLE} />
        <Picker slugs={slugs} loggedIn={loggedIn} onAdd={add} />
        <span className="rh-sr-only" aria-live="polite">
          {announce}
        </span>
        {slugs.length === 0 ? (
          <div className="rh-cmp-empty">
            <EmptyState icon={ScalesBalanced} title={SLOT_EMPTY.compare.title} description={SLOT_EMPTY.compare.text} />
          </div>
        ) : (
          <>
            {error && (
              <Alert
                theme="danger"
                view="outlined"
                className="rh-cmp-alert"
                title="Не удалось загрузить сравнение"
                message={error}
                actions={[{ text: "Повторить", handler: reload }]}
              />
            )}
            {notes.length === 1 && <Alert theme="info" view="filled" size="s" className="rh-cmp-alert" message={notes[0]} />}
            {notes.length > 1 && (
              <Alert
                theme="info"
                view="filled"
                size="s"
                className="rh-cmp-alert"
                title="Что учесть при сравнении"
                message={
                  <ul className="rh-cmp-notes">
                    {notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {shownItems ? (
              <div className={loading ? "rh-cmp-wrap rh-cmp-wrap_busy" : "rh-cmp-wrap"} aria-busy={loading}>
                <CompareTable items={shownItems} fullKeys={full.rows} hasPat={hasPat} onRemove={remove} />
              </div>
            ) : state?.kind === "error" ? null : (
              <CompareSkeleton slugs={slugs} />
            )}
            {shownItems && full.partial && (
              <Text as="p" variant="body-1" color="complementary" className="rh-cmp-foot">
                {COMPARE_FULL_PARTIAL}
              </Text>
            )}
            {shownItems && (
              <div className="rh-cmp-foot">
                {/* легенда — только когда лидер вообще возможен: 2 и больше столбца с оценкой */}
                {shownItems.filter((i) => scoredCard(i) !== null).length >= 2 && (
                  <span className="rh-cmp-legend">
                    <span className="rh-cmp-lead" aria-hidden="true">
                      <Icon data={CaretUp} size={14} />
                      84
                    </span>
                    <Text color="complementary">{COMPARE_LEADER_LEGEND}</Text>
                  </span>
                )}
                <Text as="p" color="secondary">
                  {COMPARE_FOOTER}
                </Text>
              </div>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

function sameSlugs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function CompareSkeleton({ slugs }: { slugs: string[] }) {
  return (
    <div className="rh-cmp-wrap" aria-busy="true" aria-label="Загрузка сравнения">
      <div className="rh-cmp-skeleton">
        {slugs.map((s) => (
          <div key={s} className="rh-cmp-skeleton__col">
            <Text color="secondary" className="rh-cmp-skeleton__slug">
              {s}
            </Text>
            <Skeleton style={{ height: 28, width: "100%", maxWidth: 90 }} />
            {INDEX_KEYS.map((k) => (
              <Skeleton key={k} style={{ height: 16, width: "100%", maxWidth: 60 }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- поле выбора ----------

interface Suggestion {
  slug: string;
  org: string;
  repo: string;
  section: "fav" | "rating" | "manual";
  meta: ReactNode;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Одно поле (Г1-Г3): подсказки из рейтинга, совпадения из избранного (вошедшему),
 * вставка `org/repo` или ссылки — сразу добавление. Формат проверяется по Enter,
 * не по нажатию (как окно добавления, О6).
 */
function Picker({ slugs, loggedIn, onAdd }: { slugs: string[]; loggedIn: boolean; onAdd: (slug: string) => string | null }) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState<{ q: string; items: RatingResponse["items"] } | null>(null);
  const [favorites, setFavorites] = useState<FavoriteEntry[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = useDebounced(value.trim(), 300);
  const full = slugs.length >= COMPARE_MAX;

  useEffect(() => {
    if (q === "" || parseFavoriteInput(q) !== null) {
      setRating(null);
      return;
    }
    const ctrl = new AbortController();
    fetchJson<RatingResponse>(`/api/repos?q=${encodeURIComponent(q)}&per_page=8`, ctrl.signal)
      .then((r) => setRating({ q, items: [...r.items, ...r.nullItems].slice(0, 8) }))
      .catch(() => {
        if (!ctrl.signal.aborted) setRating({ q, items: [] });
      });
    return () => ctrl.abort();
  }, [q]);

  // «Из избранного» — легкий список без сборки карточек; грузится при первом фокусе
  const loadFavorites = () => {
    if (!loggedIn || favorites !== null) return;
    fetchJson<{ entries: FavoriteEntry[] }>("/api/me/favorites")
      .then((r) => setFavorites(r.entries))
      .catch(() => setFavorites([]));
  };

  const text = value.trim();
  const lower = text.toLowerCase();
  const parsed = parseFavoriteInput(text);
  const favMatches: Suggestion[] = (favorites ?? [])
    .filter((f) => lower === "" || `${f.org}/${f.repo}`.toLowerCase().includes(lower))
    .slice(0, 8)
    .map((f) => ({ slug: `${f.org}/${f.repo}`, org: f.org, repo: f.repo, section: "fav", meta: <VisibilityPill value={f.access?.visibility} /> }));
  const ratingMatches: Suggestion[] =
    rating && rating.q === q
      ? rating.items
          .filter((r) => !favMatches.some((f) => f.slug === `${r.org}/${r.repo}`))
          .map((r) => ({
            slug: `${r.org}/${r.repo}`,
            org: r.org,
            repo: r.repo,
            section: "rating",
            meta: (
              <Text variant="body-short" color="secondary">
                {r.rank !== null ? `место ${fmtCount(r.rank)}` : "без оценки"}
              </Text>
            ),
          }))
      : [];
  const manualSlug = parsed ? `${parsed.org}/${parsed.repo}` : null;
  const manual: Suggestion[] =
    manualSlug !== null && ![...favMatches, ...ratingMatches].some((s) => s.slug === manualSlug)
      ? [{ slug: manualSlug, org: parsed!.org, repo: parsed!.repo, section: "manual", meta: null }]
      : [];
  const list = [...manual, ...favMatches, ...ratingMatches];
  const searching = q !== "" && parsed === null && (rating === null || rating.q !== q);
  const noMatches = text !== "" && parsed === null && !searching && list.length === 0;
  const showPopup = open && !full && (list.length > 0 || searching || noMatches);

  useEffect(() => setActive(0), [value, favorites, rating]);

  const choose = (s: Suggestion) => {
    if (slugs.includes(s.slug)) return;
    const err = onAdd(s.slug);
    if (err) {
      setError(err);
      return;
    }
    setValue("");
    setError(null);
  };

  const onEnter = () => {
    const pick = list[active];
    if (pick && !slugs.includes(pick.slug)) return choose(pick);
    if (text === "") return;
    if (manualSlug && slugs.includes(manualSlug)) return setError(COMPARE_DUPLICATE_TEXT);
    setError(COMPARE_BAD_INPUT_TEXT);
  };

  const listId = "rh-cmp-picker-list";
  const optionId = (i: number) => `rh-cmp-opt-${i}`;
  let lastSection: Suggestion["section"] | null = null;

  return (
    <div className="rh-cmp-picker">
      <TextInput
        size="l"
        controlRef={inputRef}
        placeholder={COMPARE_PLACEHOLDER}
        value={value}
        disabled={full}
        startContent={<Icon data={Magnifier} size={16} className="rh-add-repo__lens" />}
        hasClear
        onUpdate={(v) => {
          setValue(v);
          setError(null);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          loadFavorites();
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(0, list.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Escape") {
            if (open) setOpen(false);
            else setValue("");
          }
        }}
        controlProps={{
          role: "combobox",
          "aria-label": "Добавить репозиторий в сравнение: название, org/repo или ссылка",
          "aria-expanded": showPopup,
          "aria-controls": listId,
          "aria-activedescendant": showPopup && list[active] ? optionId(active) : undefined,
          "aria-describedby": full ? "rh-cmp-limit" : undefined,
          onPaste: (e) => {
            // вставка адреса — сразу добавление (дизайн §4.2)
            const pasted = e.clipboardData.getData("text");
            const p = parseFavoriteInput(pasted);
            if (!p) return;
            e.preventDefault();
            const err = onAdd(`${p.org}/${p.repo}`);
            if (err) {
              setValue(pasted.trim());
              setError(err);
            } else {
              setValue("");
              setError(null);
              setOpen(false);
            }
          },
        }}
        errorPlacement="outside"
        validationState={error ? "invalid" : undefined}
        errorMessage={error ?? undefined}
      />
      {full && (
        <Text as="p" id="rh-cmp-limit" variant="body-1" color="secondary" className="rh-cmp-picker__hint">
          {COMPARE_LIMIT_TEXT}
        </Text>
      )}
      {showPopup && (
        <ul className="rh-cmp-popup" id={listId} role="listbox" aria-label="Подсказки">
          {searching && list.length === 0 && (
            <li className="rh-cmp-popup__skeleton" aria-hidden="true">
              <Skeleton style={{ height: 32, width: "100%" }} />
              <Skeleton style={{ height: 32, width: "100%" }} />
            </li>
          )}
          {noMatches && (
            <li className="rh-cmp-popup__empty">
              <Text color="complementary">{`В рейтинге нет «${text}» – вставьте org/repo или ссылку.`}</Text>
            </li>
          )}
          {list.map((s, i) => {
            const head = s.section !== lastSection && s.section !== "manual" ? (s.section === "fav" ? "Из избранного" : "Рейтинг") : null;
            lastSection = s.section;
            const inSet = slugs.includes(s.slug);
            return (
              <Fragment key={`${s.section}:${s.slug}`}>
                {head && (
                  <li className="rh-cmp-popup__section" role="presentation">
                    <Text variant="caption-2" color="secondary">
                      {head}
                    </Text>
                  </li>
                )}
                <li
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={inSet}
                  className={`rh-cmp-popup__row${i === active ? " rh-cmp-popup__row_active" : ""}${inSet ? " rh-cmp-popup__row_in" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  {s.section === "manual" ? (
                    <Icon data={Plus} size={16} />
                  ) : (
                    <RepoAvatar repo={s.repo} logoUrl={null} size="xs" />
                  )}
                  <span className="rh-cmp-popup__slug" title={s.slug}>
                    {s.section === "manual" ? (
                      <>
                        Добавить <b>{s.slug}</b>
                      </>
                    ) : (
                      s.slug
                    )}
                  </span>
                  {inSet ? (
                    <Label theme="unknown" size="xs">
                      В сравнении
                    </Label>
                  ) : (
                    s.meta
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- таблица ----------

type Col =
  | { kind: "scored"; slug: string; card: CompareCard }
  | { kind: "noscore"; slug: string; card: CompareCard }
  | { kind: "refused"; slug: string; status: "unavailable" | "check_failed" | "token_rejected" }
  | { kind: "invite" };

type Row =
  | { kind: "meta"; key: "language" | "rank" | "date"; label: string }
  | { kind: "group"; label: string }
  | { kind: "index" }
  | { kind: "rhs" }
  | { kind: "category"; key: CategoryKey }
  | { kind: "subhead"; cat: CategoryKey }
  | { kind: "sub"; cat: CategoryKey; sub: string }
  | { kind: "refhead"; cat: CategoryKey };

function colsOf(items: CompareItem[]): Col[] {
  const cols: Col[] = items.map((it) => {
    if (it.status !== "ok") return { kind: "refused", slug: it.slug, status: it.status };
    return it.card.score === null ? { kind: "noscore", slug: it.slug, card: it.card } : { kind: "scored", slug: it.slug, card: it.card };
  });
  // 1 репо — второй столбец-приглашение (продуктовый Т5)
  if (items.length === 1) cols.push({ kind: "invite" });
  return cols;
}

/** Ключи подметрик категории по всем оцененным столбцам: взвешенные, затем справочные. */
function subKeysOf(cols: Col[], cat: CategoryKey): { weighted: string[]; reference: string[] } {
  const keys: string[] = [];
  for (const c of cols) {
    if (c.kind !== "scored") continue;
    const entry = c.card.score!.categories[cat];
    if (!entry || entry.locked !== undefined || entry.score === null) continue;
    for (const k of Object.keys(entry.submetrics)) if (!keys.includes(k)) keys.push(k);
  }
  return { weighted: keys.filter((k) => !displayOnly(cat, k)), reference: keys.filter((k) => displayOnly(cat, k)) };
}

function categoryOf(card: CompareCard, key: CategoryKey) {
  return card.score?.categories[key];
}

function CompareTable({ items, fullKeys, hasPat, onRemove }: { items: CompareItem[]; fullKeys: ("repoHealthScore" | "cicd" | "security")[]; hasPat: boolean; onRemove: (slug: string) => void }) {
  const phone = useMediaQuery("(max-width: 767px)");
  const cols = colsOf(items);
  // все категории свернуты при заходе (как карточка, §2 25.09)
  const [openCats, setOpenCats] = useState<ReadonlySet<CategoryKey>>(new Set());
  const toggle = (k: CategoryKey) =>
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const expandable = (key: CategoryKey): boolean => {
    const s = subKeysOf(cols, key);
    return s.weighted.length + s.reference.length > 0;
  };

  const rows: Row[] = [
    { kind: "meta", key: "language", label: "Язык" },
    { kind: "meta", key: "rank", label: "Место в рейтинге" },
    { kind: "meta", key: "date", label: "Анализ" },
    { kind: "group", label: "Оценка" },
    { kind: "index" },
  ];
  const pushCategory = (key: CategoryKey) => {
    rows.push({ kind: "category", key });
    if (!openCats.has(key) || !expandable(key)) return;
    const { weighted, reference } = subKeysOf(cols, key);
    rows.push({ kind: "subhead", cat: key });
    for (const sub of weighted) rows.push({ kind: "sub", cat: key, sub });
    if (reference.length > 0) {
      rows.push({ kind: "refhead", cat: key });
      for (const sub of reference) rows.push({ kind: "sub", cat: key, sub });
    }
  };
  for (const key of INDEX_KEYS) pushCategory(key);
  if (fullKeys.length > 0) {
    rows.push({ kind: "group", label: "Полная оценка" });
    if (fullKeys.includes("repoHealthScore")) rows.push({ kind: "rhs" });
    if (fullKeys.includes("cicd")) pushCategory("cicd");
    if (fullKeys.includes("security")) pushCategory("security");
  }

  const n = cols.length;
  // расстановка: десктоп — строка грида на строку таблицы (+1 на шапку); телефон — подпись и ячейки двумя строками грида
  const headRow = 1;
  const labelRow = (r: number) => (phone ? 2 + r * 2 : 2 + r);
  const cellRow = (r: number) => (phone ? 3 + r * 2 : 2 + r);
  const lastRow = phone ? 3 + (rows.length - 1) * 2 : 1 + rows.length;
  const at = (row: number, col: number, span = 1): CSSProperties => ({ gridRow: span > 1 ? `${row} / span ${span}` : row, gridColumn: col });
  const labelCol = phone ? "1 / -1" : 1;
  const cellCol = (i: number) => (phone ? i + 1 : i + 2);

  // подстроки раскрытой категории — для объединенной ячейки столбца без данных категории
  const subSpan = (r: number): number => {
    let k = r;
    while (k < rows.length && (rows[k]!.kind === "subhead" || rows[k]!.kind === "sub" || rows[k]!.kind === "refhead")) k++;
    return k - r;
  };

  const cells: ReactNode[] = [];

  // шапка
  cols.forEach((c, i) => {
    cells.push(
      <div key={`h${i}`} role="columnheader" className="rh-cmp-head" style={at(headRow, cellCol(i))}>
        <ColumnHead col={c} phone={phone} hasPat={hasPat} onRemove={onRemove} />
      </div>,
    );
  });

  // столбцы-исключения: одна объединенная ячейка во всю высоту (на десктопе); на телефоне текст — в шапке
  const merged = new Set<number>();
  cols.forEach((c, i) => {
    if (c.kind === "scored") return;
    merged.add(i);
    if (phone) return;
    cells.push(
      <div key={`m${i}`} role="cell" className="rh-cmp-merged-wrap" style={{ gridRow: `2 / ${lastRow + 1}`, gridColumn: cellCol(i) }}>
        <MergedCell col={c} hasPat={hasPat} />
      </div>,
    );
  });

  rows.forEach((row, r) => {
    const rowKey = `r${r}`;
    // подпись строки
    cells.push(
      <div key={`${rowKey}l`} role="rowheader" className={`rh-cmp-label rh-cmp-label_${row.kind}`} style={at(labelRow(r), labelCol as number)}>
        <RowLabel row={row} open={row.kind === "category" && openCats.has(row.key)} expandable={row.kind === "category" && expandable(row.key)} onToggle={toggle} />
      </div>,
    );
    if (row.kind === "group") return;
    const values = cols.map((c) => (c.kind === "scored" ? leaderInput(row, c.card) : undefined));
    const leaders = row.kind === "meta" || row.kind === "subhead" || row.kind === "refhead" ? cols.map(() => false) : rowLeaders(values);
    cols.forEach((c, i) => {
      if (merged.has(i)) return;
      if (c.kind !== "scored") return;
      // категория без данных у столбца: в раскрытии — одна объединенная ячейка с причиной
      if ((row.kind === "sub" || row.kind === "subhead" || row.kind === "refhead") && categoryOf(c.card, row.cat)?.score == null) {
        const first = r === 0 || !(rows[r - 1]!.kind === "subhead" || rows[r - 1]!.kind === "sub" || rows[r - 1]!.kind === "refhead");
        if (!first) return;
        const span = phone ? 1 : subSpan(r);
        cells.push(
          <div key={`${rowKey}c${i}`} role="cell" className="rh-cmp-cell rh-cmp-cell_empty-cat" style={at(cellRow(r), cellCol(i), span)}>
            <Text variant="body-1" color="complementary">
              {emptyCategoryText(row.cat, categoryOf(c.card, row.cat)?.no_data)}
            </Text>
          </div>,
        );
        return;
      }
      cells.push(
        <div key={`${rowKey}c${i}`} role="cell" className={`rh-cmp-cell rh-cmp-cell_${row.kind}`} style={at(cellRow(r), cellCol(i))}>
          <CellValue row={row} card={c.card} leader={leaders[i] === true} phone={phone} />
        </div>,
      );
    });
  });

  // разделители строк — по одному на строку таблицы (фон, а не рамки ячеек: ячейки бывают объединены)
  const lines = rows.map((row, r) => (
    <div key={`line${r}`} aria-hidden="true" className={`rh-cmp-line rh-cmp-line_${row.kind}`} style={{ gridRow: labelRow(r), gridColumn: "1 / -1" }} />
  ));

  // §2 25.09 (просмотр первого исполнения, п.4): таблица — на всю ширину экрана; столбцы репо делят остаток поровну
  const template = phone ? `repeat(${n}, minmax(0, 1fr))` : `minmax(180px, 248px) repeat(${n}, minmax(0, 1fr))`;
  return (
    <div role="table" aria-label={`${COMPARE_TITLE}: ${items.length} из ${COMPARE_MAX}`} className={phone ? "rh-cmp rh-cmp_phone" : "rh-cmp"} style={{ gridTemplateColumns: template }}>
      {!phone && <div role="columnheader" className="rh-cmp-head rh-cmp-head_corner" style={at(headRow, 1)} />}
      {lines}
      {cells}
    </div>
  );
}

/** Значение строки для лидерства: справочные и реквизиты — без лидера. */
function leaderInput(row: Row, card: CompareCard): LeaderInput {
  const score = card.score!;
  if (row.kind === "index") return score.healthcraftIndex;
  if (row.kind === "rhs") return score.repoHealthScore;
  if (row.kind === "category") {
    const cat = score.categories[row.key];
    if (!cat) return null;
    return cat.locked !== undefined ? "closed" : cat.score;
  }
  if (row.kind === "sub") {
    if (displayOnly(row.cat, row.sub)) return undefined;
    const entry = score.categories[row.cat]?.submetrics[row.sub];
    return entry?.score === null || entry?.score === undefined ? null : entry.score * 100;
  }
  return undefined;
}

function RowLabel({ row, open, expandable, onToggle }: { row: Row; open: boolean; expandable: boolean; onToggle: (k: CategoryKey) => void }) {
  switch (row.kind) {
    case "meta":
      return <Text color="secondary">{row.label}</Text>;
    case "group":
      return (
        <Text variant="subheader-2" as="h2">
          {row.label}
        </Text>
      );
    case "index":
      return <Text variant="subheader-1">{INDEX}</Text>;
    case "rhs":
      return <Text variant="subheader-1">{FULL}</Text>;
    case "category":
      return expandable ? (
        <button type="button" className="rh-cmp-toggle" aria-expanded={open} onClick={() => onToggle(row.key)}>
          <ArrowToggle direction={open ? "bottom" : "right"} size={14} />
          <Text variant="subheader-1">{CATEGORY_TITLES[row.key]}</Text>
        </button>
      ) : (
        <span className="rh-cmp-toggle rh-cmp-toggle_static">
          <span className="rh-cmp-toggle__gap" />
          <Text variant="subheader-1">{CATEGORY_TITLES[row.key]}</Text>
        </span>
      );
    case "subhead":
      return null;
    case "refhead":
      return (
        <Text variant="caption-2" color="secondary" className="rh-cmp-sublabel">
          Справочно, без веса
        </Text>
      );
    case "sub":
      return (
        <Text variant="body-1" color={displayOnly(row.cat, row.sub) ? "secondary" : "complementary"} className="rh-cmp-sublabel">
          {submetricTitle(row.cat, row.sub)}
        </Text>
      );
  }
}

/** Число с отметкой лидера: стрелка всегда; подложка — только под нейтральным числом (контраст, дизайн §6.4). */
function Lead({ leader, plain, children }: { leader: boolean; plain: boolean; children: ReactNode }) {
  if (!leader) return <>{children}</>;
  return (
    <span className={plain ? "rh-cmp-lead" : "rh-cmp-lead rh-cmp-lead_bare"}>
      <Icon data={CaretUp} size={14} />
      {children}
      <span className="rh-sr-only">, лучший балл строки</span>
    </span>
  );
}

function NoDataGlyph({ reason }: { reason: string }) {
  return (
    <Text color="secondary" className="rh-cmp-nodata" title={reason} tabIndex={0} aria-label={`${sentence(NO_DATA)}. ${reason}`}>
      —
    </Text>
  );
}

function CellValue({ row, card, leader, phone }: { row: Row; card: CompareCard; leader: boolean; phone: boolean }) {
  const score = card.score!;
  switch (row.kind) {
    case "meta":
      if (row.key === "language") return <LanguageName name={card.repo.language} color={card.repo.languageColor} />;
      if (row.key === "date") return <Text>{fmtDate(analysisDate(card))}</Text>;
      if (score.rank !== null && score.rankedTotal !== null) return <Text style={{ fontVariantNumeric: "tabular-nums" }}>{`${fmtCount(score.rank)} из ${fmtCount(score.rankedTotal)}`}</Text>;
      return (
        <Text color="secondary">{card.repo.visibility === "public" ? "без места – индекс не выставлен" : "не в публичном рейтинге"}</Text>
      );
    case "index":
    case "rhs": {
      const total = row.kind === "index" ? score.healthcraftIndex : score.repoHealthScore;
      const counted = row.kind === "index" ? indexCategoriesCounted(card) : fullCounted(card);
      const of = row.kind === "index" ? 4 : 6;
      if (total === null) {
        return (
          <span className="rh-cmp-total">
            <Label theme="unknown" size="s">
              {NO_SCORE}
            </Label>
            <Text variant="caption-2" color="secondary">
              {categoriesCountedText(counted, of)}
            </Text>
          </span>
        );
      }
      return (
        <span className="rh-cmp-total">
          <span className="rh-cmp-total__line">
            <Lead leader={leader} plain>
              <Text color={scoreColor(total)} className="rh-cmp-total__num">
                {fmtScore(total)}
              </Text>
            </Lead>
            {!phone && (
              <Label theme={scoreLabelTheme(total)} size="xs">
                {sentence(scoreWord(total))}
              </Label>
            )}
          </span>
          <span className="rh-cmp-total__bar" role="img" aria-label={`${fmtScore(total)} из 100`}>
            <Progress value={roundScore(total)} size="s" theme={scoreTheme(total)} />
          </span>
          <Text variant="caption-2" color="secondary">
            {phone ? `${sentence(scoreWord(total))}, ${categoriesCountedText(counted, of)}` : categoriesCountedText(counted, of)}
          </Text>
          {row.kind === "index" && card.markers.codeEmpty && (
            <Label theme="normal" size="xs">
              нет кода
            </Label>
          )}
        </span>
      );
    }
    case "category": {
      const cat = score.categories[row.key];
      if (!cat || cat.score === null) return <NoDataGlyph reason={emptyCategoryText(row.key, cat?.no_data)} />;
      const plain = scoreTheme(cat.score) === "success";
      const adj = adjustmentText(cat);
      return (
        <span className="rh-cmp-catcell">
          <Lead leader={leader} plain={plain}>
            {plain ? (
              <Text className="rh-cmp-cat__num">{fmtScore(cat.score)}</Text>
            ) : (
              <Label theme={scoreLabelTheme(cat.score)} size="xs" className="rh-cat-chip">
                <span className="rh-cmp-cat__chipnum">{fmtScore(cat.score)}</span>
              </Label>
            )}
          </Lead>
          {adj && (
            <span className="rh-cmp-mark" title={adj} tabIndex={0} aria-label={`Балл сжат. ${adj}`}>
              <Label theme="normal" size="xs">
                Балл сжат
              </Label>
            </span>
          )}
          {cat.stale === true && (
            <span className="rh-cmp-mark" title="Данные из прошлого анализа: источник не ответил" tabIndex={0}>
              <Label theme="warning" size="xs">
                Из истории
              </Label>
            </span>
          )}
        </span>
      );
    }
    case "subhead":
      return (
        <span className="rh-cmp-subhead">
          <span>Значение</span>
          <span>Балл</span>
        </span>
      );
    case "refhead":
      return null;
    case "sub": {
      const cat = score.categories[row.cat]!;
      const entry = cat.submetrics[row.sub];
      if (!entry) return <NoDataGlyph reason={NO_DATA} />;
      const shown = submetricShownValue(row.cat, row.sub, entry, submetricContext(score.computedAt), cat.submetrics);
      const ref = displayOnly(row.cat, row.sub);
      return (
        <span className="rh-cmp-sub">
          <Text variant="body-1" color={ref ? "secondary" : "complementary"} className="rh-cmp-sub__value">
            {shown}
          </Text>
          {!ref && (
            <span className="rh-cmp-sub__score">
              {entry.score === null || entry.score === undefined ? (
                <NoDataGlyph reason={NO_DATA} />
              ) : (
                <Lead leader={leader} plain>
                  <Text variant="body-1">{phone ? `балл ${fmtSubmetric(entry.score)}` : fmtSubmetric(entry.score)}</Text>
                </Lead>
              )}
            </span>
          )}
        </span>
      );
    }
    case "group":
      return null;
  }
}

/** «по N категориям из 6» у Repo Health Score. */
function fullCounted(card: CompareCard): number {
  const cats = card.score?.categories;
  if (!cats) return 0;
  return (Object.keys(cats) as CategoryKey[]).filter((k) => cats[k]!.locked === undefined && cats[k]!.score !== null).length;
}

function ColumnHead({ col, phone, hasPat, onRemove }: { col: Col; phone: boolean; hasPat: boolean; onRemove: (slug: string) => void }) {
  if (col.kind === "invite") {
    return (
      <span className="rh-cmp-colhead rh-cmp-colhead_invite">
        <Text variant="subheader-1" color="secondary">
          + Второй репозиторий
        </Text>
      </span>
    );
  }
  const [org, repo] = col.slug.split("/") as [string, string];
  const card = col.kind === "refused" ? null : col.card;
  const repoName = card?.repo.repo ?? repo;
  const orgName = card?.repo.org ?? org;
  const shownRepo = middleEllipsis(repoName, 56, 10);
  const remove = (
    <Button view="flat-secondary" size="m" className="rh-cmp-remove" onClick={() => onRemove(col.slug)} aria-label={`Убрать ${col.slug} из сравнения`} title="Убрать из сравнения">
      <Icon data={Xmark} size={16} />
    </Button>
  );
  return (
    <span className="rh-cmp-colhead">
      <span className="rh-cmp-colhead__top">
        {card ? (
          <RepoAvatar repo={repoName} logoUrl={card.repo.logoUrl} size={phone ? "s" : "m"} />
        ) : (
          <span className="rh-cmp-colhead__unknown" aria-hidden="true">
            <Icon data={CircleQuestion} size={phone ? 20 : 24} />
          </span>
        )}
        {remove}
      </span>
      {card ? (
        <Link {...linkProps(repoHref(orgName, repoName))} view="primary" className="rh-cmp-colhead__link" title={col.slug} aria-label={`${orgName}/${repoName}`}>
          <Text variant="caption-2" color="secondary" ellipsis className="rh-cmp-colhead__org">
            {orgName} /
          </Text>
          {phone ? (
            <FitName text={repoName} className="rh-cmp-colhead__repo rh-cmp-colhead__repo_line" />
          ) : (
            <Text variant="subheader-2" className="rh-cmp-colhead__repo">
              {shownRepo}
            </Text>
          )}
        </Link>
      ) : (
        <span className="rh-cmp-colhead__link" title={col.slug}>
          <Text variant="caption-2" color="secondary" ellipsis className="rh-cmp-colhead__org">
            {org} /
          </Text>
          {phone ? (
            <FitName text={repoName} className="rh-cmp-colhead__repo rh-cmp-colhead__repo_line" secondary />
          ) : (
            <Text variant="subheader-2" color="secondary" className="rh-cmp-colhead__repo">
              {shownRepo}
            </Text>
          )}
        </span>
      )}
      {card && (card.repo.visibility === "internal" || card.repo.visibility === "private") && <VisibilityPill value={card.repo.visibility} />}
      {/* телефон: столбец-исключение говорит о себе в шапке (объединенной ячейки в раскладке «подпись над ячейками» нет) */}
      {phone && col.kind !== "scored" && <MergedCell col={col} hasPat={hasPat} compact />}
    </span>
  );
}

/**
 * Телефон: имя репозитория одной строкой без переноса посреди слова (находка HQ
 * по макету 25.09). Не влезает — многоточие в середине, подобранное по реальной
 * ширине ячейки и шрифту: хвост (у команд хакатона — номер команды) остается
 * виден. Полное имя — в title и тексте для скринридера.
 */
function FitName({ text, className, secondary = false }: { text: string; className: string; secondary?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const width = el.clientWidth;
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx || width === 0) return setShown(text);
      ctx.font = getComputedStyle(el).font;
      if (ctx.measureText(text).width <= width) return setShown(text);
      for (let max = text.length - 1; max >= 5; max--) {
        const candidate = middleEllipsis(text, max, Math.min(8, Math.floor(max / 2)));
        if (ctx.measureText(candidate).width <= width) return setShown(candidate);
      }
      setShown(middleEllipsis(text, 5, 2));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <Text ref={ref} variant="subheader-1" color={secondary ? "secondary" : undefined} className={className} title={text}>
      <span aria-hidden="true">{shown}</span>
      <span className="rh-sr-only">{text}</span>
    </Text>
  );
}

function MergedCell({ col, hasPat, compact = false }: { col: Col; hasPat: boolean; compact?: boolean }) {
  let title: string;
  let text: ReactNode;
  if (col.kind === "invite") {
    title = COMPARE_ONE_TEXT;
    text = (
      <Button view="outlined" size="s" onClick={() => document.querySelector<HTMLInputElement>(".rh-cmp-picker input")?.focus()}>
        Выбрать репозиторий
      </Button>
    );
    return (
      <div className={compact ? "rh-cmp-merged rh-cmp-merged_invite rh-cmp-merged_compact" : "rh-cmp-merged rh-cmp-merged_invite"}>
        <Text color="complementary">{title}</Text>
        {text}
      </div>
    );
  }
  if (col.kind === "noscore") {
    const t = noScoreText(col.card.scan);
    title = t.title;
    text = t.description;
  } else if (col.kind === "refused" && col.status === "check_failed") {
    title = COMPARE_UNAVAILABLE_TITLE;
    text = checkFailedText(col.slug);
  } else if (col.kind === "refused" && col.status === "token_rejected") {
    title = "SourceCraft отклонил ваш токен";
    text = (
      <>
        {"Обновите его в "}
        <Link {...linkProps("/settings")}>Настройках</Link>.
      </>
    );
  } else {
    title = COMPARE_UNAVAILABLE_TITLE;
    text = unavailableText(hasPat);
  }
  return (
    <div className={compact ? "rh-cmp-merged rh-cmp-merged_compact" : "rh-cmp-merged"}>
      <Text variant={compact ? "body-2" : "subheader-1"}>{title}</Text>
      <Text variant="body-1" color="complementary">
        {text}
      </Text>
    </div>
  );
}
