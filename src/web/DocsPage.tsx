// Раздел «Документация» (/docs/...) в духе документации SourceCraft: слева дерево
// разделов, по центру статья, справа «На этой странице», внизу «Назад / Далее».
// Все страницы приходят одним ответом /api/docs – переходы без запросов. Тот же
// текст – в PDF по кнопке в строке пути (src/docs/pdf.ts).
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowRightFromSquare,
  ArrowRightToSquare,
  ArrowsRotateRight,
  ArrowUpRightFromSquare,
  Bars,
  BookOpen,
  Bookmark,
  Bulb,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleExclamation,
  CircleInfo,
  CircleQuestion,
  Clock,
  CodeFork,
  Copy,
  Ellipsis,
  FileText,
  Flag,
  Gear,
  Globe,
  Heart,
  Hourglass,
  Key,
  Lock,
  ListCheck,
  LogoMarkdown,
  Magnifier,
  Moon,
  Persons,
  Plus,
  ScalesBalanced,
  SealCheck,
  Shield,
  ShieldCheck,
  ShieldExclamation,
  SparklesFill,
  Star,
  StarFill,
  Sun,
} from "@gravity-ui/icons";
import { Alert, Button, Icon, Label, type IconData } from "@gravity-ui/uikit";
import { useEffect, useLayoutEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { DocBlock, DocLine, DocPage, DocsBundle, DocTarget, TocNode, UiIcon } from "../docs/model";
import { useJson } from "./api";
import { DocsSearch } from "./DocsSearch";
import { Trophy } from "./icons";
import { navigate } from "./router";
import { Page } from "./Shell";
import { EmptyState, SkeletonRows } from "./ui";

/** Иконки тегов интерфейса – те же, что у элементов UI (Shell, RepoPage, MePage, Rating). */
const UI_ICON_DATA: Record<UiIcon, IconData> = {
  rating: ChartColumn,
  compare: ScalesBalanced,
  favorites: Bookmark,
  docs: BookOpen,
  settings: Gear,
  login: ArrowRightToSquare,
  logout: ArrowRightFromSquare,
  "theme-dark": Moon,
  "theme-light": Sun,
  info: CircleInfo,
  ai: SparklesFill,
  refresh: ArrowsRotateRight,
  download: ArrowDownToLine,
  badge: SealCheck,
  more: Ellipsis,
  plus: Plus,
  search: Magnifier,
  jobs: ListCheck,
  token: Key,
  external: ArrowUpRightFromSquare,
  flag: Flag,
  league: Trophy,
  recommendation: Bulb,
  markdown: LogoMarkdown,
  pdf: FileText,
  likes: Heart,
  forks: CodeFork,
  activity: Clock,
  check: CircleCheck,
  hourglass: Hourglass,
  exclamation: CircleExclamation,
  dashed: CircleDashed,
  question: CircleQuestion,
  public: Globe,
  internal: Persons,
  private: Lock,
  star: Star,
  "star-filled": StarFill,
  shield: Shield,
  "shield-check": ShieldCheck,
  "shield-warning": ShieldExclamation,
};

export function docHref(slug: string, anchor?: string | null): string {
  const path = slug === "" ? "/docs" : `/docs/${slug.split("/").map(encodeURIComponent).join("/")}`;
  return anchor ? `${path}#${anchor}` : path;
}

/** Прокрутить статью к заголовку или в начало. */
function scrollToAnchor(anchor: string | null): void {
  const target = anchor ? document.getElementById(anchor) : null;
  if (target) target.scrollIntoView({ block: "start" });
  else document.querySelector(".rh-docs__main")?.scrollTo({ top: 0 });
}

/** Внутренняя ссылка: клиентский переход и прокрутка к якорю; Ctrl/⌘-клик – браузеру. */
function docLinkProps(target: DocTarget): { href: string; onClick: (e: MouseEvent) => void } {
  const href = docHref(target.slug, target.anchor);
  return {
    href,
    onClick: (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      navigate(href);
      requestAnimationFrame(() => scrollToAnchor(target.anchor));
    },
  };
}

function Inlines({ line }: { line: DocLine }) {
  return (
    <>
      {line.map((f, i) => {
        switch (f.kind) {
          case "strong":
            return <strong key={i}>{f.text}</strong>;
          case "code":
            return <code key={i}>{f.text}</code>;
          case "ui":
            return <UiTag key={i} tag={f} />;
          case "link":
            return f.target ? (
              <a key={i} {...docLinkProps(f.target)}>
                {f.text}
              </a>
            ) : (
              <a key={i} href={f.href} target="_blank" rel="noopener noreferrer">
                {f.text}
              </a>
            );
          default:
            return <span key={i}>{f.text}</span>;
        }
      })}
    </>
  );
}

/**
 * Элемент интерфейса в тексте – тем же компонентом и классом, что в UI: Label для зон и
 * статусов, `.rh-league` для лиг, `.rh-state` / `.rh-busy` для состояний «Избранного».
 * Без вида – серый тег кнопки или раздела.
 */
function UiTag({ tag }: { tag: Extract<DocLine[number], { kind: "ui" }> }) {
  const { variant, text } = tag;
  const icon = tag.icon ? UI_ICON_DATA[tag.icon] : null;
  if (variant?.startsWith("label-")) {
    const theme = variant.slice("label-".length) as "success" | "warning" | "danger" | "info" | "normal" | "unknown" | "utility";
    return (
      <span className="rh-docs__uiwrap">
        <Label theme={theme} size="xs" icon={icon ? <Icon data={icon} size={12} /> : undefined}>
          {text}
        </Label>
      </span>
    );
  }
  if (variant?.startsWith("league-")) {
    return (
      <span className={`rh-league rh-league_${variant.slice("league-".length)} rh-docs__uiwrap`}>
        <Icon data={Trophy} size={14} />
        {text}
      </span>
    );
  }
  if (variant === "pill") {
    return (
      <span className="rh-pill rh-docs__uiwrap">
        {icon && <Icon data={icon} size={12} />}
        {text}
      </span>
    );
  }
  if (variant === "busy") return <span className="rh-state rh-busy rh-docs__uiwrap">{text}</span>;
  if (variant?.startsWith("state")) {
    const tone = variant === "state" ? null : variant.slice("state-".length);
    return (
      <span className="rh-state rh-docs__uiwrap">
        {icon && <Icon data={icon} size={14} className={tone ? `rh-state__icon rh-state__icon_${tone}` : "rh-state__icon"} />}
        {text}
      </span>
    );
  }
  return (
    <span className="rh-docs__ui">
      {icon && <Icon data={icon} size={14} />}
      {text}
    </span>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rh-docs__code">
      <pre>
        <code data-lang={lang || undefined}>{text}</code>
      </pre>
      <Button
        className="rh-docs__copy"
        view="flat-secondary"
        size="s"
        aria-label="Скопировать"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Button.Icon>
          <Icon data={copied ? Check : Copy} size={14} />
        </Button.Icon>
      </Button>
    </div>
  );
}

function Blocks({ blocks, tight = false }: { blocks: DocBlock[]; tight?: boolean }) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} tight={tight && blocks.length === 1} />
      ))}
    </>
  );
}

function BlockView({ block, tight }: { block: DocBlock; tight: boolean }): ReactNode {
  switch (block.kind) {
    case "heading": {
      const H = block.level === 2 ? "h2" : "h3";
      return (
        <H id={block.id} className={`rh-docs__h${block.level}`}>
          <Inlines line={block.content} />
          <a className="rh-docs__anchor" href={`#${block.id}`} aria-label="Ссылка на раздел" onClick={(e) => { e.preventDefault(); history.replaceState(null, "", `#${block.id}`); scrollToAnchor(block.id); }}>
            #
          </a>
        </H>
      );
    }
    case "paragraph":
      return tight ? <Inlines line={block.content} /> : <p><Inlines line={block.content} /></p>;
    case "list": {
      const L = block.ordered ? "ol" : "ul";
      return (
        <L>
          {block.items.map((item, i) => (
            <li key={i}>
              <Blocks blocks={item} tight />
            </li>
          ))}
        </L>
      );
    }
    case "table":
      return (
        <div className="rh-docs__table">
          <table>
            <thead>
              <tr>
                {block.head.map((h, c) => (
                  <th key={c} style={{ textAlign: block.align[c] ?? "left" }}>
                    <Inlines line={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: block.align[c] ?? "left" }}>
                      <Inlines line={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />;
    case "note":
      return (
        <div className={`rh-docs__note rh-docs__note_${block.tone}`}>
          <div className="rh-docs__note-title">{block.title ?? (block.tone === "warning" ? "Важно" : "Примечание")}</div>
          <Blocks blocks={block.blocks} />
        </div>
      );
  }
}

function TocTree({ nodes, current, onGo }: { nodes: TocNode[]; current: string; onGo: () => void }) {
  return (
    <ul className="rh-docs-toc">
      {nodes.map((n, i) => (
        <TocItem key={i} node={n} current={current} onGo={onGo} />
      ))}
    </ul>
  );
}

function containsSlug(node: TocNode, slug: string): boolean {
  return node.kind === "page" ? node.slug === slug : node.children.some((c) => containsSlug(c, slug));
}

function TocItem({ node, current, onGo }: { node: TocNode; current: string; onGo: () => void }) {
  const active = containsSlug(node, current);
  // группы раскрыты: страниц немного, и все темы видны сразу
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  if (node.kind === "page") {
    const props = docLinkProps({ slug: node.slug, anchor: null });
    return (
      <li>
        <a
          className={node.slug === current ? "rh-docs-toc__link rh-docs-toc__link_current" : "rh-docs-toc__link"}
          aria-current={node.slug === current ? "page" : undefined}
          href={props.href}
          onClick={(e) => {
            props.onClick(e);
            onGo();
          }}
        >
          {node.title}
        </a>
      </li>
    );
  }
  return (
    <li>
      <button type="button" className="rh-docs-toc__group" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon data={open ? ChevronDown : ChevronRight} size={14} />
        {node.title}
      </button>
      {open && <TocTree nodes={node.children} current={current} onGo={onGo} />}
    </li>
  );
}

/** Оглавление только из существующих страниц: пустые группы не показываются. */
function presentToc(nodes: TocNode[], have: Set<string>): TocNode[] {
  return nodes.flatMap((n): TocNode[] => {
    if (n.kind === "page") return have.has(n.slug) ? [n] : [];
    const children = presentToc(n.children, have);
    return children.length > 0 ? [{ ...n, children }] : [];
  });
}

function groupTitle(nodes: TocNode[], slug: string): string | null {
  for (const n of nodes) if (n.kind === "group" && containsSlug(n, slug)) return n.title;
  return null;
}

export function DocsPage({ slug }: { slug: string }) {
  const docs = useJson<DocsBundle>("/api/docs");
  const bundle = docs.state.kind === "ok" ? docs.state.data : null;
  const [navOpen, setNavOpen] = useState(false);

  const page: DocPage | null = bundle?.pages.find((p) => p.slug === slug) ?? null;
  // смена страницы: к якорю из адреса или в начало
  useLayoutEffect(() => {
    if (!page) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    scrollToAnchor(hash || null);
  }, [page]);

  const crumbsBase = { text: "Документация", href: "/docs" };
  const openFound = (slug: string, anchor: string | null) => {
    navigate(docHref(slug, anchor));
    requestAnimationFrame(() => scrollToAnchor(anchor));
  };
  const pdfButton = bundle && (
    <Button view="outlined" size="m" href={bundle.pdfUrl} target="_blank" rel="noopener" title="Весь текст документации одним файлом">
      <Button.Icon side="start">
        <Icon data={ArrowDownToLine} size={16} />
      </Button.Icon>
      PDF-версия
    </Button>
  );
  const headerActions = bundle && (
    <span className="rh-docs-actions">
      <DocsSearch pages={bundle.pages} onOpen={openFound} />
      {pdfButton}
    </span>
  );

  if (docs.state.kind === "error") {
    return (
      <Page crumbs={[crumbsBase]}>
        <Alert theme="danger" title="Не удалось загрузить документацию" message={docs.state.message} actions={[{ text: "Повторить", handler: docs.reload }]} />
      </Page>
    );
  }
  if (!bundle) {
    return (
      <Page crumbs={[crumbsBase]}>
        <SkeletonRows rows={8} height={28} />
      </Page>
    );
  }
  if (!page) {
    return (
      <Page crumbs={[crumbsBase, { text: "Страница не найдена" }]} actions={headerActions}>
        <EmptyState
          icon={CircleQuestion}
          title="Страница не найдена"
          description="Такой страницы в документации нет или она переехала."
          actions={[{ text: "К началу документации", view: "action", size: "l", onClick: () => navigate("/docs") }]}
        />
      </Page>
    );
  }

  const order = bundle.pages;
  const at = order.findIndex((p) => p.slug === page.slug);
  const prev = at > 0 ? order[at - 1]! : null;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1]! : null;
  const toc = presentToc(bundle.toc, new Set(order.map((p) => p.slug)));
  const group = groupTitle(bundle.toc, page.slug);
  const crumbs = page.slug === "" ? [{ text: "Документация" }] : [crumbsBase, ...(group ? [{ text: group }] : []), { text: page.title }];
  const onPage = page.headings.filter((h) => h.level === 2);

  return (
    <Page crumbs={crumbs} actions={headerActions} mode="fill">
      <div className="rh-docs">
        <nav className={navOpen ? "rh-docs__nav rh-docs__nav_open" : "rh-docs__nav"} aria-label="Разделы документации">
          <button type="button" className="rh-docs__nav-toggle" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>
            <Icon data={Bars} size={16} />
            Разделы документации
          </button>
          <div className="rh-docs__nav-tree">
            <TocTree nodes={toc} current={page.slug} onGo={() => setNavOpen(false)} />
          </div>
        </nav>
        <div className="rh-docs__main">
          <article className="rh-docs__article">
            <h1 className="rh-docs__h1">{page.title}</h1>
            <Blocks blocks={page.blocks} />
          </article>
          {(prev || next) && (
            <nav className="rh-docs__pager" aria-label="Соседние страницы">
              {prev ? (
                <a className="rh-docs__pager-link" {...docLinkProps({ slug: prev.slug, anchor: null })}>
                  <span className="rh-docs__pager-dir">Назад</span>
                  <span className="rh-docs__pager-title">
                    <Icon data={ArrowLeft} size={16} />
                    {prev.title}
                  </span>
                </a>
              ) : (
                <span />
              )}
              {next && (
                <a className="rh-docs__pager-link rh-docs__pager-link_next" {...docLinkProps({ slug: next.slug, anchor: null })}>
                  <span className="rh-docs__pager-dir">Далее</span>
                  <span className="rh-docs__pager-title">
                    {next.title}
                    <Icon data={ArrowRight} size={16} />
                  </span>
                </a>
              )}
            </nav>
          )}
        </div>
        {onPage.length > 1 && (
          <aside className="rh-docs__onpage" aria-label="На этой странице">
            <div className="rh-docs__onpage-title">На этой странице</div>
            <ul>
              {onPage.map((h) => (
                <li key={h.id}>
                  <a {...docLinkProps({ slug: page.slug, anchor: h.id })}>{h.text}</a>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </Page>
  );
}
