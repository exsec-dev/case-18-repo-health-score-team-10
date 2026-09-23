// Shell.tsx — каркас как у SourceCraft: rail AsideHeader (разделы сверху;
// снизу документация, настройки, тема, вход или пользователь; кнопка
// внизу переключает широкий rail с подписями и узкий с иконками) +
// страница = ActionBar с крошками и действиями + основная колонка +
// правая панель (320px), если она есть.
//
// Прокрутка (решение 17.09): окно не прокручивается никогда — только
// контейнеры страницы. Два режима Page:
//   document — текст/плашки: основная колонка и правая панель прокручиваются
//     каждая своим контейнером; уже 1440px (В4.6, У23) колонки встают друг
//     под друга и прокручиваются одним контейнером под ActionBar;
//   fill — данные на высоту экрана (рейтинг): шапка и футер закреплены,
//     прокручивается только область между ними (таблица — сама, с
//     закреплённой строкой заголовков); уже 1440px (В4.6, У23) правая панель
//     уходит в Drawer по кнопке в ActionBar — второй прокрутки на странице нет.
import { ArrowRightFromSquare, ArrowRightToSquare, BookOpen, Bookmark, ChartColumn, CircleInfo, Gear, Moon, Sun, Xmark } from "@gravity-ui/icons";
import { ActionBar, AsideHeader, FooterItem, type AsideHeaderItem } from "@gravity-ui/navigation";
import { ActionTooltip, Avatar, Breadcrumbs, Button, Drawer, Flex, Icon, Text, useThemeValue, useToaster, type IconData } from "@gravity-ui/uikit";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { logout, type MeResponse } from "./api";
import { HealthCraftMark, PRODUCT_NAME } from "./logo";
import { useAppTheme, useMediaQuery, useRailCompact, type AppTheme } from "./prefs";
import { linkProps, navigate } from "./router";

export type Section = "rating" | "me" | "settings" | null;

interface SectionDef {
  id: Exclude<Section, null>;
  title: string;
  href: string;
  icon: IconData;
}

const SECTIONS: SectionDef[] = [
  { id: "rating", title: "Рейтинг", href: "/", icon: ChartColumn },
  // Ступень 4 (слово владельца 23.09): раздел — «Избранное»; иконка — закладка,
  // звезда остается кнопкой добавления в избранное
  { id: "me", title: "Избранное", href: "/me", icon: Bookmark },
];

const GlobalActionsContext = createContext<ReactNode>(null);

export function Shell({
  section,
  me,
  globalActions,
  children,
}: {
  section: Section;
  me: MeResponse | null;
  globalActions?: ReactNode;
  children: ReactNode;
}) {
  const isPhone = useMediaQuery("(max-width: 767px)");
  const [compactPref, setCompact] = useRailCompact();
  const compact = isPhone || compactPref;
  const tips = useRailTips();

  const menuItems: AsideHeaderItem[] = SECTIONS.map((s) => ({
    id: s.id,
    title: s.title,
    icon: s.icon,
    href: s.href,
    current: s.id === section,
    onItemClick: (_item, _collapsed, e) => followLink(e, s.href),
    // узкий rail: вместо одиночного тултипа — подписи всех разделов разом,
    // как MultipleTooltip у SourceCraft (в navigation 6.6.0 его нет)
    enableTooltip: false,
    itemWrapper: (params, makeItem, opts) =>
      opts.compact ? (
        <RailItem id={s.id} title={s.title} tips={tips} withBackdrop={s.id === SECTIONS[0]!.id}>
          {makeItem(params)}
        </RailItem>
      ) : (
        makeItem(params)
      ),
  }));

  return (
    <AsideHeader
      compact={compact}
      onChangeCompact={setCompact}
      hideCollapseButton={isPhone}
      collapseTitle="Свернуть меню"
      expandTitle="Развернуть меню"
      logo={{
        text: PRODUCT_NAME,
        icon: HealthCraftMark,
        iconSize: 26,
        textSize: 20,
        href: "/",
        "aria-label": `${PRODUCT_NAME} – к рейтингу`,
        onClick: (e) => followLink(e, "/"),
      }}
      menuItems={menuItems}
      renderFooter={({ compact: isCompact }) => <RailFooter me={me} compact={isCompact} section={section} />}
      renderContent={() => (
        <GlobalActionsContext.Provider value={globalActions ?? null}>
          <div className="rh-workspace">{children}</div>
        </GlobalActionsContext.Provider>
      )}
      className={compact ? "rh-rail rh-rail_compact" : "rh-rail"}
    />
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
  tips,
  withBackdrop,
  children,
}: {
  id: string;
  title: string;
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
        </span>
      )}
    </div>
  );
}

/** Клик по пункту навигации — клиентский переход; Ctrl/⌘-клик остаётся браузеру. */
function followLink(e: MouseEvent<HTMLElement>, href: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  navigate(href);
}

function RailFooter({ me, compact, section }: { me: MeResponse | null; compact: boolean; section: Section }) {
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

  return (
    <>
      {/* Документация пока недоступна; regularSize — строка 40px,
          как нижние пункты rail SourceCraft. */}
      <FooterItem id="docs" title="Документация" icon={BookOpen} regularSize {...tip("Документация")} />
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
        {...tip(themeTitle)}
        onItemClick={() => switchTheme(setTheme, isDark ? "light" : "dark")}
      />
      {/* выход — обычным пунктом под темой: виден всегда, без скрытых меню */}
      {me?.login && (
        <FooterItem
          id="logout"
          title="Выйти"
          icon={ArrowRightFromSquare}
          regularSize
          {...tip("Выйти")}
          onItemClick={() => void logout().catch((e: unknown) => toaster.add(logoutFailedToast(e)))}
        />
      )}
      <div className={compact ? "rh-rail-account rh-rail-account_compact" : "rh-rail-account"}>
        {me?.login ? <RailUser me={me} /> : <LoginButton compact={compact} />}
      </div>
    </>
  );
}

/**
 * Вход — главный акцент rail, как у платформы, но action (белая в тёмной теме).
 * В4.9 ч.2 (А2): та же кнопка стоит под закрытым Repo Health Score карточки —
 * `inline` дает ей ширину по тексту и полную подпись «Войти через Я ID».
 */
export function LoginButton({ compact, inline = false }: { compact: boolean; inline?: boolean }) {
  const button = (
    <Button
      view="action"
      size={inline ? "m" : "l"}
      width={compact || inline ? "auto" : "max"}
      href="/auth/ya"
      aria-label="Войти через Я ID"
      // узкий rail: квадрат 36×36 — ширина не зависит от колонки футера
      style={compact ? { width: 36, flexShrink: 0 } : undefined}
    >
      <Icon data={ArrowRightToSquare} size={16} />
      {inline ? "Войти через Я ID" : !compact && "Войти"}
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
 * Пользователь внизу rail — кто вошел. Выход — пунктом «Выйти» над блоком
 * (и в блоке аккаунта на пользовательских поверхностях). Аватар 32px стоит на оси иконок rail в обоих
 * видах, высота блока одна — при раскрытии ничего не прыгает.
 */
function RailUser({ me }: { me: MeResponse }) {
  const login = me.login!;
  const name = displayName(me);
  return (
    <div className="rh-rail-user">
      <UserAvatar me={me} size="m" />
      <Flex direction="column" className="rh-rail-user__text">
        <Text variant="subheader-1" ellipsis>
          {name}
        </Text>
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

/** «Екатерина Прожирко» → «Екатерина П.», как в меню пользователя SourceCraft. */
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
 * В4.9 ч.2 (А9, Б2): состояние выезжающей панели доступно странице — ссылка
 * «Как считается» в тексте открывает ту же панель, что кнопка ActionBar; на
 * широком экране (панель стоит колонкой) — прокручивает к ней.
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
  // Круг 2 (Е1): на широком экране панель уже видна колонкой, и одна прокрутка
  // ничего не меняла — ссылка «никуда не вела». Панель прокручивается в вид и
  // коротко подсвечивается рамкой: взгляд переходит к ней.
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
   * Явный opt-in выезжающей панели ниже 1440 для страниц в режиме `document`
   * (А9 В4.9 ч.2): включают только карточка и рейтинг (у рейтинга — режим
   * `fill`, как прежде). Панели /me и /settings на узких экранах ведут себя
   * как раньше — уходят под основную колонку.
   */
  asideDrawer?: boolean;
  /**
   * Круг 2 части 2 (Н1): ширина, с которой панель стоит колонкой (по
   * умолчанию 1440). Рейтингу нужно больше: на 1440 колонка панели сужала
   * таблицу, и «Реакции» с «Последней активностью» уходили за прокрутку.
   */
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
  // Ступень 4 (Ф18): заголовок вкладки — по странице (последняя крошка), чтобы
  // вкладки, история и закладки различались
  const pageName = crumbs.length > 0 ? crumbs[crumbs.length - 1]!.text : "";
  useEffect(() => {
    document.title = pageName ? `${pageName} – HealthCraft` : "HealthCraft";
  }, [pageName]);
  /**
   * В4.6 (У23, решение владельца 20.09 — вариант (iii)): порог 1440, а не
   * 1280. На 1366x768 прежний порог оставлял панель на месте, и она держала
   * 320px, из-за чего колонка «Code health» резалась до «Code hea» без
   * всякого признака прокрутки. Порог ВКЛЮЧИТЕЛЬНЫЙ: ровно на 1440 панель
   * остаётся, ниже уезжает в Drawer по кнопке «Как считается» в ActionBar.
   * Гейт `mode === "fill"` не снимаем: карточка рендерится в `document`
   * (RepoPage.tsx), Drawer там не работает ни на какой ширине — ей отвечает
   * CSS-медиазапрос layout.css, который кладёт панель ПОД основную колонку.
   */
  const wide = useMediaQuery(`(min-width: ${asideColumnFrom}px)`);
  const [asideOpen, setAsideOpen] = useState(false);
  const phone = useMediaQuery("(max-width: 767px)");
  // ревью кода R6: на телефоне панель во всю ширину окна — и после поворота
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
        {/* В4.9 ч.2 (А9): кнопка с подписью — иконка без слова не находилась */}
        {asideInDrawer && (
          // Круг 3 части 2 (1, 2): подпись — вопросом; на телефоне кнопка —
          // только иконка в слоте `Button.Icon`: скрытая подпись оставляла
          // внутри кнопки пустое место справа
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
          <main className="rh-page__main">
            {header && <div className="rh-fill__header">{header}</div>}
            <div className="rh-fill__content">{children}</div>
            {footer && <div className="rh-fill__footer">{footer}</div>}
          </main>
        ) : (
          <main className="rh-page__main">{children}</main>
        )}
        {aside !== undefined && !asideInDrawer && <aside className="rh-page__aside">{aside}</aside>}
      </div>

      {asideInDrawer && (
        // Ступень 4 (Ф4): на телефоне панель во всю ширину; заголовок и крестик
        // закрывают ее без поиска «пустого места» для тапа
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
