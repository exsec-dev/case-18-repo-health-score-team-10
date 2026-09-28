// Модель документации: страницы из docs/guide/*.md, разобранные в блоки. Из одной
// модели рисуются и раздел /docs сайта (src/web/DocsPage.tsx), и PDF (src/docs/pdf.ts),
// поэтому их текст совпадает построением. Модуль чистый: ни диска, ни pdfmake.

/** Ссылка внутри документации: страница и, возможно, заголовок на ней. */
export interface DocTarget {
  slug: string;
  anchor: string | null;
}

/**
 * Иконки тегов интерфейса – те же, что у элементов UI (src/web/DocsPage.tsx сопоставляет
 * имя с иконкой Gravity). В тексте: `[[favorites:Избранное]]`.
 */
export const UI_ICONS = [
  "rating",
  "compare",
  "favorites",
  "docs",
  "settings",
  "login",
  "logout",
  "theme-dark",
  "theme-light",
  "info",
  "ai",
  "refresh",
  "download",
  "badge",
  "more",
  "plus",
  "search",
  "jobs",
  "token",
  "external",
  "flag",
  "league",
  "recommendation",
  "markdown",
  "pdf",
  "likes",
  "forks",
  "activity",
  "check",
  "hourglass",
  "exclamation",
  "dashed",
  "question",
  "public",
  "internal",
  "private",
  "star",
  "star-filled",
  "shield",
  "shield-check",
  "shield-warning",
] as const;
export type UiIcon = (typeof UI_ICONS)[number];

/**
 * Вид тега – как у элемента в UI: плашка Label нужной темы (зоны, статусы), лига,
 * строка состояния из «Избранного», «идет анализ» со штриховкой. Без вида – серый
 * тег кнопки или раздела. В тексте: `[[label-success:Здоров]]`, `[[league-gold:ТОП-10]]`,
 * `[[state-warning+hourglass:Затянулось]]` (вид и иконка через «+»).
 */
export const UI_VARIANTS = [
  "label-success",
  "label-warning",
  "label-danger",
  "label-info",
  "label-normal",
  "label-unknown",
  "label-utility",
  "league-gold",
  "league-silver",
  "league-bronze",
  "state",
  "state-success",
  "state-warning",
  "state-danger",
  "busy",
  "pill",
] as const;
export type UiVariant = (typeof UI_VARIANTS)[number];

export type DocInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  /** элемент интерфейса: серый тег, с иконкой как в UI, если она есть */
  | { kind: "ui"; text: string; icon: UiIcon | null; variant: UiVariant | null }
  /** `target` – ссылка на страницу документации; иначе `href` – внешний https-адрес */
  | { kind: "link"; text: string; href: string; target: DocTarget | null };

export type DocLine = DocInline[];

export type DocBlock =
  | { kind: "heading"; level: 2 | 3; id: string; content: DocLine }
  | { kind: "paragraph"; content: DocLine }
  /** пункт списка – свои блоки: абзац, вложенный список, код */
  | { kind: "list"; ordered: boolean; items: DocBlock[][] }
  | { kind: "table"; align: ("left" | "right" | "center")[]; head: DocLine[]; rows: DocLine[][] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "note"; tone: "info" | "warning"; title: string | null; blocks: DocBlock[] }
  /** скриншот: `src` – путь от docs/guide (только images/*), `alt` – подпись под картинкой */
  | { kind: "image"; src: string; alt: string };

export interface DocHeading {
  level: 2 | 3;
  id: string;
  text: string;
}

export interface DocPage {
  /** адрес страницы без /docs: `method/scores`; у `index.md` – пустая строка */
  slug: string;
  title: string;
  blocks: DocBlock[];
  /** заголовки страницы – для «На этой странице» и закладок PDF */
  headings: DocHeading[];
}

/** Узел оглавления: страница или группа страниц. */
export type TocNode = { kind: "page"; title: string; slug: string } | { kind: "group"; title: string; children: TocNode[] };

export interface DocsBundle {
  toc: TocNode[];
  /** страницы в порядке оглавления – этот же порядок у «Назад / Далее» и в PDF */
  pages: DocPage[];
  /** адрес PDF с тем же текстом */
  pdfUrl: string;
}

export function linePlain(line: DocLine): string {
  return line.map((f) => f.text).join("");
}

/** Страницы оглавления по порядку обхода. */
export function tocPages(toc: TocNode[]): { title: string; slug: string }[] {
  const out: { title: string; slug: string }[] = [];
  const walk = (nodes: TocNode[]) => {
    for (const n of nodes) {
      if (n.kind === "page") out.push({ title: n.title, slug: n.slug });
      else walk(n.children);
    }
  };
  walk(toc);
  return out;
}
