// Разбор страниц документации (src/docs/parse.ts) и сборка раздела с проверкой
// ссылок (src/docs/load.ts) на временном каталоге.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadDocs } from "../src/docs/load";
import { tocPages } from "../src/docs/model";
import { buildDocsPdf, renderDocsPdf } from "../src/docs/pdf";
import { headingId, parsePage, parseToc, slugOfFile } from "../src/docs/parse";

describe("разбор страницы", () => {
  test("заголовок, абзац, инлайн, ссылки", () => {
    const { page, errors } = parsePage(
      [
        "# Формула",
        "",
        "Оценка – **взвешенное** среднее, см. `score`",
        "и [порог](scores.md#porog) или [SourceCraft](https://sourcecraft.dev).",
        "",
        "## Порог данных {#porog}",
        "",
        "### Зоны",
      ].join("\n"),
      "method/scores.md",
    );
    expect(errors).toEqual([]);
    expect(page.slug).toBe("method/scores");
    expect(page.title).toBe("Формула");
    const para = page.blocks[0]!;
    expect(para.kind).toBe("paragraph");
    if (para.kind !== "paragraph") return;
    expect(para.content.map((f) => f.kind)).toEqual(["text", "strong", "text", "code", "text", "link", "text", "link", "text"]);
    expect(para.content[5]).toMatchObject({ kind: "link", text: "порог", target: { slug: "method/scores", anchor: "porog" } });
    expect(para.content[7]).toMatchObject({ kind: "link", target: null, href: "https://sourcecraft.dev" });
    expect(page.headings).toEqual([
      { level: 2, id: "porog", text: "Порог данных" },
      { level: 3, id: "zony", text: "Зоны" },
    ]);
  });

  test("относительные ссылки из подкаталога", () => {
    const { page } = parsePage("# T\n\n[a](../index.md) [b](../guide/card.md#x) [c](#y)", "method/scores.md");
    const p = page.blocks[0]!;
    if (p.kind !== "paragraph") throw new Error("paragraph");
    const targets = p.content.filter((f) => f.kind === "link").map((f) => (f.kind === "link" ? f.target : null));
    expect(targets).toEqual([
      { slug: "", anchor: null },
      { slug: "guide/card", anchor: "x" },
      { slug: "method/scores", anchor: "y" },
    ]);
  });

  test("списки: вложенность, код внутри пункта, ленивое продолжение", () => {
    const { page, errors } = parsePage(
      [
        "# T",
        "",
        "1. Откройте **Настройки**",
        "   и продолжение.",
        "   - вложенный пункт",
        "2. Выполните:",
        "",
        "   ```bash",
        "   bun start",
        "   ```",
        "",
        "Абзац после списка.",
      ].join("\n"),
      "t.md",
    );
    expect(errors).toEqual([]);
    expect(page.blocks.map((b) => b.kind)).toEqual(["list", "paragraph"]);
    const list = page.blocks[0]!;
    if (list.kind !== "list") return;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]!.map((b) => b.kind)).toEqual(["paragraph", "list"]);
    expect(list.items[1]!.map((b) => b.kind)).toEqual(["paragraph", "code"]);
    const code = list.items[1]![1]!;
    expect(code).toEqual({ kind: "code", lang: "bash", text: "bun start" });
  });

  test("таблица с выравниванием и экранированной чертой", () => {
    const { page, errors } = parsePage("# T\n\n| Категория | Вес |\n|---|---:|\n| Код \\| тесты | 20 |", "t.md");
    expect(errors).toEqual([]);
    const t = page.blocks[0]!;
    if (t.kind !== "table") throw new Error("table");
    expect(t.align).toEqual(["left", "right"]);
    expect(t.rows[0]![0]![0]).toEqual({ kind: "text", text: "Код | тесты" });
  });

  test("врезка и комментарий", () => {
    const { page, errors } = parsePage('# T\n\n<!-- скриншот:\nрейтинг -->\n{% note warning "Внимание" %}\n\nТекст.\n\n{% endnote %}', "t.md");
    expect(errors).toEqual([]);
    expect(page.blocks).toEqual([{ kind: "note", tone: "warning", title: "Внимание", blocks: [{ kind: "paragraph", content: [{ kind: "text", text: "Текст." }] }] }]);
  });

  test("неподдерживаемое – ошибка, а не молча", () => {
    expect(parsePage("Без заголовка", "a.md").errors.length).toBeGreaterThan(0);
    expect(parsePage("# T\n\n#### Глубоко", "a.md").errors.length).toBeGreaterThan(0);
    expect(parsePage("# T\n\n[x](page.html)", "a.md").errors.length).toBeGreaterThan(0);
    expect(parsePage("# T\n\n| a |\n| b |", "a.md").errors.length).toBeGreaterThan(0);
    expect(parsePage("# T\n\n```bash\nnot closed", "a.md").errors.length).toBeGreaterThan(0);
  });

  test("тег элемента интерфейса: с иконкой и без", () => {
    const { page, errors } = parsePage("# T\n\nОткройте [[favorites:Избранное]] и фильтр [[Язык:]].", "t.md");
    expect(errors).toEqual([]);
    const p = page.blocks[0]!;
    if (p.kind !== "paragraph") throw new Error("paragraph");
    expect(p.content.filter((f) => f.kind === "ui")).toEqual([
      { kind: "ui", text: "Избранное", icon: "favorites", variant: null },
      { kind: "ui", text: "Язык:", icon: null, variant: null },
    ]);
    expect(parsePage("# T\n\n[[nope:Кнопка]]", "t.md").errors.length).toBe(1);
  });

  test("тег с видом элемента: зона, лига, состояние с иконкой", () => {
    const { page, errors } = parsePage("# T\n\n[[label-success:Здоров]] [[league-gold:ТОП-10]] [[state-warning+hourglass:Затянулось]] [[busy:Идет анализ]]", "t.md");
    expect(errors).toEqual([]);
    const p = page.blocks[0]!;
    if (p.kind !== "paragraph") throw new Error("paragraph");
    expect(p.content.filter((f) => f.kind === "ui")).toEqual([
      { kind: "ui", text: "Здоров", icon: null, variant: "label-success" },
      { kind: "ui", text: "ТОП-10", icon: null, variant: "league-gold" },
      { kind: "ui", text: "Затянулось", icon: "hourglass", variant: "state-warning" },
      { kind: "ui", text: "Идет анализ", icon: null, variant: "busy" },
    ]);
    expect(parsePage("# T\n\n[[label-success+label-danger:X]]", "t.md").errors.length).toBe(1);
  });

  test("slug и id заголовков", () => {
    expect(slugOfFile("index.md")).toBe("");
    expect(slugOfFile("guide/index.md")).toBe("guide");
    expect(slugOfFile("method/scores.md")).toBe("method/scores");
    expect(headingId("Два показателя и формула")).toBe("dva-pokazatelya-i-formula");
    expect(headingId("CI/CD")).toBe("ci-cd");
  });

  test("оглавление: страницы и группы", () => {
    const { toc, errors } = parseToc("# Оглавление\n\n- [Начало](index.md)\n- Методика\n  - [Формула](method/scores.md)\n");
    expect(errors).toEqual([]);
    expect(toc).toEqual([
      { kind: "page", title: "Начало", slug: "" },
      { kind: "group", title: "Методика", children: [{ kind: "page", title: "Формула", slug: "method/scores" }] },
    ]);
    expect(tocPages(toc).map((p) => p.slug)).toEqual(["", "method/scores"]);
  });
});

describe("сборка раздела", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-docs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };

  test("порядок по оглавлению и проверка ссылок", () => {
    put("toc.md", "# Оглавление\n\n- [Начало](index.md)\n- Методика\n  - [Формула](method/scores.md)\n  - [Нет такой](method/missing.md)\n");
    put("index.md", "# Начало\n\nСм. [формулу](method/scores.md#porog) и [битую](method/scores.md#nope).\n");
    put("method/scores.md", "# Формула\n\n## Порог {#porog}\n\n[назад](../index.md)\n");
    put("orphan.md", "# Сирота\n");
    const { bundle, errors } = loadDocs(dir);
    expect(bundle.pages.map((p) => p.slug)).toEqual(["", "method/scores"]);
    expect(errors).toEqual([
      "toc.md: страницы «method/missing» нет",
      "страница «orphan» не указана в toc.md",
      "index: ссылка «method/scores.md#nope» – на странице «method/scores» нет заголовка #nope",
    ]);
  });

  test("PDF собирается: обложка, содержание; новый лист – у страницы вне группы и у начала группы", async () => {
    const { bundle } = loadDocs(dir);
    const doc = buildDocsPdf(bundle, { date: "28.09.2026", siteUrl: "https://health-craft.ru/docs" }) as { content: Record<string, unknown>[] };
    expect(doc.content.some((n) => "toc" in n)).toBe(true);
    const heads = doc.content.filter((n) => "stack" in n);
    expect(heads).toHaveLength(bundle.pages.length);
    // «Начало» вне группы, «Формула» открывает группу «Методика»
    expect(heads.map((n) => n.pageBreak === "before")).toEqual([true, true]);
    const pdf = await renderDocsPdf(bundle, { date: "28.09.2026", siteUrl: "https://health-craft.ru/docs" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
