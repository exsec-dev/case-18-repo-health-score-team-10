// Каркас как у SourceCraft: rail AsideHeader (разделы сверху, внизу
// документация, настройки, тема, вход или пользователь) + страница из
// ActionBar с крошками, основной колонки и правой панели (320px).
//
// Окно не прокручивается никогда — только контейнеры страницы. Два режима Page:
//   document — основная колонка и правая панель прокручиваются каждая своим
//     контейнером; уже 1440px колонки встают друг под друга;
//   fill — данные на высоту экрана (рейтинг): шапка и футер закреплены,
//     прокручивается только область между ними; уже 1440px правая панель
//     уходит в Drawer по кнопке в ActionBar, чтобы не было второй прокрутки.
import { Archive, ArrowRightFromSquare, ArrowRightToSquare, Bars, BookOpen, Bookmark, ChartColumn, CircleInfo, Gear, Moon, ScalesBalanced, Sun, Xmark } from "@gravity-ui/icons";
import { ActionBar, AsideHeader, FooterItem, type AsideHeaderItem } from "@gravity-ui/navigation";
import { ActionTooltip, Avatar, Breadcrumbs, Button, Drawer, Flex, Icon, Skeleton, Text, useThemeValue, useToaster, type IconData } from "@gravity-ui/uikit";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { logout, type MeResponse } from "./api";
import { HealthCraftMark, PRODUCT_NAME } from "./logo";
import { useAppTheme, useMediaQuery, useRailCompact, type AppTheme } from "./prefs";
import { linkProps, loginHref, navigate } from "./router";
import { COMPARE_SET_EVENT, lastCompareSet } from "./compareReturn";

export type Section = "rating" | "repos" | "me" | "compare" | "settings" | "docs" | null;

interface SectionDef {
  id: Exclude<Section, null>;
  title: string;
  href: string;
  icon: IconData;
}

const SECTIONS: SectionDef[] = [
  { id: "rating", title: "Рейтинг", href: "/", icon: ChartColumn },
  // «Сравнение» рядом с рейтингом: оба раздела про каталог и открыты без входа.
  // У «Избранного» иконка-закладка: звезда занята кнопкой добавления в избранное.
  { id: "compare", title: "Сравнение", href: "/compare", icon: ScalesBalanced },
  // личные разделы — после каталога: сначала свои репозитории (список по токену),
  // затем избранное — то, что пользователь отметил сам
  { id: "repos", title: "Мои репозитории", href: "/repos", icon: Archive },
  { id: "me", title: "Избранное", href: "/me", icon: Bookmark },
];

const GlobalActionsContext = createContext<ReactNode>(null);
/** телефон: открыть меню разделов (кнопка в ActionBar страницы); null — меню всегда видно */
const MenuContext = createContext<(() => void) | null>(null);

export function Shell({
  section,
  me,
  meLoading = false,
  globalActions,
  children,
}: {
  section: Section;
  me: MeResponse | null;
  /** сессия еще не известна: внизу rail — заглушка, а не «Войти» */
  meLoading?: boolean;
  globalActions?: ReactNode;
  children: ReactNode;
}) {
  const isPhone = useMediaQuery("(max-width: 767px)");
  const [compactPref, setCompact] = useRailCompact();
  // телефон: rail скрыт и открывается кнопкой меню поверх страницы, как у
  // SourceCraft — полоса иконок отнимала 56px из 375 у каждой страницы
  const [menuOpen, setMenuOpen] = useState(false);
  const compact = isPhone ? !menuOpen : compactPref;
  useEffect(() => {
    if (!isPhone) setMenuOpen(false);
  }, [isPhone]);
  useEffect(() => setMenuOpen(false), [section]);
  useEffect(() => {
    if (!menuOpen) return;
    const ASIDE = '[class*="gn-aside-header__aside___"]';
    // кто открыл меню (кнопка «Меню разделов») — туда вернуть фокус при закрытии
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = (): HTMLElement[] =>
      [...document.querySelectorAll<HTMLElement>(`${ASIDE} a[href], ${ASIDE} button:not([disabled]), ${ASIDE} [tabindex]:not([tabindex="-1"])`)].filter((el) => el.offsetParent !== null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
      // Tab ходит по кругу внутри меню: страница под затемнением недоступна
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !items.includes(active as HTMLElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !items.includes(active as HTMLElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    // переход по пункту меню закрывает меню
    const onClick = (e: globalThis.MouseEvent): void => {
      const a = (e.target as Element | null)?.closest("a");
      if (a && a.closest(ASIDE)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    // фокус — в меню: иначе с клавиатуры его не пройти
    document.querySelector<HTMLElement>(`${ASIDE} a`)?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
      // фокус остался в меню или потерялся — вернуть на кнопку, которая его открыла
      const active = document.activeElement;
      if (opener?.isConnected && (active === null || active === document.body || active.closest(ASIDE) !== null)) opener.focus();
    };
  }, [menuOpen]);
  const tips = useRailTips();
  const compareCount = useCompareCount();
  // AsideHeader (navigation 6.6) не принимает role, а rail нужен ориентир
  // навигации — ставим роль на корень панели после отрисовки
  useEffect(() => {
    // классы navigation — CSS-модули с хэшем («AsideHeader-module__gn-aside-header__aside___…»)
    const aside = document.querySelector<HTMLElement>('[class*="gn-aside-header__aside___"]');
    if (aside && !aside.hasAttribute("role")) {
      aside.setAttribute("role", "navigation");
      aside.setAttribute("aria-label", "Разделы");
    }
  });

  const menuItems: AsideHeaderItem[] = SECTIONS.map((s) => {
    // у «Сравнения» — сколько репозиториев в наборе: тихой цифрой справа и в подписи узкого rail
    const count = s.id === "compare" && compareCount > 0 ? compareCount : null;
    return {
    id: s.id,
    title: s.title,
    icon: s.icon,
    href: s.href,
    // aria-label у span без роли скринридеры не читают — пояснение скрытым текстом
    rightAdornment:
      count === null ? undefined : (
        <span className="rh-rail-count">
          <span aria-hidden="true">{count}</span>
          <span className="rh-sr-only">{`, в наборе ${count}`}</span>
        </span>
      ),
    current: s.id === section,
    onItemClick: (_item, _collapsed, e) => followLink(e, s.href),
    // узкий rail: вместо одиночного тултипа — подписи всех разделов разом,
    // как MultipleTooltip у SourceCraft (в navigation 6.6.0 его нет)
    enableTooltip: false,
    itemWrapper: (params, makeItem, opts) =>
      opts.compact ? (
        <RailItem id={s.id} title={s.title} count={count} tips={tips} withBackdrop={s.id === SECTIONS[0]!.id}>
          {makeItem(params)}
        </RailItem>
      ) : (
        makeItem(params)
      ),
    };
  });

  return (
    <>
    {/* «К содержимому» — первым в Tab-обходе, виден только в фокусе: до первой строки
        рейтинга иначе 25 нажатий Tab */}
    <a
      className="rh-skip"
      href="#rh-main"
      onClick={(e) => {
        e.preventDefault();
        document.getElementById("rh-main")?.focus();
      }}
    >
      К содержимому
    </a>
    <AsideHeader
      compact={compact}
      onChangeCompact={setCompact}
      hideCollapseButton={isPhone}
      collapseTitle="Свернуть меню"
      expandTitle="Развернуть меню"
      logo={{
        text: PRODUCT_NAME,
        icon: HealthCraftMark,
        // как у SourceCraft: знак заполняет сетку 28 × 28 целиком
        iconSize: 26,
        textSize: 20,
        href: "/",
        "aria-label": `${PRODUCT_NAME} – к рейтингу`,
        onClick: (e) => followLink(e, "/"),
      }}
      menuItems={menuItems}
      renderFooter={({ compact: isCompact }) => <RailFooter me={me} meLoading={meLoading} compact={isCompact} section={section} />}
      renderContent={() => (
        <GlobalActionsContext.Provider value={globalActions ?? null}>
          <MenuContext.Provider value={isPhone ? () => setMenuOpen(true) : null}>
            <div className="rh-workspace">{children}</div>
          </MenuContext.Provider>
        </GlobalActionsContext.Provider>
      )}
      className={["rh-rail", compact ? "rh-rail_compact" : "", isPhone ? "rh-rail_phone" : "", menuOpen ? "rh-rail_open" : ""].filter(Boolean).join(" ")}
    />
    {isPhone && menuOpen && <div className="rh-rail-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
    </>
  );
}

/**
 * Затемнение под подписями разделов — как ::before у MultipleTooltip
 * SourceCraft: градиент от фона к прозрачному, размытие, прозрачность .7;
 * накрывает подписи с полями 32px сверху и снизу.
 */
function RailTipsBackdrop() {
  const [box, setBox] = useState<{ left: number; top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const items = [...document.querySelectorAll(".rh-rail-item")].map((el) => el.getBoundingClientRect());
    const rail = document.querySelector('[class*="aside-content"]')?.getBoundingClientRect();
    if (items.length === 0 || !rail) return;
    const top = Math.min(...items.map((r) => r.top)) - 32;
    const bottom = Math.max(...items.map((r) => r.bottom)) + 32;
    setBox({ left: rail.right, top, height: bottom - top });
  }, []);
  return box ? <div className="rh-rail-backdrop" style={{ left: box.left, top: box.top, height: box.height }} aria-hidden="true" /> : null;
}

/**
 * Пункт rail-действие (тема, выход): navigation рисует его ссылкой `href="#"` —
 * без href пункт выпадает из Tab-обхода. Ссылке ставится роль кнопки и пробел, как
 * у кнопки: скринридер объявляет «кнопка», пробел срабатывает.
 */
function RailAction({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const a = ref.current?.querySelector("a");
    if (!a) return;
    a.setAttribute("role", "button");
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === " ") {
        e.preventDefault();
        a.click();
      }
    };
    a.addEventListener("keydown", onKey);
    return () => a.removeEventListener("keydown", onKey);
  });
  return (
    <span ref={ref} className="rh-rail-action">
      {children}
    </span>
  );
}

/**
 * Тултип иконки узкого rail — ActionTooltip uikit, тот же, что у нижних
 * пунктов SourceCraft. Якорь — квадрат иконки: обёртка пункта в AsideHeader
 * шире rail, и без неё тултип уезжает вправо.
 */
function RailIconTip({ title, compact, children }: { title: string; compact: boolean; children: ReactNode }) {
  if (!compact) return <>{children}</>;
  return (
    <ActionTooltip title={title} placement="right">
      <div className="rh-rail-anchor">{children}</div>
    </ActionTooltip>
  );
}

interface RailTips {
  /** id пункта под курсором; null — подписи скрыты */
  active: string | null;
  show: (id: string) => void;
  hide: () => void;
}

/**
 * Подписи узкого rail: открыты, пока курсор над любым пунктом. Уход с пункта
 * закрывает с короткой задержкой — переход на соседний её отменяет, и подписи
 * не мигают, а активная «перешагивает» на новый пункт (лесенка).
 */
function useRailTips(): RailTips {
  const [active, setActive] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    active,
    show: (id) => {
      cancel();
      setActive(id);
    },
    hide: () => {
      cancel();
      timer.current = setTimeout(() => setActive(null), 80);
    },
  };
}

/**
 * Пункт узкого rail с подписью. Подпись — position: fixed по координатам
 * пункта: контейнеры AsideHeader обрезают всё, что шире 56px. Активная
 * (под курсором) подпись светлее и прижата к rail, остальные — на 12px
 * правее; сдвиг анимируется, как у SourceCraft.
 */
function RailItem({
  id,
  title,
  count,
  tips,
  withBackdrop,
  children,
}: {
  id: string;
  title: string;
  /** число у подписи (репозитории в сравнении); null – без числа */
  count: number | null;
  tips: RailTips;
  /** затемнение рисует первый пункт: внутри rail оно в том же слое, что подписи, и ниже их */
  withBackdrop: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const open = tips.active !== null;
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // от правого края самого rail: обёртка пункта в AsideHeader шире 56px
    const rail = ref.current.closest('[class*="aside-content"]')?.getBoundingClientRect();
    setPos({ left: (rail?.right ?? r.right) + 14, top: r.top + r.height / 2 });
  }, [open]);
  return (
    <div ref={ref} className="rh-rail-item" onMouseEnter={() => tips.show(id)} onMouseLeave={tips.hide}>
      {children}
      {open && withBackdrop && <RailTipsBackdrop />}
      {open && pos && (
        <span
          className={tips.active === id ? "rh-rail-tip rh-rail-tip_active" : "rh-rail-tip"}
          style={{ left: pos.left, top: pos.top }}
          aria-hidden="true"
        >
          {title}
          {count !== null && <span className="rh-rail-tip__count">{count}</span>}
        </span>
      )}
    </div>
  );
}

/** Сколько репозиториев в последнем наборе сравнения вкладки; обновляется при каждом изменении набора. */
function useCompareCount(): number {
  const [count, setCount] = useState(() => lastCompareSet().length);
  useEffect(() => {
    const update = (): void => setCount(lastCompareSet().length);
    window.addEventListener(COMPARE_SET_EVENT, update);
    return () => window.removeEventListener(COMPARE_SET_EVENT, update);
  }, []);
  return count;
}

/** Клик по пункту навигации — клиентский переход; Ctrl/⌘-клик остаётся браузеру. */
function followLink(e: MouseEvent<HTMLElement>, href: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  navigate(href);
}

function RailFooter({ me, meLoading, compact, section }: { me: MeResponse | null; meLoading: boolean; compact: boolean; section: Section }) {
  const [, setTheme] = useAppTheme();
  const resolved = useThemeValue();
  const isDark = resolved === "dark" || resolved === "dark-hc";
  const toaster = useToaster();
  // узкий rail: вместо всплывающего пункта navigation — ActionTooltip, как у SourceCraft
  const tip = (title: string) => ({
    enableTooltip: false,
    itemWrapper: (params: Parameters<NonNullable<AsideHeaderItem["itemWrapper"]>>[0], makeItem: (p: typeof params) => ReactNode) => (
      <RailIconTip title={title} compact={compact}>
        {makeItem(params)}
      </RailIconTip>
    ),
  });
  const themeTitle = isDark ? "Светлая тема" : "Темная тема";
  // пункт-действие: та же подпись, плюс роль кнопки (RailAction)
  const actionTip = (title: string) => ({
    enableTooltip: false,
    itemWrapper: (params: Parameters<NonNullable<AsideHeaderItem["itemWrapper"]>>[0], makeItem: (p: typeof params) => ReactNode) => (
      <RailAction>
        <RailIconTip title={title} compact={compact}>
          {makeItem(params)}
        </RailIconTip>
      </RailAction>
    ),
  });

  return (
    <>
      {/* regularSize — строка 40px, как нижние пункты rail SourceCraft */}
      <FooterItem
        id="docs"
        title="Документация"
        icon={BookOpen}
        href="/docs"
        current={section === "docs"}
        regularSize
        {...tip("Документация")}
        onItemClick={(_item, _collapsed, e) => followLink(e, "/docs")}
      />
      <FooterItem
        id="settings"
        title="Настройки"
        icon={Gear}
        href="/settings"
        current={section === "settings"}
        regularSize
        {...tip("Настройки")}
        onItemClick={(_item, _collapsed, e) => followLink(e, "/settings")}
      />
      <FooterItem
        id="theme"
        title={themeTitle}
        icon={isDark ? Sun : Moon}
        regularSize
        {...actionTip(themeTitle)}
        // пункт без href рисуется не ссылкой и выпадает из Tab-обхода —
        // «#» делает его фокусируемым, переход по нему гасится
        href="#"
        onItemClick={(_item, _collapsed, e) => {
          e.preventDefault();
          switchTheme(setTheme, isDark ? "light" : "dark");
        }}
      />
      {/* выход — обычным пунктом под темой: виден всегда, без скрытых меню */}
      {me?.login && (
        <FooterItem
          id="logout"
          title="Выйти"
          icon={ArrowRightFromSquare}
          regularSize
          {...actionTip("Выйти")}
          href="#"
          onItemClick={(_item, _collapsed, e) => {
            e.preventDefault();
            void logout().catch((err: unknown) => toaster.add(logoutFailedToast(err)));
          }}
        />
      )}
      <div className={compact ? "rh-rail-account rh-rail-account_compact" : "rh-rail-account"}>
        {/* пока /api/me не ответил, вошедший видел «Войти», и низ rail перестраивался */}
        {me?.login ? <RailUser me={me} /> : meLoading ? <Skeleton className="rh-rail-account__skeleton" /> : <LoginButton compact={compact} />}
      </div>
    </>
  );
}

/**
 * Вход — главный акцент rail (view="action", белая в темной теме).
 * Та же кнопка стоит под закрытым Repo Health Score карточки: `inline` дает
 * ей ширину по тексту и полную подпись.
 */
export function LoginButton({ compact, inline = false }: { compact: boolean; inline?: boolean }) {
  const button = (
    <Button
      view="action"
      size={inline ? "m" : "l"}
      width={compact || inline ? "auto" : "max"}
      href="/auth/ya"
      // после входа возвращаемся на текущую страницу; адрес берется в момент
      // нажатия, потому что кнопка rail не перерисовывается при переходах.
      // Сервер принимает только путь своего сайта
      onClick={(e: MouseEvent<HTMLElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        window.location.assign(loginHref(window.location.pathname, window.location.search));
      }}
      aria-label="Войти через Я ID"
      // узкий rail: квадрат 36×36 — ширина не зависит от колонки футера
      style={compact ? { width: 36, flexShrink: 0 } : undefined}
    >
      <Icon data={ArrowRightToSquare} size={16} />
      {(inline || !compact) && "Войти"}
    </Button>
  );
  return compact ? (
    <ActionTooltip title="Войти через Я ID" placement="right">
      {button}
    </ActionTooltip>
  ) : (
    button
  );
}

/**
 * Смена темы одним кадром-переходом (View Transitions): весь экран плавно
 * перетекает в новую тему, а собственные CSS-переходы компонентов на это время
 * выключены — иначе одни элементы меняют цвет с анимацией, другие мгновенно.
 * Без поддержки API или при reduced motion — мгновенно, тоже без переходов.
 */
function switchTheme(setTheme: (next: AppTheme) => void, next: AppTheme): void {
  const root = document.documentElement;
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.classList.add("rh-theme-switching");
  const done = () => root.classList.remove("rh-theme-switching");
  if (!doc.startViewTransition || reduced) {
    flushSync(() => setTheme(next));
    requestAnimationFrame(done);
    return;
  }
  const transition = doc.startViewTransition(() => flushSync(() => setTheme(next)));
  // вкладка не отрисовывается (фон, скрытая панель) — переход прерывается, но
  // тема уже применена колбэком; отказ промисов — не ошибка приложения
  transition.ready.catch(() => {});
  transition.finished.catch(() => {}).finally(done);
}

/**
 * Пользователь внизу rail. Аватар 32px стоит на оси иконок rail в обоих
 * видах, высота блока одна — при раскрытии rail ничего не прыгает.
 */
function RailUser({ me }: { me: MeResponse }) {
  const login = me.login!;
  const name = displayName(me);
  return (
    <div className="rh-rail-user">
      <UserAvatar me={me} size="m" />
      <Flex direction="column" className="rh-rail-user__text">
        <Text ellipsis>{name}</Text>
        {name !== login && (
          <Text color="secondary" ellipsis>
            {login}
          </Text>
        )}
      </Flex>
    </div>
  );
}

export function logoutFailedToast(e: unknown) {
  return { name: "logout-failed", theme: "danger" as const, title: "Не удалось выйти", content: e instanceof Error ? e.message : String(e) };
}

/** Имя для показа: короткое ФИО, а если его нет (или оно равно логину Я ID) — логин. */
export function displayName(me: MeResponse): string {
  const login = me.login ?? "";
  return me.displayName && me.displayName !== login ? (shortName(me.displayName) ?? login) : login;
}

/** Аватар пользователя: портрет Я ID или инициалы. */
export function UserAvatar({ me, size = "l" }: { me: MeResponse; size?: "m" | "l" }) {
  const text = me.displayName ?? me.login ?? "?";
  return me.avatarUrl ? (
    <Avatar size={size} shape="square" imgUrl={me.avatarUrl} alt="" style={{ flexShrink: 0 }} />
  ) : (
    <Avatar size={size} shape="square" text={text} theme="normal" style={{ flexShrink: 0 }} />
  );
}

/** «Иван Петров» → «Иван П.», как в меню пользователя SourceCraft. */
export function shortName(full: string | null): string | null {
  if (!full) return null;
  const [first, second] = full.trim().split(/\s+/);
  if (!first) return null;
  return second ? `${first} ${second[0]!.toUpperCase()}.` : first;
}

export interface Crumb {
  text: string;
  href?: string;
}

/**
 * Состояние правой панели для страницы: ссылка «Как считается» в тексте
 * открывает ту же панель, что кнопка ActionBar.
 */
interface AsideControl {
  /** панель сейчас в Drawer (узкий экран и страница включила `asideDrawer`) */
  inDrawer: boolean;
  open: () => void;
}

const AsideControlContext = createContext<AsideControl>({ inDrawer: false, open: () => {} });

export function useAsideControl(): AsideControl {
  return useContext(AsideControlContext);
}

/** Показать правую панель: в Drawer — открыть, колонкой — прокрутить к ней. */
export function showAside(control: AsideControl): void {
  if (control.inDrawer) {
    control.open();
    return;
  }
  // панель уже видна колонкой, и одной прокрутки часто не заметно —
  // коротко подсвечиваем ее рамкой, чтобы взгляд перешел к ней
  const panel = document.querySelector<HTMLElement>(".rh-page__aside");
  if (!panel) return;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  panel.classList.remove("rh-page__aside_flash");
  void panel.offsetWidth;
  panel.classList.add("rh-page__aside_flash");
  window.setTimeout(() => panel.classList.remove("rh-page__aside_flash"), 1600);
}

interface PageProps {
  crumbs: Crumb[];
  actions?: ReactNode;
  aside?: ReactNode;
  /**
   * Выезжающая панель на узких экранах для режима `document` (в `fill` она
   * всегда выезжающая). Без флага панель уходит под основную колонку.
   */
  asideDrawer?: boolean;
  /** Ширина, с которой панель стоит колонкой (по умолчанию 1440). */
  asideColumnFrom?: number;
  /** document (по умолчанию) — колонки прокручиваются; fill — данные на высоту экрана */
  mode?: "document" | "fill";
  /** fill: закреплено над прокручиваемой областью */
  header?: ReactNode;
  /** fill: закреплено под прокручиваемой областью */
  footer?: ReactNode;
  children: ReactNode;
}

export function Page({ crumbs, actions, aside, asideDrawer = false, asideColumnFrom = 1440, mode = "document", header, footer, children }: PageProps) {
  const globalActions = useContext(GlobalActionsContext);
  const openMenu = useContext(MenuContext);
  // заголовок вкладки — по последней крошке, чтобы вкладки, история и закладки различались
  const pageName = crumbs.length > 0 ? crumbs[crumbs.length - 1]!.text : "";
  useEffect(() => {
    document.title = pageName ? `${pageName} – HealthCraft` : "HealthCraft";
  }, [pageName]);
  // Порог включительный: ровно на asideColumnFrom панель стоит колонкой. При
  // 1280 на 1366x768 панель отнимала 320px, и колонки таблицы обрезались без
  // признака прокрутки. Страницы `document` без `asideDrawer` раскладывает
  // CSS-медиазапрос в layout.css — панель уходит под основную колонку.
  const wide = useMediaQuery(`(min-width: ${asideColumnFrom}px)`);
  const [asideOpen, setAsideOpen] = useState(false);
  const phone = useMediaQuery("(max-width: 767px)");
  // на телефоне панель во всю ширину окна, в том числе после поворота
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const asideInDrawer = (mode === "fill" || asideDrawer) && !wide && aside !== undefined;

  const barActions =
    actions || globalActions || asideInDrawer ? (
      <Flex gap={2} alignItems="center">
        {globalActions}
        {actions}
        {/* кнопка с подписью: одну иконку не находили */}
        {asideInDrawer && (
          // на телефоне — только иконка в слоте `Button.Icon`: скрытая подпись
          // оставляла внутри кнопки пустое место справа
          <Button view="flat" size="m" className="rh-aside-btn" onClick={() => setAsideOpen(true)} aria-label="Как считается?">
            <Button.Icon side={phone ? undefined : "start"}>
              <Icon data={CircleInfo} size={16} />
            </Button.Icon>
            {!phone && "Как считается?"}
          </Button>
        )}
      </Flex>
    ) : null;

  return (
    <AsideControlContext.Provider value={{ inDrawer: asideInDrawer, open: () => setAsideOpen(true) }}>
    <div className={`rh-page rh-page_${mode}${asideDrawer ? " rh-page_aside-drawer" : ""}`}>
      <ActionBar className="rh-actionbar" aria-label="Путь и действия страницы">
        <ActionBar.Section>
          <ActionBar.Group pull="left-grow">
            {openMenu !== null && (
              <ActionBar.Item>
                <Button view="flat" size="m" onClick={openMenu} aria-label="Меню разделов" className="rh-menu-btn">
                  <Button.Icon>
                    <Icon data={Bars} size={16} />
                  </Button.Icon>
                </Button>
              </ActionBar.Item>
            )}
            {/* крошки сворачиваются по ширине контейнера — пункт растянут на всю группу */}
            <ActionBar.Item className="rh-actionbar__crumbs">
              <Breadcrumbs aria-label="Путь" showRoot style={{ width: "100%" }}>
                {crumbs.map((c, i) =>
                  c.href && i < crumbs.length - 1 ? (
                    <Breadcrumbs.Item key={`${i}:${c.text}`} {...linkProps(c.href)}>
                      {c.text}
                    </Breadcrumbs.Item>
                  ) : (
                    <Breadcrumbs.Item key={`${i}:${c.text}`}>{c.text}</Breadcrumbs.Item>
                  ),
                )}
              </Breadcrumbs>
            </ActionBar.Item>
          </ActionBar.Group>
          {barActions && (
            <ActionBar.Group pull="right">
              <ActionBar.Item>{barActions}</ActionBar.Item>
            </ActionBar.Group>
          )}
        </ActionBar.Section>
      </ActionBar>

      <div className="rh-page__body">
        {mode === "fill" ? (
          <main className="rh-page__main" id="rh-main" tabIndex={-1}>
            {header && <div className="rh-fill__header">{header}</div>}
            <div className="rh-fill__content">{children}</div>
            {footer && <div className="rh-fill__footer">{footer}</div>}
          </main>
        ) : (
          <main className="rh-page__main" id="rh-main" tabIndex={-1}>
            {children}
          </main>
        )}
        {aside !== undefined && !asideInDrawer && <aside className="rh-page__aside">{aside}</aside>}
      </div>

      {asideInDrawer && (
        // на телефоне панель во всю ширину: свободного места для тапа мимо
        // нет, поэтому в заголовке — крестик
        <Drawer open={asideOpen} onOpenChange={setAsideOpen} placement="right" size={phone ? viewportW : 320} aria-label="Как считается?">
          <div className="rh-drawer">
            <div className="rh-drawer__head">
              <Text variant="subheader-3" as="h2">
                Как считается?
              </Text>
              <Button view="flat" size="m" onClick={() => setAsideOpen(false)} aria-label="Закрыть">
                <Button.Icon>
                  <Icon data={Xmark} size={16} />
                </Button.Icon>
              </Button>
            </div>
            {aside}
          </div>
        </Drawer>
      )}
    </div>
    </AsideControlContext.Provider>
  );
}
