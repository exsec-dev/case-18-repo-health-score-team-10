// Shell.tsx — каркас как у SourceCraft: rail AsideHeader (разделы сверху;
// снизу документация, настройки, тема, вход или пользователь; кнопка
// внизу переключает широкий rail с подписями и узкий с иконками) +
// страница = ActionBar с крошками и действиями + основная колонка +
// правая панель (320px), если она есть.
//
// Прокрутка (решение 17.09): окно не прокручивается никогда — только
// контейнеры страницы. Два режима Page:
//   document — текст/плашки: основная колонка и правая панель прокручиваются
//     каждая своим контейнером; уже 1280px колонки встают друг под друга и
//     прокручиваются одним контейнером под ActionBar;
//   fill — данные на высоту экрана (рейтинг): шапка и футер закреплены,
//     прокручивается только область между ними (таблица — сама, с
//     закреплённой строкой заголовков); уже 1280px правая панель уходит в
//     Drawer по кнопке в ActionBar — второй прокрутки на странице нет.
import { ArrowRightFromSquare, ArrowRightToSquare, BookOpen, ChartColumn, CircleInfo, Gear, HeartPulse, Moon, Person, Sun } from "@gravity-ui/icons";
import { ActionBar, AsideHeader, FooterItem, type AsideHeaderItem } from "@gravity-ui/navigation";
import { Avatar, Breadcrumbs, Button, Drawer, DropdownMenu, Flex, Icon, Text, useThemeValue, useToaster, type IconData } from "@gravity-ui/uikit";
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { MeResponse } from "./api";
import { useAppTheme, useMediaQuery, useRailCompact, type AppTheme } from "./prefs";
import { linkProps, navigate } from "./router";

export type Section = "rating" | "me" | null;

interface SectionDef {
  id: Exclude<Section, null>;
  title: string;
  href: string;
  icon: IconData;
}

const SECTIONS: SectionDef[] = [
  { id: "rating", title: "Рейтинг", href: "/", icon: ChartColumn },
  { id: "me", title: "Личный кабинет", href: "/me", icon: Person },
];

export function Shell({ section, me, children }: { section: Section; me: MeResponse | null; children: ReactNode }) {
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
    // как у SourceCraft (в navigation 6.6.0 такого режима нет)
    enableTooltip: false,
    itemWrapper: (params, makeItem, opts) =>
      opts.compact ? (
        <RailItem title={s.title} current={s.id === section} open={tips.open} onEnter={tips.show} onLeave={tips.hide}>
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
        text: "Repo Health",
        icon: HeartPulse,
        iconSize: 24,
        href: "/",
        "aria-label": "Repo Health — к рейтингу",
        onClick: (e) => followLink(e, "/"),
      }}
      menuItems={menuItems}
      renderFooter={({ compact: isCompact }) => <RailFooter me={me} compact={isCompact} />}
      renderContent={() => <div className="rh-workspace">{children}</div>}
      className={compact ? "rh-rail rh-rail_compact" : "rh-rail"}
    />
  );
}

/**
 * Подписи узкого rail: открыты, пока курсор над любым пунктом. Уход с пункта
 * закрывает с короткой задержкой — переход на соседний пункт её отменяет,
 * и подписи не мигают.
 */
function useRailTips() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    open,
    show: () => {
      cancel();
      setOpen(true);
    },
    hide: () => {
      cancel();
      timer.current = setTimeout(() => setOpen(false), 80);
    },
  };
}

/**
 * Пункт узкого rail с подписью. Подпись — position: fixed по координатам
 * пункта: контейнеры AsideHeader обрезают всё, что шире 56px.
 */
function RailItem(props: { title: string; current: boolean; open: boolean; onEnter: () => void; onLeave: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!props.open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // от правого края самого rail: обёртка пункта в AsideHeader шире 56px
    const rail = ref.current.closest('[class*="aside-content"]')?.getBoundingClientRect();
    setPos({ left: (rail?.right ?? r.right) + 8, top: r.top + r.height / 2 });
  }, [props.open]);
  return (
    <div ref={ref} className="rh-rail-item" onMouseEnter={props.onEnter} onMouseLeave={props.onLeave}>
      {props.children}
      {props.open && pos && (
        <span
          className={props.current ? "rh-rail-tip rh-rail-tip_current" : "rh-rail-tip"}
          style={{ left: pos.left, top: pos.top }}
          aria-hidden="true"
        >
          {props.title}
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

function RailFooter({ me, compact }: { me: MeResponse | null; compact: boolean }) {
  const [, setTheme] = useAppTheme();
  const resolved = useThemeValue();
  const isDark = resolved === "dark" || resolved === "dark-hc";

  return (
    <>
      {/* Документация и Настройки — ещё не сделаны: пункты есть, действия нет */}
      <FooterItem id="docs" title="Документация" icon={BookOpen} />
      <FooterItem id="settings" title="Настройки" icon={Gear} />
      <FooterItem
        id="theme"
        title={isDark ? "Светлая тема" : "Тёмная тема"}
        icon={isDark ? Sun : Moon}
        onItemClick={() => switchTheme(setTheme, isDark ? "light" : "dark")}
      />
      <div className={compact ? "rh-rail-account rh-rail-account_compact" : "rh-rail-account"}>
        {me?.login ? <RailUser me={me} compact={compact} /> : <LoginButton compact={compact} />}
      </div>
    </>
  );
}

/** Вход — главный акцент rail, как у платформы, но action (белая в тёмной теме). */
function LoginButton({ compact }: { compact: boolean }) {
  return (
    <Button
      view="action"
      size="l"
      width={compact ? "auto" : "max"}
      href="/auth/ya"
      aria-label="Войти через Я ID"
      title={compact ? "Войти через Я ID" : undefined}
    >
      <Icon data={ArrowRightToSquare} size={16} />
      {!compact && "Войти"}
    </Button>
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
 * Пользователь внизу rail: клик открывает меню (кабинет, выход) — как меню
 * пользователя SourceCraft. Высота блока одна в узком и широком rail.
 */
function RailUser({ me, compact }: { me: MeResponse; compact: boolean }) {
  const login = me.login!;
  // display_name Я ID по умолчанию равен логину — такое «имя» не показываем дважды
  const name = me.displayName && me.displayName !== login ? (shortName(me.displayName) ?? login) : login;
  const toaster = useToaster();

  async function logout() {
    try {
      const res = await fetch("/auth/logout", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.assign("/");
    } catch (e) {
      toaster.add({ name: "logout-failed", theme: "danger", title: "Не удалось выйти", content: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <DropdownMenu
      size="m"
      popupProps={{ placement: ["right-end", "top-start"] }}
      renderSwitcher={(props) => (
        <button
          type="button"
          {...props}
          className="rh-rail-user"
          aria-label={`Меню пользователя ${login}`}
          title={compact ? `${name} (${login})` : undefined}
        >
          <UserAvatar me={me} />
          <Flex direction="column" className="rh-rail-user__text">
            <Text variant="subheader-2" ellipsis>
              {name}
            </Text>
            {name !== login && (
              <Text color="secondary" ellipsis>
                {login}
              </Text>
            )}
          </Flex>
        </button>
      )}
      items={[
        { text: "Личный кабинет", iconStart: <Icon data={Person} size={16} />, action: () => navigate("/me") },
        { text: "Выйти", iconStart: <Icon data={ArrowRightFromSquare} size={16} />, theme: "danger", action: () => void logout() },
      ]}
    />
  );
}

/** Один размер (l, 42px) в обоих видах rail — без скачка высоты при раскрытии. */
function UserAvatar({ me }: { me: MeResponse }) {
  const text = me.displayName ?? me.login ?? "?";
  return me.avatarUrl ? (
    <Avatar size="l" shape="square" imgUrl={me.avatarUrl} alt="" style={{ flexShrink: 0 }} />
  ) : (
    <Avatar size="l" shape="square" text={text} theme="normal" style={{ flexShrink: 0 }} />
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

interface PageProps {
  crumbs: Crumb[];
  actions?: ReactNode;
  aside?: ReactNode;
  /** document (по умолчанию) — колонки прокручиваются; fill — данные на высоту экрана */
  mode?: "document" | "fill";
  /** fill: закреплено над прокручиваемой областью */
  header?: ReactNode;
  /** fill: закреплено под прокручиваемой областью */
  footer?: ReactNode;
  children: ReactNode;
}

export function Page({ crumbs, actions, aside, mode = "document", header, footer, children }: PageProps) {
  const wide = useMediaQuery("(min-width: 1280px)");
  const [asideOpen, setAsideOpen] = useState(false);
  // fill уже 1280: правая панель — по кнопке, а не второй прокруткой под данными
  const asideInDrawer = mode === "fill" && !wide && aside !== undefined;

  const barActions =
    actions || asideInDrawer ? (
      <Flex gap={2} alignItems="center">
        {actions}
        {asideInDrawer && (
          <Button view="flat" size="m" onClick={() => setAsideOpen(true)} aria-label="Как считается" title="Как считается">
            <Icon data={CircleInfo} size={16} />
          </Button>
        )}
      </Flex>
    ) : null;

  return (
    <div className={`rh-page rh-page_${mode}`}>
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
        <Drawer open={asideOpen} onOpenChange={setAsideOpen} placement="right" size={320} aria-label="Как считается">
          <div className="rh-drawer">{aside}</div>
        </Drawer>
      )}
    </div>
  );
}
