// ComparePage.tsx — раздел «Сравнение».
//
// 2-3 репозитория, чью карточку зритель может открыть; набор — в адресе.
// Матрица: столбцы — репозитории, строки — реквизиты, индекс с полосой,
// 4 категории с подметриками в раскрытии (справочные — внутри «Активности»),
// блок «Полная оценка», если он открыт у всех; лидер строки отмечен галочкой.
// Все утверждения о наборе считает `compareView.ts`; значения подметрик,
// причины «нет данных» и поправки — те же функции, что у карточки.
//
// Таблица — CSS-грид с явной расстановкой ячеек и ролями ARIA (`table` →
// `row` с `display: contents` → `columnheader`/`rowheader`/`cell`):
// у Gravity `Table` нет объединенных ячеек и подстрок, а на телефоне подпись
// строки встает над ячейками — у нативной `<table>` это снимало бы роли.
import { ArrowToggle, Alert, Button, Card, Dialog, Flex, HelpMark, Icon, Label, Link, Progress, Skeleton, Text, TextInput } from "@gravity-ui/uikit";
import { ArrowRight, CircleCheck, CircleQuestion, Magnifier, Plus, Xmark } from "@gravity-ui/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import type { CompareCard, CompareItem, CompareResponse } from "../api/compare";
import type { FavoriteEntry } from "../api/me";
import type { RatingResponse } from "../api/repos";
import { parseFavoriteInput } from "../api/slug-input";
import { CATEGORY_TITLES } from "../report/categories";
import { adjustmentLabel, adjustmentText, analysisDate, FULL, INDEX } from "../report/sections";
import { displayOnly, submetricContext, submetricShownParts, submetricTitle } from "../report/submetrics";
import type { RepoCard } from "../api/repos";
import { categoryBreakdown, fmtPoints, type BreakdownRow, type CategoryBreakdown } from "./categoryBreakdown";
import { submetricIcon } from "./submetricIcons";
import type { CategoryKey } from "../score/model";
import { CompareIllustration } from "./illustrations";
import { dataOf, fetchJson, RequestError, type AsyncState } from "./api";
import {
  COMPARE_ADD,
  COMPARE_BAD_INPUT_TEXT,
  COMPARE_PLACEHOLDER,
  COMPARE_DUPLICATE_TEXT,
  COMPARE_FULL_LINE,
  COMPARE_FULL_PARTIAL,
  COMPARE_LEAD,
  COMPARE_LEADER_LEGEND,
  COMPARE_LEADER_SHORT,
  COMPARE_LIMIT_TEXT,
  COMPARE_MAX,
  COMPARE_ONE_TEXT,
  COMPARE_TITLE,
  COMPARE_UNAVAILABLE_TITLE,
  INDEX_KEYS,
  categoriesCountedText,
  checkFailedText,
  commonYear,
  comparabilityNotes,
  compareApiUrl,
  compareHref,
  compareSlugsOf,
  exceptionLabel,
  fullRows,
  indexCategoriesCounted,
  metaRowLabel,
  rankCell,
  rowLeaders,
  scoredCard,
  pointsLeaderValue,
  unavailableText,
  type LeaderInput,
} from "./compareView";
import { forgetCompareSet, lastCompareSet, rememberCompareSet } from "./compareReturn";
import {
  NO_DATA,
  NO_SCORE,
  emptyCategoryText,
  fmtCount,
  fmtDate,
  fmtScore,
  noScoreText,
  roundScore,
  scoreTheme,
  scoreWord,
  sentence,
  viewerKindOf,
  type ViewerKind,
} from "./format";
import { useMediaQuery } from "./prefs";
import { linkProps, navigate, repoHref } from "./router";
import { useSession } from "./session";
import { Page } from "./Shell";
import { SLOT_EMPTY } from "./slots";
import { EmptyState, LanguageName, PageHeader, RepoAvatar, ScoreBar, VisibilityPill } from "./ui";

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
        // прежние данные остаются только для ТОГО ЖЕ набора (повтор); у нового набора
        // сбой — ошибка, иначе скелетон висел бы рядом с ней бесконечно
        setState((prev) => {
          const data = prev ? dataOf(prev) : null;
          return data && sameSlugs(data.slugs, slugs)
            ? { kind: "ok", data, refreshError: message }
            : { kind: "error", message, status: e instanceof RequestError ? e.status : undefined };
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
  // что делать с недоступным — по состоянию зрителя: гость, без токена, токен не читается, с токеном
  const viewer = viewerKindOf(meData);
  const phone = useMediaQuery("(max-width: 767px)");
  // раскладка таблицы — по ширине области контента, а не окна: на 768-1023 с
  // развернутым rail столбцам оставалось по 69px, и плашки наезжали на соседей
  const pageRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(pageRef, COMPARE_NARROW_BELOW[slugs.length >= 3 ? 3 : 2]);
  const [dialogOpen, setDialogOpen] = useState(false);

  // пункт rail без набора подставляет последний набор вкладки
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
  const [announce, setAnnounce] = useState("");
  const remove = (slug: string) => {
    setSlugs(slugs.filter((s) => s !== slug));
    setAnnounce(`Убран ${slug}.`);
  };
  const add = (slug: string): string | null => {
    if (slugs.includes(slug)) return COMPARE_DUPLICATE_TEXT;
    if (slugs.length >= COMPARE_MAX) return COMPARE_LIMIT_TEXT;
    setSlugs([...slugs, slug]);
    setAnnounce(`Добавлен ${slug}. В сравнении ${slugs.length + 1} из ${COMPARE_MAX}.`);
    if (slugs.length + 1 >= COMPARE_MAX) setDialogOpen(false);
    return null;
  };

  const notes = items ? comparabilityNotes(items) : [];
  const full = items ? fullRows(items) : { rows: [], partial: false };
  const error = state?.kind === "error" ? state.message : state?.kind === "ok" && state.refreshError ? state.refreshError : null;
  const isFull = slugs.length >= COMPARE_MAX;
  const openDialog = () => setDialogOpen(true);

  return (
    <Page crumbs={[{ text: "Сравнение" }]} mode="document">
      <div className="rh-cmp-page" ref={pageRef}>
        {/* кнопка добавления у заголовка; при 3 из 3 — строка вместо нее */}
        <PageHeader
          title={COMPARE_TITLE}
          description={
            <>
              {COMPARE_LEAD}
              {isFull && (
                <>
                  <br />
                  {COMPARE_FULL_LINE}
                </>
              )}
            </>
          }
          end={
            // при 1 репо добавление — в столбце-приглашении (одна кнопка на экране, не три)
            !isFull && slugs.length > 1 ? (
              <Button view="action" size="m" onClick={openDialog}>
                <Icon data={Plus} size={16} />
                {COMPARE_ADD}
              </Button>
            ) : undefined
          }
        />
        <span className="rh-sr-only" aria-live="polite">
          {announce}
        </span>
        <AddCompareDialog open={dialogOpen} onClose={() => setDialogOpen(false)} slugs={slugs} loggedIn={loggedIn} phone={phone} onAdd={add} />
        {slugs.length === 0 ? (
          <div className="rh-cmp-empty">
            <EmptyState
              image={CompareIllustration}
              title={SLOT_EMPTY.compare.title}
              description={SLOT_EMPTY.compare.text}
              actions={
                <Flex direction="column" alignItems="flex-start" gap={4} className="rh-cmp-empty__actions">
                  <CompareStarters loggedIn={loggedIn} sessionKnown={meData !== null || me.kind === "error"} />
                  <Button view="action" size="l" onClick={openDialog}>
                    {COMPARE_ADD}
                  </Button>
                </Flex>
              }
            />
          </div>
        ) : (
          <>
            {error && (
              <div className="rh-cmp-alert">
                <Alert theme="danger" view="outlined" title="Не удалось загрузить сравнение" message={error} actions={[{ text: "Повторить", handler: reload }]} />
              </div>
            )}
            {items ? (
              <div className={loading ? "rh-cmp-wrap rh-cmp-wrap_busy" : "rh-cmp-wrap"} aria-busy={loading}>
                {/* телефон: угловой ячейки нет — легенда строкой над таблицей */}
                {narrow && items.filter((i) => scoredCard(i) !== null).length >= 2 && (
                  <div className="rh-cmp-legend-top">
                    <LeaderLegend />
                  </div>
                )}
                <CompareTable items={items} fullKeys={full.rows} viewer={viewer} phone={narrow} legend={items.filter((i) => scoredCard(i) !== null).length >= 2} onRemove={remove} onAdd={openDialog} />
              </div>
            ) : state?.kind === "error" ? null : (
              <CompareSkeleton slugs={slugs} />
            )}
            {items && narrow && <PhoneExceptions items={items} viewer={viewer} />}
            {/* плашка по содержимому, не шире 820 */}
            {notes.length === 1 && (
              <div className="rh-cmp-alert">
                <Alert theme="info" view="filled" size="s" message={notes[0]} />
              </div>
            )}
            {notes.length > 1 && (
              <div className="rh-cmp-alert">
                <Alert
                  theme="info"
                  view="filled"
                  size="s"
                  title="Что учесть при сравнении"
                  message={
                    <ul className="rh-cmp-notes">
                      {notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  }
                />
              </div>
            )}
            {items && full.partial && (
              <Text as="p" variant="body-1" color="complementary" className="rh-cmp-foot">
                {COMPARE_FULL_PARTIAL}
              </Text>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

/**
 * Ширина области контента, ниже которой таблица — в телефонной раскладке, по числу
 * столбцов (один репозиторий с приглашением — тоже два). Подобрано замером на трех
 * репозиториях: от 1000px подписи не уже 200px (не больше двух строк), а ячейки — 220px
 * (значение не длиннее трех строк); при 640px столбцы сжимались до нечитаемых. На два
 * столбца — та же ширина столбца.
 */
const COMPARE_NARROW_BELOW: Record<2 | 3, number> = { 2: 740, 3: 1000 };

/** Уже ли элемент порога: ResizeObserver, чтобы раскладка шла от ширины контента, а не окна. */
function useNarrow(ref: { current: HTMLElement | null }, below: number): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < below);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setNarrow(el.clientWidth < below);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, below]);
  return narrow;
}

/** Готовый набор пустого сравнения: название и до 3 слагов. */
interface StarterSet {
  title: string;
  slugs: string[];
}

/**
 * Готовые наборы пустого сравнения — в пару кликов, без поиска: топ-3 рейтинга
 * всем, первые 3 из избранного вошедшему (если там хотя бы 2 с оценкой). Плитки
 * в заглушке над кнопкой; пока ответы не пришли — каркас одной плитки, затем
 * плитки все разом: раньше они проявлялись по одному, и заглушка
 * успевала выглядеть законченной. Плитка — карточка-действие Gravity
 * (`Card type="action"`), как плитки выбора у SourceCraft: название, состав
 * строкой и стрелка – что откроется по клику.
 */
function CompareStarters({ loggedIn, sessionKnown }: { loggedIn: boolean; sessionKnown: boolean }) {
  const [top, setTop] = useState<string[] | null>(null);
  const [favs, setFavs] = useState<string[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchJson<RatingResponse>("/api/repos?per_page=3", ctrl.signal)
      .then((r) => setTop(r.items.slice(0, 3).map((i) => `${i.org}/${i.repo}`)))
      .catch(() => {
        if (!ctrl.signal.aborted) setTop([]);
      });
    return () => ctrl.abort();
  }, []);
  useEffect(() => {
    // вышел — набор избранного прежнего входа не показывается
    if (!loggedIn) {
      setFavs(null);
      return;
    }
    const ctrl = new AbortController();
    fetchJson<{ entries: FavoriteEntry[] }>("/api/me/favorites", ctrl.signal)
      // только с оценкой: без нее столбец сравнения пустой
      .then((r) => setFavs(r.entries.filter((e) => e.score !== null).slice(0, COMPARE_MAX).map((e) => `${e.org}/${e.repo}`)))
      .catch(() => {
        if (!ctrl.signal.aborted) setFavs([]);
      });
    return () => ctrl.abort();
  }, [loggedIn]);
  const sets: StarterSet[] = [
    ...(favs && favs.length >= 2 ? [{ title: "Из избранного", slugs: favs }] : []),
    ...(top && top.length >= 2 ? [{ title: `Топ-${top.length} рейтинга`, slugs: top }] : []),
  ];
  // пока сессия не известна, ждем и ее: иначе топ-3 успевал показаться один,
  // а с входом плитки снова сменялись каркасом
  const pending = top === null || !sessionKnown || (loggedIn && favs === null);
  // оба запроса ответили, а наборов нет – блок не нужен
  if (!pending && sets.length === 0) return null;
  return (
    <div className="rh-cmp-starters" role="group" aria-label="Готовые наборы" aria-busy={pending}>
      {pending
        ? // один каркас: плиток может прийти и одна, и две
          <Skeleton className="rh-cmp-starter-skeleton" />
        : sets.map((set) => (
            <Card
              key={set.title}
              type="action"
              view="outlined"
              className="rh-cmp-starter"
              onClick={() => navigate(compareHref(set.slugs))}
              aria-label={`Сравнить: ${set.title.toLowerCase()} – ${set.slugs.join(", ")}`}
            >
              <div className="rh-cmp-starter__text">
                <Text variant="subheader-1">{set.title}</Text>
                <Text variant="body-short" color="secondary" className="rh-cmp-starter__slugs" title={set.slugs.join(", ")}>
                  {set.slugs.map((slug) => slug.split("/")[1] ?? slug).join(", ")}
                </Text>
              </div>
              <Icon data={ArrowRight} size={16} className="rh-cmp-starter__go" />
            </Card>
          ))}
    </div>
  );
}

function sameSlugs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function CompareSkeleton({ slugs }: { slugs: string[] }) {
  // загрузка — один большой скелетон в форме таблицы, без названий и мелких полос
  return (
    <div className="rh-cmp-wrap" aria-busy="true" aria-label={`Загрузка сравнения: ${slugs.length} из ${COMPARE_MAX}`}>
      <Skeleton className="rh-cmp-skeleton" />
    </div>
  );
}

// ---------- окно добавления (как «Добавить в избранное») ----------

interface Suggestion {
  slug: string;
  org: string;
  repo: string;
  section: "fav" | "rating" | "manual";
  logoUrl: string | null;
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
 * Окно добавления: поиск по рейтингу, «Из избранного» (вошедшему), вставка
 * org/repo или ссылки — сразу добавление. Список — в потоке окна, под полем:
 * ошибка поля им не перекрывается. Активная строка — первая
 * выбираемая; ↑↓ пропускают «В сравнении»; Enter по репо из набора — «уже в
 * сравнении», а не «не похоже на адрес». При 3 из 3 окно закрывается.
 */
function AddCompareDialog({
  open,
  onClose,
  slugs,
  loggedIn,
  phone,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  slugs: string[];
  loggedIn: boolean;
  phone: boolean;
  onAdd: (slug: string) => string | null;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [rating, setRating] = useState<{ q: string; items: RatingResponse["items"] } | null>(null);
  const [favorites, setFavorites] = useState<FavoriteEntry[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = useDebounced(value.trim(), 300);

  useEffect(() => {
    if (!open || !loggedIn || favorites !== null) return;
    fetchJson<{ entries: FavoriteEntry[] }>("/api/me/favorites")
      .then((r) => setFavorites(r.entries))
      .catch(() => setFavorites([]));
  }, [open, loggedIn, favorites]);

  useEffect(() => {
    if (!open || q === "" || parseFavoriteInput(q) !== null) {
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
  }, [q, open]);

  const close = () => {
    setValue("");
    setError(null);
    onClose();
  };

  const text = value.trim();
  const lower = text.toLowerCase();
  const parsed = parseFavoriteInput(text);
  const favMatches: Suggestion[] = (favorites ?? [])
    .filter((f) => lower === "" || `${f.org}/${f.repo}`.toLowerCase().includes(lower))
    .slice(0, 8)
    .map((f) => ({ slug: `${f.org}/${f.repo}`, org: f.org, repo: f.repo, section: "fav", logoUrl: null, meta: (
      <span className="rh-add-row__meta">
        <VisibilityPill value={f.access?.visibility} />
      </span>
    ) }));
  const ratingMatches: Suggestion[] =
    rating && rating.q === q
      ? rating.items
          .filter((r) => !favMatches.some((f) => f.slug === `${r.org}/${r.repo}`))
          .map((r) => ({
            slug: `${r.org}/${r.repo}`,
            org: r.org,
            repo: r.repo,
            section: "rating",
            logoUrl: r.logoUrl,
            // язык и место — как в строке рейтинга
            meta: (
              <span className="rh-add-row__meta">
                <Text variant="body-short" color="secondary">
                  <LanguageName name={r.language} color={r.languageColor} />
                </Text>
                <Text variant="body-short" color="secondary">
                  {r.rank !== null ? `место ${fmtCount(r.rank)}` : "без оценки"}
                </Text>
              </span>
            ),
          }))
      : [];
  const manualSlug = parsed ? `${parsed.org}/${parsed.repo}` : null;
  const manual: Suggestion[] =
    manualSlug !== null && ![...favMatches, ...ratingMatches].some((s) => s.slug === manualSlug)
      ? [{ slug: manualSlug, org: parsed!.org, repo: parsed!.repo, section: "manual", logoUrl: null, meta: null }]
      : [];
  const list = [...manual, ...favMatches, ...ratingMatches];
  const selectable = list.map((s, i) => (slugs.includes(s.slug) ? -1 : i)).filter((i) => i >= 0);
  const searching = q !== "" && parsed === null && (rating === null || rating.q !== q);
  const noMatches = text !== "" && parsed === null && !searching && list.length === 0;

  useEffect(() => setActive(selectable[0] ?? -1), [value, q, favorites, rating, slugs.join("|")]);

  const choose = (s: Suggestion) => {
    if (slugs.includes(s.slug)) return setError(COMPARE_DUPLICATE_TEXT);
    const err = onAdd(s.slug);
    if (err) return setError(err);
    setValue("");
    setError(null);
  };

  const onEnter = () => {
    // пока поиск не догнал ввод, выдача устарела — Enter ничего не добавляет
    if (parsed === null && (text !== q || searching)) return;
    const pick = active >= 0 ? list[active] : undefined;
    if (pick) return choose(pick);
    if (text === "") return;
    // адрес верный, но репо уже в наборе — не «не похоже на адрес»
    if ((manualSlug && slugs.includes(manualSlug)) || list.some((s) => slugs.includes(s.slug) && s.slug.toLowerCase() === lower)) return setError(COMPARE_DUPLICATE_TEXT);
    setError(COMPARE_BAD_INPUT_TEXT);
  };

  const step = (dir: 1 | -1) => {
    if (selectable.length === 0) return;
    const at = selectable.indexOf(active);
    const next = at === -1 ? 0 : Math.min(selectable.length - 1, Math.max(0, at + dir));
    setActive(selectable[next]!);
  };

  const listId = "rh-cmp-add-list";
  const optionId = (i: number) => `rh-cmp-add-opt-${i}`;
  let lastSection: Suggestion["section"] | null = null;

  return (
    <Dialog open={open} onClose={close} maxWidth="s" fullWidth className="rh-dialog-fit" aria-label={COMPARE_ADD} initialFocus={inputRef}>
      <Dialog.Header caption={`${COMPARE_ADD} в сравнение`} />
      <Dialog.Body>
        <Flex direction="column" gap={2} className="rh-add-repo">
          <TextInput
            size="l"
            controlRef={inputRef}
            placeholder={phone ? "Название или ссылка" : COMPARE_PLACEHOLDER}
            value={value}
            startContent={<Icon data={Magnifier} size={16} className="rh-add-repo__lens" />}
            hasClear
            onUpdate={(v) => {
              setValue(v);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                step(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                step(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                onEnter();
              }
            }}
            controlProps={{
              role: "combobox",
              "aria-label": "Поиск репозитория: название, организация/репозиторий или ссылка",
              "aria-expanded": list.length > 0,
              "aria-controls": listId,
              "aria-activedescendant": active >= 0 && list[active] ? optionId(active) : undefined,
              onPaste: (e) => {
                // вставка адреса — сразу добавление
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
                }
              },
            }}
            errorPlacement="outside"
            validationState={error ? "invalid" : undefined}
            errorMessage={error ?? undefined}
          />
          <Text variant="body-1" color="secondary">{`В сравнении ${slugs.length} из ${COMPARE_MAX}`}</Text>
          <ul className="rh-add-list" id={listId} role="listbox" aria-label="Репозитории">
            {searching && list.length === 0 && (
              <li aria-hidden="true" className="rh-cmp-add-skeleton">
                <Skeleton style={{ height: 36, width: "100%" }} />
                <Skeleton style={{ height: 36, width: "100%" }} />
              </li>
            )}
            {list.map((s, i) => {
              const head = s.section !== lastSection && s.section !== "manual" ? (s.section === "fav" ? "Из избранного" : "Рейтинг") : null;
              lastSection = s.section;
              const inSet = slugs.includes(s.slug);
              return [
                head && (
                  <li key={`h:${s.section}`} className="rh-cmp-add-section" role="presentation">
                    <Text variant="caption-2" color="secondary">
                      {head}
                    </Text>
                  </li>
                ),
                <li
                  key={`${s.section}:${s.slug}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={inSet}
                  className={`rh-add-row rh-cmp-add-row${i === active ? " rh-cmp-add-row_active" : ""}`}
                  onMouseEnter={() => !inSet && setActive(i)}
                >
                  {s.section === "manual" ? (
                    // плюс только справа (кнопка); слева — пустое место размера аватара,
                    // чтобы текст строки стоял в одну линию с остальными
                    <span className="rh-cmp-add-plus" aria-hidden="true" />
                  ) : (
                    <RepoAvatar repo={s.repo} logoUrl={s.logoUrl} size="s" />
                  )}
                  <span className="rh-add-row__main">
                    {s.section === "manual" ? (
                      <span className="rh-add-row__slug" title={s.slug}>
                        {inSet ? (
                          s.slug
                        ) : (
                          <>
                            Добавить <b>{s.slug}</b>
                          </>
                        )}
                      </span>
                    ) : (
                      // хвост имени (team-10 / team-14) и есть различие: организация — тихой
                      // строкой сверху, имя — до двух строк
                      <span className="rh-cmp-add-name" title={s.slug}>
                        <Text variant="caption-2" color="secondary" ellipsis>
                          {s.org}
                        </Text>
                        <span className="rh-cmp-add-repo" lang="en">
                          {s.repo}
                        </span>
                      </span>
                    )}
                    {s.meta}
                  </span>
                  {inSet ? (
                    <Label theme="unknown" size="xs">
                      В сравнении
                    </Label>
                  ) : (
                    <Button view="flat" size="m" onClick={() => choose(s)} aria-label={`Добавить ${s.slug} в сравнение`}>
                      <Icon data={Plus} size={16} />
                    </Button>
                  )}
                </li>,
              ];
            })}
          </ul>
          {noMatches && <Text color="complementary">{`В рейтинге нет «${text}» – вставьте ссылку на репозиторий.`}</Text>}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer textButtonCancel="Готово" onClickButtonCancel={close} />
    </Dialog>
  );
}

// ---------- таблица ----------

type Col =
  | { kind: "scored"; slug: string; card: CompareCard }
  | { kind: "noscore"; slug: string; card: CompareCard }
  | { kind: "refused"; slug: string; status: "unavailable" | "check_failed" | "token_rejected" }
  | { kind: "invite" };

type Row =
  | { kind: "meta"; key: "language" | "rank" | "date" }
  | { kind: "index" }
  | { kind: "rhs" }
  | { kind: "category"; key: CategoryKey }
  | { kind: "subhead"; cat: CategoryKey }
  | { kind: "sub"; cat: CategoryKey; sub: string };

const isSubRow = (row: Row | undefined): boolean => row !== undefined && (row.kind === "subhead" || row.kind === "sub");

function colsOf(items: CompareItem[]): Col[] {
  const cols: Col[] = items.map((it) => {
    if (it.status !== "ok") return { kind: "refused", slug: it.slug, status: it.status };
    return it.card.score === null ? { kind: "noscore", slug: it.slug, card: it.card } : { kind: "scored", slug: it.slug, card: it.card };
  });
  // 1 репо — второй столбец-приглашение
  if (items.length === 1) cols.push({ kind: "invite" });
  return cols;
}

/**
 * Ключи показателей категории по всем оцененным столбцам — только входящие в балл:
 * дополнительные (справочные) остаются на карточке.
 */
function subKeysOf(cols: Col[], cat: CategoryKey): string[] {
  const keys: string[] = [];
  for (const c of cols) {
    if (c.kind !== "scored") continue;
    const entry = c.card.score!.categories[cat];
    if (!entry || entry.locked !== undefined || entry.score === null) continue;
    for (const k of Object.keys(entry.submetrics)) if (!keys.includes(k)) keys.push(k);
  }
  return keys.filter((k) => !displayOnly(cat, k));
}

function categoryOf(card: CompareCard, key: CategoryKey) {
  return card.score?.categories[key];
}

/** Дата анализа без года (телефон): «23 сент.». */
function dateWithoutYear(iso: string | null): string {
  return fmtDate(iso).replace(/\s\d{4}$/, "");
}

function CompareTable({
  items,
  fullKeys,
  viewer,
  phone,
  legend,
  onRemove,
  onAdd,
}: {
  items: CompareItem[];
  fullKeys: ("repoHealthScore" | "cicd" | "security")[];
  viewer: ViewerKind;
  phone: boolean;
  /** легенда отметки лидера — только когда лидер возможен: 2 и больше столбца с оценкой */
  legend: boolean;
  onRemove: (slug: string) => void;
  onAdd: () => void;
}) {
  const cols = colsOf(items);
  // все категории свернуты при заходе, как на карточке
  const [openCats, setOpenCats] = useState<ReadonlySet<CategoryKey>>(new Set());
  const toggle = (k: CategoryKey) =>
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const expandable = (key: CategoryKey): boolean => subKeysOf(cols, key).length > 0;

  // общий год и общий размер рейтинга — в подписи строки: «из 29 971» в каждом столбце было повтором
  const scored = cols.filter((c): c is Extract<Col, { kind: "scored" }> => c.kind === "scored");
  const year = commonYear(scored.map((c) => analysisDate(c.card)));
  const totals = new Set(scored.map((c) => c.card.score!.rankedTotal).filter((t): t is number => t !== null));
  const sharedTotal = totals.size === 1 ? [...totals][0]! : null;
  // подсветка строки под курсором: подпись и значения далеко друг от друга
  // подсветку держит отдельный компонент: состояние здесь перерисовывало при каждом наведении
  // всю таблицу с разбивкой баллов в каждой ячейке — с раскрытыми категориями она запаздывала
  const setHover = useRef<((r: number | null) => void) | null>(null);
  const metaLabel = (key: "language" | "rank" | "date"): string => metaRowLabel(key, year, sharedTotal);

  // язык, место и дата — в самом верху, затем оценки и категории (CI/CD и
  // Безопасность — сразу за категориями индекса, без отдельного заголовка)
  const rows: Row[] = [{ kind: "meta", key: "language" }, { kind: "meta", key: "rank" }, { kind: "meta", key: "date" }, { kind: "index" }];
  if (fullKeys.includes("repoHealthScore")) rows.push({ kind: "rhs" });
  const pushCategory = (key: CategoryKey) => {
    rows.push({ kind: "category", key });
    if (!openCats.has(key) || !expandable(key)) return;
    rows.push({ kind: "subhead", cat: key });
    for (const sub of subKeysOf(cols, key)) rows.push({ kind: "sub", cat: key, sub });
  };
  for (const key of INDEX_KEYS) pushCategory(key);
  if (fullKeys.includes("cicd")) pushCategory("cicd");
  if (fullKeys.includes("security")) pushCategory("security");

  const n = cols.length;
  // расстановка: десктоп — строка грида на строку таблицы (+1 на шапку); телефон — подпись и ячейки двумя строками грида
  const headRow = 1;
  const labelRow = (r: number) => (phone ? 2 + r * 2 : 2 + r);
  const cellRow = (r: number) => (phone ? 3 + r * 2 : 2 + r);
  const lastRow = phone ? 3 + (rows.length - 1) * 2 : 1 + rows.length;
  const at = (row: number, col: number | string, span = 1): CSSProperties => ({ gridRow: span > 1 ? `${row} / span ${span}` : row, gridColumn: col });
  const labelCol = phone ? "1 / -1" : 1;
  const cellCol = (i: number) => (phone ? i + 1 : i + 2);
  const merged = new Set(cols.map((c, i) => (c.kind === "scored" ? -1 : i)).filter((i) => i >= 0));
  const firstSubId = (key: CategoryKey) => `rh-cmp-sub-${key}`;
  // пояснение к показателю (скобка вроде «доля от не менее 5 пометок») — одно на строку, у подписи
  const asideOf = (row: Row): string | null => {
    if (row.kind !== "sub") return null;
    const asides = new Set<string>();
    for (const c of scored) {
      const entry = c.card.score!.categories[row.cat]?.submetrics[row.sub];
      const a = entry ? submetricShownParts(row.cat, row.sub, entry, submetricContext(c.card.score!.computedAt)).aside : null;
      if (a !== null) asides.add(`${sentence(a)}.`);
    }
    return asides.size > 0 ? [...asides].join(" ") : null;
  };

  // оформление (aria-hidden): карточки столбцов (десктоп) и линии строк — по сегментам,
  // только по подписи и столбцам с оценкой: объединенные ячейки линии не пересекают
  const decor: ReactNode[] = [];
  if (!phone) {
    cols.forEach((c, i) =>
      decor.push(<div key={`bg${i}`} aria-hidden="true" className={c.kind === "invite" ? "rh-cmp-colcard rh-cmp-colcard_invite" : "rh-cmp-colcard"} style={{ gridRow: `1 / ${lastRow + 1}`, gridColumn: cellCol(i) }} />),
    );
  }
  rows.forEach((row, r) => {
    if (isSubRow(row)) return;
    if (phone) {
      decor.push(<div key={`ln${r}`} aria-hidden="true" className="rh-cmp-line" style={{ gridRow: labelRow(r), gridColumn: "1 / -1" }} />);
      return;
    }
    decor.push(<div key={`ln${r}l`} aria-hidden="true" className="rh-cmp-line" style={{ gridRow: labelRow(r), gridColumn: 1 }} />);
    // под шапкой линию по карточкам рисует сама шапка: она видна и при прокрутке
    if (r === 0) return;
    cols.forEach((_, i) => {
      if (merged.has(i)) return;
      decor.push(<div key={`ln${r}c${i}`} aria-hidden="true" className="rh-cmp-line rh-cmp-line_card" style={{ gridRow: labelRow(r), gridColumn: cellCol(i) }} />);
    });
  });

  const highlightOf = (r: number): { className: string; style: CSSProperties } | null => {
    const row = rows[r];
    if (row === undefined || row.kind === "subhead") return null;
    // у последнего показателя категории отступ снизу — вне подсветки
    const last = row.kind === "sub" && !isSubRow(rows[r + 1]) ? " rh-cmp-hl_last" : "";
    return { className: `rh-cmp-hl${last}`, style: { gridRow: phone ? `${labelRow(r)} / span 2` : labelRow(r), gridColumn: "1 / -1" } };
  };
  decor.push(<RowHighlight key="hl" bind={setHover} highlightOf={highlightOf} />);

  const bodyRows: ReactNode[] = rows.map((row, r) => {
    const values = cols.map((c) => (c.kind === "scored" ? leaderInput(row, c.card) : undefined));
    const leaders = row.kind === "meta" || row.kind === "subhead" ? cols.map(() => false) : rowLeaders(values);
    const firstSub = row.kind === "subhead";
    // последний показатель категории — с отступом снизу: иначе таблица сливалась со следующей категорией
    const last = row.kind === "sub" && !isSubRow(rows[r + 1]) ? " rh-cmp-row_last" : "";
    const cells: ReactNode[] = [];
    // столбцы-исключения: одна объединенная ячейка во всю высоту — в первой строке тела (десктоп)
    if (r === 0 && !phone) {
      cols.forEach((c, i) => {
        if (!merged.has(i)) return;
        cells.push(
          <div key={`m${i}`} role="cell" className="rh-cmp-merged-wrap" style={{ gridRow: `2 / ${lastRow + 1}`, gridColumn: cellCol(i) }}>
            <MergedCell col={c} viewer={viewer} />
          </div>,
        );
      });
    }
    cols.forEach((c, i) => {
      if (c.kind !== "scored") {
        // телефон: у столбца-исключения ячейки пустые (метка — в шапке, текст — под таблицей)
        if (phone) cells.push(<div key={`c${i}`} role="cell" className="rh-cmp-cell" style={at(cellRow(r), cellCol(i))} />);
        return;
      }
      // категория без данных у столбца: в первой строке показателей — «Нет данных» одной
      // строкой, причина — в подсказке; объединенная ячейка с текстом лежала на нескольких
      // строках, и подсветка строки резала ее пополам
      if (isSubRow(row) && categoryOf(c.card, (row as { cat: CategoryKey }).cat)?.score == null) {
        if (row.kind !== "sub") return;
        // остальные строки — пустой ячейкой: у каждой строки таблицы столько же ячеек,
        // иначе скринридер сбивается при переходе по столбцу
        if (rows[r - 1]?.kind !== "subhead") {
          cells.push(<div key={`c${i}`} role="cell" className={`rh-cmp-cell rh-cmp-cell_card rh-cmp-cell_sub${last}`} style={at(cellRow(r), cellCol(i))} />);
          return;
        }
        const cat = row.cat;
        const reason = emptyCategoryText(cat, categoryOf(c.card, cat)?.no_data);
        cells.push(
          <div key={`c${i}`} role="cell" className={`rh-cmp-cell rh-cmp-cell_card rh-cmp-cell_sub rh-cmp-cell_empty-cat${last}`} style={at(cellRow(r), cellCol(i))}>
            <Text variant="body-1" color="secondary" className="rh-cmp-empty-cat">
              {sentence(NO_DATA)}
              <HelpMark iconSize="s" className="rh-cmp-aside" aria-label={`Почему нет данных: ${CATEGORY_TITLES[cat]}`}>
                {reason}
              </HelpMark>
            </Text>
          </div>,
        );
        return;
      }
      cells.push(
        <div key={`c${i}`} role="cell" className={`rh-cmp-cell rh-cmp-cell_card rh-cmp-cell_${row.kind}${last}`} style={at(cellRow(r), cellCol(i))}>
          <CellValue row={row} card={c.card} leader={leaders[i] === true} phone={phone} year={year} sharedTotal={sharedTotal} />
        </div>,
      );
    });
    return (
      <div key={rowKey(row)} role="row" className="rh-cmp-row" onMouseEnter={() => setHover.current?.(r)}>
        <div role="rowheader" id={firstSub ? firstSubId((row as { cat: CategoryKey }).cat) : undefined} className={`rh-cmp-label rh-cmp-label_${row.kind}${last}`} style={at(labelRow(r), labelCol)}>
          <RowLabel
            row={row}
            metaLabel={metaLabel}
            open={row.kind === "category" && openCats.has(row.key)}
            expandable={row.kind === "category" && expandable(row.key)}
            controls={row.kind === "category" ? firstSubId(row.key) : undefined}
            onToggle={toggle}
            aside={asideOf(row)}
          />
        </div>
        {cells}
      </div>
    );
  });

  // столбец подписей гибкий: при minmax(180px, 248px) он забирал максимум раньше
  // столбцов репозиториев (на 768px – 38% ширины)
  const template = phone ? `repeat(${n}, minmax(0, 1fr))` : `minmax(140px, 0.8fr) repeat(${n}, minmax(0, 1fr))`;
  return (
    <div
      role="table"
      aria-label={`${COMPARE_TITLE}: ${items.length} из ${COMPARE_MAX}`}
      className={phone ? "rh-cmp rh-cmp_phone" : "rh-cmp"}
      style={{ gridTemplateColumns: template }}
      onMouseLeave={() => setHover.current?.(null)}
    >
      {decor}
      <div role="row" className="rh-cmp-row">
        {/* легенда — в угловой ячейке закрепленной шапки: рядом с отметками при любой прокрутке */}
        {!phone && (
          <div role="columnheader" className="rh-cmp-head rh-cmp-head_corner" style={at(headRow, 1)}>
            {/* заголовок столбца подписей — для скринридера; легенда ему не имя: у отметок
                лидера и так есть скрытое «лучший балл строки» */}
            <span className="rh-sr-only">Показатель</span>
            {legend && <LeaderLegend />}
          </div>
        )}
        {cols.map((c, i) => (
          <div key={`h${i}`} role="columnheader" className={c.kind === "invite" ? "rh-cmp-head rh-cmp-head_invite" : "rh-cmp-head"} style={at(headRow, cellCol(i))}>
            <ColumnHead col={c} phone={phone} onRemove={onRemove} onAdd={onAdd} />
          </div>
        ))}
      </div>
      {bodyRows}
    </div>
  );
}

/**
 * Ключ строки по ее смыслу, а не по позиции: раскрытие категории вставляет строки
 * выше следующих, и с ключом-индексом React пересоздавал их ячейки — полосы
 * проигрывали анимацию заново.
 */
function rowKey(row: Row): string {
  switch (row.kind) {
    case "meta":
      return `meta:${row.key}`;
    case "category":
      return `cat:${row.key}`;
    case "subhead":
      return `subhead:${row.cat}`;
    case "sub":
      return `sub:${row.cat}:${row.sub}`;
    default:
      return row.kind;
  }
}

/** Значение строки для лидерства: справочные и реквизиты — без лидера. */
function leaderInput(row: Row, card: CompareCard): LeaderInput {
  const score = card.score!;
  if (row.kind === "index") return card.markers.codeEmpty ? undefined : score.healthcraftIndex;
  if (row.kind === "rhs") return score.repoHealthScore;
  if (row.kind === "category") {
    const cat = score.categories[row.key];
    if (!cat) return null;
    return cat.locked !== undefined ? "closed" : cat.score;
  }
  if (row.kind === "sub") return pointsLeaderValue(breakdownRowOf(card, row.cat, row.sub)?.earned);
  return undefined;
}

function RowLabel({
  row,
  metaLabel,
  open,
  expandable,
  controls,
  onToggle,
  aside,
}: {
  row: Row;
  metaLabel: (key: "language" | "rank" | "date") => string;
  open: boolean;
  expandable: boolean;
  controls: string | undefined;
  onToggle: (k: CategoryKey) => void;
  /** пояснение к показателю, общее для столбцов */
  aside: string | null;
}) {
  switch (row.kind) {
    case "meta":
      return <Text color="secondary">{metaLabel(row.key)}</Text>;
    case "index":
      return <Text variant="subheader-1">{INDEX}</Text>;
    case "rhs":
      return <Text variant="subheader-1">{FULL}</Text>;
    case "category":
      return expandable ? (
        <button type="button" className="rh-cmp-toggle" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={() => onToggle(row.key)}>
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
      return <span className="rh-sr-only">Показатели категории «{CATEGORY_TITLES[row.cat]}»</span>;
    case "sub":
      return (
        <Text variant="body-1" color="complementary" className="rh-cmp-sublabel">
          {/* иконка показателя — та же, что в панели «Категории» карточки */}
          <span className="rh-cmp-subicon" aria-hidden="true">
            <Icon data={submetricIcon(row.cat, row.sub)} size={14} />
          </span>
          <span className="rh-cmp-sublabel__text">
            {submetricTitle(row.cat, row.sub)}
            {aside !== null && (
              <HelpMark iconSize="s" className="rh-cmp-aside" aria-label={`Пояснение: ${submetricTitle(row.cat, row.sub)}`}>
                {aside}
              </HelpMark>
            )}
          </span>
          {/* пунктир — от названия к значениям, как на карточке */}
          <span className="rh-cbd__lead rh-cmp-lead-dots" aria-hidden="true" />
        </Text>
      );
  }
}

/**
 * Значение с отметкой лидера: число лидера жирнее и основным цветом, у прочих —
 * приглушено. Значка нет: зеленая галочка читалась как «выполнено», а ▲ в рейтинге
 * значит «поднялся за сутки». Цвет уровня — у полосы, а не у отметки.
 */
function Lead({ leader, crown = true, iconSize = 14, children }: { leader: boolean; crown?: boolean; iconSize?: number; children: ReactNode }) {
  return (
    <span className={leader ? "rh-cmp-lead rh-cmp-lead_on" : "rh-cmp-lead"}>
      {children}
      {/* отметка лучшего в строке — зеленый круг с галочкой контуром, 14px, как до правок (корону пробовали);
          у категорий со шкалой ее ставит сама ячейка — после шкалы (crown=false) */}
      {leader && crown && <Icon data={CircleCheck} size={iconSize} className="rh-cmp-crown" />}
      {leader && <span className="rh-sr-only">, лучший балл строки</span>}
    </span>
  );
}

/** Подсветка строки под курсором — со своим состоянием, чтобы наведение не перерисовывало таблицу. */
function RowHighlight({
  bind,
  highlightOf,
}: {
  bind: MutableRefObject<((r: number | null) => void) | null>;
  highlightOf: (r: number) => { className: string; style: CSSProperties } | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    bind.current = setHover;
    return () => {
      bind.current = null;
    };
  }, [bind]);
  const hl = hover === null ? null : highlightOf(hover);
  return hl === null ? null : <div aria-hidden="true" className={hl.className} style={hl.style} />;
}

/** Легенда отметки лидера: «Жирным» само набрано жирным; полный смысл — в title. */
function LeaderLegend() {
  return (
    <span className="rh-cmp-legend" title={COMPARE_LEADER_LEGEND} aria-hidden="true">
      <Text variant="caption-2" color="secondary" className="rh-cmp-legend__text">
        <Icon data={CircleCheck} size={14} className="rh-cmp-crown" />
        {COMPARE_LEADER_SHORT}
      </Text>
    </span>
  );
}

function NoDataGlyph({ reason }: { reason: string }) {
  return (
    <Text color="secondary" className="rh-cmp-nodata" title={reason} tabIndex={0} aria-label={`${sentence(NO_DATA)}. ${reason}`}>
      –
    </Text>
  );
}

function CellValue({ row, card, leader, phone, year, sharedTotal }: { row: Row; card: CompareCard; leader: boolean; phone: boolean; year: number | null; sharedTotal: number | null }) {
  const score = card.score!;
  switch (row.kind) {
    case "meta":
      if (row.key === "language")
        return (
          <span className="rh-cmp-oneline" title={card.repo.language ?? undefined}>
            <LanguageName name={card.repo.language} color={card.repo.languageColor} />
          </span>
        );
      if (row.key === "date") {
        const at = analysisDate(card);
        return <Text>{year !== null ? dateWithoutYear(at) : fmtDate(at)}</Text>;
      }
      // место как на карточке — «#4» и «из 28 145» приглушенно (на телефоне размер — в подписи строки)
      {
        const rank = rankCell(card, sharedTotal);
        if ("none" in rank) return <Text color="secondary">{rank.none}</Text>;
        return (
          <Text style={{ fontVariantNumeric: "tabular-nums" }}>
            {rank.rank}
            {rank.total !== null && <Text color="secondary">{rank.total}</Text>}
          </Text>
        );
      }
    case "index":
    case "rhs": {
      const total = row.kind === "index" ? score.healthcraftIndex : score.repoHealthScore;
      const counted = row.kind === "index" ? indexCategoriesCounted(card) : fullCounted(card);
      const of = row.kind === "index" ? 4 : 6;
      // основа названа, только если она неполная
      const countLine = counted < of ? categoriesCountedText(counted, of) : null;
      if (total === null) {
        return (
          <span className="rh-cmp-total">
            <Label theme="unknown" size="s">
              {NO_SCORE}
            </Label>
            {countLine && (
              <Text variant="caption-2" color="secondary">
                {countLine}
              </Text>
            )}
          </span>
        );
      }
      // пустой репо — метка «нет кода» вместо слова шкалы, число нейтральное (это «оценивать
      // нечего», а не зона риска); в лидерах не участвует; основы («по N из 4») нет: индекс 0
      // по правилу методики, он не перевзвешивается
      if (row.kind === "index" && card.markers.codeEmpty) {
        return (
          <span className="rh-cmp-total">
            <span className="rh-cmp-total__line">
              <Text color="secondary" className="rh-cmp-total__num">
                {fmtScore(total)}
              </Text>
              <Label theme="unknown" size="xs">
                нет кода
              </Label>
            </span>
          </span>
        );
      }
      return (
        <span className="rh-cmp-total">
          {/* число нейтральное, уровень — цветом полосы и словом в ее подписи, как в рейтинге */}
          <span className="rh-cmp-total__line">
            {/* число индекса крупное (24px) — и отметка крупнее */}
            <Lead leader={leader} iconSize={20}>
              <Text className="rh-cmp-total__num">{fmtScore(total)}</Text>
            </Lead>
          </span>
          <span className="rh-cmp-total__bar" role="img" aria-label={`${fmtScore(total)} из 100, ${scoreWord(total)}`} title={sentence(scoreWord(total))}>
            <Progress value={roundScore(total)} size="s" theme={scoreTheme(total)} />
          </span>
          {countLine && (
            <Text variant="caption-2" color="secondary">
              {countLine}
            </Text>
          )}
        </span>
      );
    }
    case "category": {
      const cat = score.categories[row.key];
      if (!cat || cat.score === null) return <NoDataGlyph reason={emptyCategoryText(row.key, cat?.no_data)} />;
      const adj = adjustmentText(cat);
      // категория — число и серая полоса: уровень цветом несет только строка индекса,
      // цветные полосы в каждой строке спорили с ним
      return (
        <span className="rh-cmp-catcell">
          {/* галочка — у числа, полоса — отдельно: в узком столбце неразрывные
              «число, полоса, галочка» не влезали, и галочка залезала на соседа */}
          <Lead leader={leader} crown={false}>
            <Text className="rh-cmp-cat__num" title={sentence(scoreWord(cat.score))}>
              {fmtScore(cat.score)}
            </Text>
          </Lead>
          <span className="rh-cmp-total__barline rh-cmp-catcell__bar">
            <ScoreBar value={cat.score} width={phone ? 40 : 64} neutral />
            {leader && <Icon data={CircleCheck} size={14} className="rh-cmp-crown" />}
          </span>
          {adj && (
            // вместо жаргона «Балл сжат» — что именно снизило балл
            <span className="rh-cmp-mark" title={adj} tabIndex={0} aria-label={`${adjustmentLabel(cat)}. ${adj}`}>
              <Label theme="normal" size="xs">
                {adjustmentLabel(cat)}
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
      return null;
    case "sub": {
      const cat = score.categories[row.cat]!;
      const entry = cat.submetrics[row.sub];
      // пустое значение и пустой балл — «–» на своих местах (балл — у правого края подстолбца)
      // значение без скобки: пояснение, общее для строки, — у подписи (повторялось в каждом столбце)
      const parts = entry ? submetricShownParts(row.cat, row.sub, entry, submetricContext(score.computedAt)) : { value: "–", aside: null };
      const shown = parts.value;
      // прочерк балла при показанном значении — «в балл не входит» (доля тестов
      // и т. п.), а не «нет данных»: подсказка не должна спорить со значением
      const noScoreReason = parts.aside !== null && parts.aside.startsWith("в балл не входит") ? sentence(parts.aside) : shown !== "–" ? "В балл категории не входит" : NO_DATA;
      // текст слева, числа справа: значение — от левого края ячейки (под числом категории),
      // пунктир ведет к баллу; «из веса» не показываем — для сравнения важен сам балл.
      // Балл и галочка лидера — в слотах постоянной ширины: числа стоят разряд под разрядом
      const bdRow = breakdownRowOf(card, row.cat, row.sub);
      const scored = bdRow !== null && bdRow.earned !== null;
      return (
        <span className="rh-cmp-sub">
          {/* значение переносится целиком: многоточие прятало «есть» и единицы, а title на телефоне не открыть */}
          <Text variant="body-1" color="secondary" className="rh-cmp-sub__value">
            {shown}
          </Text>
          <span className="rh-cbd__lead rh-cmp-lead-dots" aria-hidden="true" />
          <span className="rh-cmp-sub__pts">
            <span className="rh-cmp-sub__earned">
              {scored ? (
                <Lead leader={leader} crown={false}>
                  <Text variant="body-1">{fmtPoints(bdRow.earned!)}</Text>
                </Lead>
              ) : (
                <NoDataGlyph reason={noScoreReason} />
              )}
            </span>
            <span className="rh-cmp-sub__crown">{scored && leader && <Icon data={CircleCheck} size={14} className="rh-cmp-crown" />}</span>
          </span>
        </span>
      );
    }
  }
}

/**
 * Разбивки категорий по карточке — один расчет на карточку и категорию: ячейки и
 * лидерство строки читают одну и ту же. Карточка — объект ответа сравнения, при
 * новом ответе кэш уходит вместе с ним.
 */
const BREAKDOWNS = new WeakMap<CompareCard, Map<CategoryKey, CategoryBreakdown | null>>();

/** Строка разбивки категории для показателя — баллы категории, как на карточке; нет — null. */
function breakdownRowOf(card: CompareCard, cat: CategoryKey, sub: string): BreakdownRow | null {
  let byCat = BREAKDOWNS.get(card);
  if (!byCat) BREAKDOWNS.set(card, (byCat = new Map()));
  if (!byCat.has(cat)) {
    // сравнение получает карточку без рекомендаций и фактов — для разбивки нужны только оценки
    byCat.set(cat, categoryBreakdown(card as unknown as RepoCard, cat));
  }
  return byCat.get(cat)?.rows.find((r) => r.sub === sub) ?? null;
}

/** «по N категориям из 6» у Repo Health Score. */
function fullCounted(card: CompareCard): number {
  const cats = card.score?.categories;
  if (!cats) return 0;
  return (Object.keys(cats) as CategoryKey[]).filter((k) => cats[k]!.locked === undefined && cats[k]!.score !== null).length;
}

function ColumnHead({ col, phone, onRemove, onAdd }: { col: Col; phone: boolean; onRemove: (slug: string) => void; onAdd: () => void }) {
  if (col.kind === "invite") {
    // шапка приглашения — кнопка, пояснение сразу под ней, а не посреди столбца
    return (
      <span className="rh-cmp-colhead rh-cmp-colhead_invite">
        <Button view="normal" size="m" onClick={onAdd}>
          <Icon data={Plus} size={16} />
          {COMPARE_ADD}
        </Button>
        <Text color="complementary">{COMPARE_ONE_TEXT}</Text>
      </span>
    );
  }
  const [org, repo] = col.slug.split("/") as [string, string];
  const card = col.kind === "refused" ? null : col.card;
  const repoName = card?.repo.repo ?? repo;
  const orgName = card?.repo.org ?? org;
  const name = (
    <>
      <Text variant={phone ? "caption-2" : "body-1"} color="secondary" ellipsis className="rh-cmp-colhead__org">
        {orgName} /
      </Text>
      <FitName text={repoName} variant={phone ? "subheader-1" : "subheader-2"} secondary={card === null} />
    </>
  );
  return (
    <span className="rh-cmp-colhead">
      <span className="rh-cmp-colhead__avatar">
        {card ? (
          <RepoAvatar repo={repoName} logoUrl={card.repo.logoUrl} size={phone ? "s" : "m"} />
        ) : (
          <span className="rh-cmp-colhead__unknown" aria-hidden="true">
            <Icon data={CircleQuestion} size={phone ? 20 : 24} />
          </span>
        )}
      </span>
      {/* в порядке Tab сначала имя (ссылка на карточку), затем «×» */}
      {card ? (
        <Link {...linkProps(repoHref(orgName, repoName))} view="primary" className="rh-cmp-colhead__link" title={col.slug}>
          {name}
        </Link>
      ) : (
        <span className="rh-cmp-colhead__link" title={col.slug}>
          {name}
        </span>
      )}
      <Button view="flat-secondary" size={phone ? "l" : "m"} className="rh-cmp-remove" onClick={() => onRemove(col.slug)} aria-label={`Убрать ${col.slug} из сравнения`} title="Убрать из сравнения">
        <Icon data={Xmark} size={16} />
      </Button>
      <span className="rh-cmp-colhead__pill">
        {card && (card.repo.visibility === "internal" || card.repo.visibility === "private") && (phone ? <VisibilityIcon value={card.repo.visibility} /> : <VisibilityPill value={card.repo.visibility} />)}
        {/* на телефоне столбец-исключение — короткая метка, полный текст — под таблицей */}
        {phone && col.kind !== "scored" && (
          <Label theme="unknown" size="xs">
            {exceptionLabel(col.kind === "noscore" ? "noscore" : col.status)}
          </Label>
        )}
      </span>
    </span>
  );
}

/** Телефон: плашка видимости без слова (88 px), слово — для скринридера и в подсказке. */
function VisibilityIcon({ value }: { value: "internal" | "private" }) {
  return (
    <span className="rh-cmp-visicon">
      <VisibilityPill value={value} />
    </span>
  );
}

/** Тексты столбцов-исключений на телефоне — под таблицей, с полным слагом. */
function PhoneExceptions({ items, viewer }: { items: CompareItem[]; viewer: ViewerKind }) {
  const lines = colsOf(items)
    .filter((c): c is Exclude<Col, { kind: "scored" } | { kind: "invite" }> => c.kind === "noscore" || c.kind === "refused")
    .map((c) => ({ slug: c.slug, ...exceptionText(c, viewer) }));
  if (lines.length === 0) return null;
  return (
    <div className="rh-cmp-foot">
      {lines.map((l) => (
        <Text key={l.slug} as="p" variant="body-1" color="complementary">
          <b>{l.slug}</b>
          {` – ${l.title.charAt(0).toLowerCase()}${l.title.slice(1)}. `}
          {l.text}
        </Text>
      ))}
    </div>
  );
}

function exceptionText(col: Exclude<Col, { kind: "scored" } | { kind: "invite" }>, viewer: ViewerKind): { title: string; text: ReactNode } {
  if (col.kind === "noscore") {
    const t = noScoreText(col.card.scan);
    return { title: t.title, text: t.description };
  }
  // владелец с доказанными правами получает «проверка не удалась», а не «не найден»
  if (col.status === "check_failed") return { title: "Не удалось проверить доступ", text: checkFailedText(col.slug) };
  if (col.status === "token_rejected")
    return {
      title: "SourceCraft отклонил ваш токен",
      text: (
        <>
          {"Обновите его в "}
          <Link {...linkProps("/settings")}>Настройках</Link>.
        </>
      ),
    };
  return { title: COMPARE_UNAVAILABLE_TITLE, text: unavailableText(viewer) };
}

let fitCanvas: HTMLCanvasElement | null = null;

/**
 * Имя репозитория до двух строк; не влезает — многоточие в конце, полное имя — в
 * title. Переносится после «-», «_», «.»; если самая длинная часть шире столбца
 * («openintegrations» в 101px на телефоне), кегль уменьшается до 11px — иначе
 * слово рвалось посреди без дефиса («openintegration / s»).
 */
function FitName({ text, variant, secondary = false }: { text: string; variant: "subheader-1" | "subheader-2"; secondary?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = (): void => {
      const cs = getComputedStyle(el);
      const ctx = (fitCanvas ??= document.createElement("canvas")).getContext("2d");
      if (!ctx) return;
      const base = variant === "subheader-2" ? 15 : 13;
      const parts = text.match(/[^-_.]+[-_.]?/g) ?? [text];
      const widest = (px: number): number => {
        ctx.font = `${cs.fontWeight} ${px}px ${cs.fontFamily}`;
        return Math.max(...parts.map((p) => ctx.measureText(p).width));
      };
      let px = base;
      while (px > 11 && widest(px) > el.clientWidth) px--;
      setSize(px === base ? null : px);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, variant]);
  return (
    <Text
      ref={ref}
      variant={variant}
      color={secondary ? "secondary" : undefined}
      ellipsis
      className="rh-cmp-colhead__repo"
      title={text}
      lang="en"
      style={size !== null ? { fontSize: size, lineHeight: `${size + 4}px` } : undefined}
    >
      {text}
    </Text>
  );
}

function MergedCell({ col, viewer }: { col: Col; viewer: ViewerKind }) {
  if (col.kind === "invite" || col.kind === "scored") return null;
  const t = exceptionText(col, viewer);
  return (
    <div className="rh-cmp-merged">
      <Text variant="subheader-1">{t.title}</Text>
      <Text variant="body-1" color="complementary">
        {t.text}
      </Text>
    </div>
  );
}
