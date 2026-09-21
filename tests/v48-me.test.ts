// v48-me.test.ts — В4.8: «Мои репозитории» по образцу SourceCraft (вариант A
// + плитки сводки C). Числа на плитках и порядок строк — поведенческие тесты
// на данных (правило 21.09: число, названное размером выборки, не закрывается
// чтением исходника); вёрстка и тексты — source-assert.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bandOf, countBands, filterEntries, sortEntries } from "../src/web/myRepos";

const row = (org: string, repo: string, healthcraftIndex: number | null, lastScanAt: string | null = null, title: string | null = null) => ({
  org,
  repo,
  title,
  healthcraftIndex,
  lastScanAt,
});

const sample = [
  row("a", "healthy", 83, "2026-09-20T10:00:00Z"),
  row("b", "edge-up", 69.6, "2026-09-18T10:00:00Z"), // показано как 70 → «здоров», как у рейтинга
  row("c", "attention", 53, "2026-09-21T03:17:00Z", "Хакатон ЛЦТ"),
  row("d", "risk", 12, "2026-09-10T10:00:00Z"),
  row("e", "never", null, null),
  row("f", "no-data", null, "2026-09-19T10:00:00Z"),
];

describe("В4.8: плитки сводки считают строки списка", () => {
  test("полоса — по показанному числу, те же пороги, что у рейтинга; null — «без оценки», а не риск", () => {
    expect(sample.map(bandOf)).toEqual(["success", "success", "warning", "danger", "none", "none"]);
  });

  test("сумма плиток равна длине списка; пустой список — нули", () => {
    const c = countBands(sample);
    expect(c).toEqual({ success: 2, warning: 1, danger: 1, none: 2 });
    expect(c.success + c.warning + c.danger + c.none).toBe(sample.length);
    expect(countBands([])).toEqual({ success: 0, warning: 0, danger: 0, none: 0 });
  });

  test("плитка фильтрует ровно свою полосу: длина выдачи = число на плитке", () => {
    const c = countBands(sample);
    for (const band of ["success", "warning", "danger", "none"] as const) {
      expect(filterEntries(sample, "", band).length).toBe(c[band]);
    }
  });

  test("поиск — подстрокой без регистра по org, repo и названию, в сочетании с плиткой", () => {
    expect(filterEntries(sample, "ATTEN", null).map((e) => e.repo)).toEqual(["attention"]);
    expect(filterEntries(sample, "c / att", null).map((e) => e.repo)).toEqual(["attention"]);
    expect(filterEntries(sample, "c/att", null).map((e) => e.repo)).toEqual(["attention"]);
    expect(filterEntries(sample, "лцт", null).map((e) => e.repo)).toEqual(["attention"]);
    expect(filterEntries(sample, "  ", null).length).toBe(sample.length);
    expect(filterEntries(sample, "attention", "success")).toEqual([]);
  });
});

describe("В4.8: сортировка списка", () => {
  const repos = (key: "index" | "name" | "scan", desc: boolean) => sortEntries(sample, key, desc).map((e) => e.repo);

  test("индекс: без оценки — в конце в обе стороны (tri-state)", () => {
    expect(repos("index", true)).toEqual(["healthy", "edge-up", "attention", "risk", "never", "no-data"]);
    expect(repos("index", false)).toEqual(["risk", "attention", "edge-up", "healthy", "never", "no-data"]);
  });

  test("дата анализа: не анализированный — в конце в обе стороны; битая дата — как отсутствующая", () => {
    expect(repos("scan", true)).toEqual(["attention", "healthy", "no-data", "edge-up", "risk", "never"]);
    expect(repos("scan", false)).toEqual(["risk", "edge-up", "no-data", "healthy", "attention", "never"]);
    const broken = sortEntries([row("x", "bad-date", 50, "not a date"), row("y", "ok", 50, "2026-09-01T00:00:00Z")], "scan", false);
    expect(broken.map((e) => e.repo)).toEqual(["ok", "bad-date"]);
  });

  test("название: по слагу, не мутирует вход", () => {
    const before = sample.map((e) => e.repo);
    expect(repos("name", false)).toEqual(["healthy", "edge-up", "attention", "risk", "never", "no-data"]);
    expect(repos("name", true)).toEqual(["no-data", "never", "risk", "attention", "edge-up", "healthy"]);
    expect(sample.map((e) => e.repo)).toEqual(before);
  });
});

describe("В4.8: вёрстка раздела (source-assert)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "web", "MePage.tsx"), "utf8");
  const reposPage = src.slice(src.indexOf("export function MePage"), src.indexOf("export function SettingsPage"));

  test("журнал «Мои задания» из тела страницы убран; правой панели на /me нет", () => {
    expect(src).not.toContain("function JobsPanel");
    expect(src).not.toContain("<JobsPanel");
    expect(reposPage).not.toContain("aside=");
    // история заданий осталась в шапке
    expect(src).toContain("export function JobsBell");
  });

  test("шапка списка: заголовок, счетчик цветом hint, поиск, сортировка, одна action-кнопка", () => {
    expect(src).toMatch(/<Text variant="header-1" as="h1">\s*Мои репозитории\s*<\/Text>/);
    expect(src).toMatch(/<Text variant="header-1" color="hint">\s*\{entries\.length\}/);
    expect(src).toContain('placeholder="Найти репозиторий"');
    expect(src).toContain('pin="round-brick"');
    expect(src).toContain('pin="brick-round"');
    // JSX-кнопки view="action" в файле: «Добавить» в шапке списка и форма токена
    // (другая страница, /settings); плашка про токен на /me — view="normal"
    expect((src.match(/<Button view="action"/g) ?? []).length).toBe(2);
    expect(src).toMatch(/<Button view="normal" size="m" \{\.\.\.linkProps\("\/settings"\)\}>/);
  });

  test("добавление — диалогом, а не полем над списком", () => {
    expect(src).toContain("function AddRepoDialog");
    expect(src).toContain('caption="Добавить репозиторий"');
    expect(src).not.toContain("Добавить в избранное</Button>");
  });

  test("строка: слой-ссылка на карточку, оценка словом шкалы, действия — кнопка по состоянию и меню", () => {
    const rowSrc = src.slice(src.indexOf("function RepoRow"), src.indexOf("// ========== ПОРТ 5"));
    expect(rowSrc).toContain('className="rh-repo-item__cover"');
    expect(rowSrc).toContain("scoreWord(entry.healthcraftIndex)");
    expect(rowSrc).toContain("scoreColor(entry.healthcraftIndex)");
    expect(rowSrc).toContain("<DropdownMenu");
    expect(rowSrc).toContain('text: "Убрать из избранного"');
    expect(rowSrc).not.toContain("Убрать ★");
  });

  test("CSS строки — замер SourceCraft: аватар 40px радиусом 8px, делитель line-generic", () => {
    const css = readFileSync(join(import.meta.dir, "..", "src", "web", "layout.css"), "utf8");
    expect(css).toMatch(/\.rh-repo-item \.g-avatar \{[^}]*--g-avatar-size: 40px;[^}]*--_--border-radius: 8px;/);
    expect(css).toMatch(/\.rh-repo-item \{[^}]*border-bottom: 1px solid var\(--g-color-line-generic\);/);
    expect(css).toMatch(/\.rh-summary__tile\.g-card \{[^}]*border-radius: 12px;/);
  });
});
