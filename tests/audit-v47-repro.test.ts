// Репро-тесты на дефекты PDF-выгрузки, фильтра языков, кабинета и формата дат,
// найденные аудитом. Обертка `repro` – в обычном прогоне `test.failing`, под
// AUDIT_STRICT=1 обычный `test`; в конце файла строгая самопроверка, что под
// `repro` ничего не осталось.
//
// Живых запросов нет: API и MD – чистые функции на временной БД, UI – source-assert
// или чистый хелпер. Числа (фасеты, счетчик) проверяются поведенчески, на данных.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listRepos, parseReposQuery } from "../src/api/repos";
import { addFavorite, listMyRepos } from "../src/api/me";
import { upsertUser } from "../src/auth/session";
import { renderRepoReport } from "../src/report/markdown";
import { fmtDate, fmtDateTime } from "../src/web/format";
import { parseRoute } from "../src/web/router";
import { makeApiDb, seedRating, type ApiTestDb } from "./api-fixtures";
import { fixtureCard } from "./report-fixtures";

const repro = process.env.AUDIT_STRICT ? test : test.failing;

const root = join(import.meta.dir, "..");
const src = (path: string): string => readFileSync(join(root, "src", path), "utf8");

/** Исходник БЕЗ комментариев: утверждения говорят о разметке и строках, а не о мотивировке в комментариях. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Кусок исходника между двумя якорями (закрывающий ищется после открывающего). */
const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  if (start < 0) return "";
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};

const rating: ApiTestDb = makeApiDb();
seedRating(rating);
rating.db.query("UPDATE repos SET language_color = '#00ADD8' WHERE language = 'Go'").run();
rating.db.query("UPDATE repos SET language_color = '#A97BFF' WHERE language = 'Kotlin'").run();
afterAll(() => rating.close());

// ---------------------------------------------------------------------------
// PDF: пункт меню «PDF (.pdf)» был с пустым обработчиком и без маршрута.
// ---------------------------------------------------------------------------

describe("П1: PDF-выгрузка", () => {
  test("кнопка PDF качает файл, а не молчит (ReportMenu без пустого обработчика)", () => {
    const menu = between(src("web/RepoPage.tsx"), "function useReportDownload", "\n}\n");
    expect({
      emptyHandler: /action:\s*\(\)\s*=>\s*\{\s*\}/.test(menu),
      fetchesPdf: menu.includes("report.pdf") || src("web/RepoPage.tsx").includes("/report.pdf"),
    }).toEqual({ emptyHandler: false, fetchesPdf: true });
  });

  test("маршрут /api/repos/:org/:repo/report.pdf существует рядом с report.md", () => {
    const server = src("server.ts");
    expect({ md: server.includes('"/api/repos/:org/:repo/report.md"'), pdf: server.includes('"/api/repos/:org/:repo/report.pdf"') }).toEqual({ md: true, pdf: true });
  });
});

// ---------------------------------------------------------------------------
// Повторяемый lang и цвет языка в фасете.
// ---------------------------------------------------------------------------

describe("П2: контракт языка", () => {
  test("?lang=Go&lang=Kotlin отдаёт оба языка по всему каталогу (сейчас берётся одно значение)", () => {
    const parsed = parseReposQuery(new URLSearchParams("lang=Go&lang=Kotlin&per_page=100"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const res = listRepos(rating.db, parsed.query);
    const langs = new Set([...res.items, ...res.nullItems].map((i) => i.language));
    expect([...langs].sort()).toEqual(["Go", "Kotlin"]);
  });

  test("фасет несёт цвет языка (LanguageFacet.color из language_color)", () => {
    const parsed = parseReposQuery(new URLSearchParams(""));
    if (!parsed.ok) throw new Error(parsed.message);
    const facets = listRepos(rating.db, parsed.query).facets.languages as { language: string | null; color?: string | null }[];
    expect({
      go: facets.find((f) => f.language === "Go")?.color,
      none: facets.find((f) => f.language === null)?.color,
    }).toEqual({ go: "#00ADD8", none: null });
  });
});

// ---------------------------------------------------------------------------
// Кабинет: предупреждение про PAT, формулировки, глифы прав, счетчик.
// ---------------------------------------------------------------------------

describe("П3: кабинет «Мои репозитории»", () => {
  const me = (): string => stripComments(src("web/MePage.tsx"));
  const section = (): string => between(me(), "function MyReposSection", "\nfunction RepoRow");

  // без токена – предупреждение одной строкой с кнопкой на /settings, без плашки из шагов
  test("П3.3 → Е17: без PAT на /me — предупреждение с переходом на /settings (не тост и не title)", () => {
    const s = section();
    const notice = between(me(), "function TokenNotice", "\nexport function MePage");
    expect({
      branch: s.includes("<TokenNotice hasPat={hasPat} />") && /if \(hasPat\) return null;/.test(notice),
      link: /linkProps\("\/settings"\)/.test(notice),
      steps: /OwnerSteps/.test(me()),
    }).toEqual({ branch: true, link: true, steps: false });
  });

  test("П3.2: строка без проверки прав говорит, что делать, а не «еще не проверяли»", () => {
    const row = between(me(), "function accessRow", "\n}\n");
    expect(/не проверяли/.test(row)).toBe(false);
  });

  test("П3.4: tri-state прав — компонентами, а не глифами ✓ ✗ ?", () => {
    expect({ check: me().includes("✓"), cross: me().includes("✗") }).toEqual({ check: false, cross: false });
  });

  // Кроме обертки `CabinetAlert` Alert стоит в 1 месте с особым видом:
  // предупреждение «нет токена». Плашки «Токен показывается один раз» нет с
  // редизайна «Настроек» 19.10.2026 — это последний шаг инструкции.
  test("П3.4 → Е17/Е18: Alert — обертка и 1 место с особым видом", () => {
    const alerts = me().match(/<Alert\b[^>]*/g) ?? [];
    expect(alerts.length).toBe(2);
    // кнопка под текстом – горизонтальной раскладки нет, иконка синяя
    expect(me()).not.toContain('layout="horizontal"');
    expect(me()).toContain('className="rh-info-icon"');
    expect(me()).toContain("SourceCraft показывает его только один раз");
  });

  test("П3.4 (У26): /api/me/repos несет recommendationsCount (null без прав, не 0)", async () => {
    const t = makeApiDb();
    try {
      const u = upsertUser(t.db, "ya-v47", "v47");
      t.db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('vault', 'hidden', 'private')").run();
      addFavorite(t.db, u, "vault", "hidden");
      const [entry] = (await listMyRepos(t.db, u)).entries;
      expect({ has: entry !== undefined && "recommendationsCount" in entry, value: (entry as { recommendationsCount?: unknown }).recommendationsCount }).toEqual({
        has: true,
        value: null,
      });
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Подметрики, правило языка в кабинете, route.path.
// ---------------------------------------------------------------------------

describe("П4: подметрики, язык кабинета, 404", () => {
  test("П4.2: составное значение подметрики не печатается JSON (MD и страница)", () => {
    const { card, close } = fixtureCard("full");
    try {
      const md = renderRepoReport(card);
      const readmeRow = md.split("\n").find((l) => /^\| (readme|README)/.test(l)) ?? "";
      const mirrorRow = md.split("\n").find((l) => /^\| (mirror_likeness|Похожесть на зеркало)/.test(l)) ?? "";
      expect({
        readmeJson: readmeRow.includes("{"),
        mirrorJson: mirrorRow.includes("{"),
        pageJson: src("web/RepoPage.tsx").includes("fmtFactValue(roundFacts(sub.value))"),
      }).toEqual({ readmeJson: false, mirrorJson: false, pageJson: false });
    } finally {
      close();
    }
  });

  test("П4.3: в пользовательских строках MePage.tsx нет длинного тире (кроме глифа «нет данных») и нет «ё»", () => {
    const code = stripComments(src("web/MePage.tsx"));
    // глиф «нет данных» — строковый литерал ровно из одного «—»
    const withoutGlyph = code.replace(/(["'`])—\1/g, "");
    expect({ dashes: (withoutGlyph.match(/—/g) ?? []).length, yo: (code.match(/[ёЁ]/g) ?? []).length }).toEqual({ dashes: 0, yo: 0 });
  });

  test("П4.4: not-found больше не несет route.path", () => {
    expect(parseRoute("/unknown/page")).toEqual({ kind: "not-found" } as ReturnType<typeof parseRoute>);
  });
});

// ---------------------------------------------------------------------------
// Единый формат дат UI (месяцы закрытой таблицей, время первым).
// ---------------------------------------------------------------------------

describe("П5: формат дат UI", () => {
  // UX 17.10: fmtDateTime — дата, запятая, время
  test("fmtDate — «15 сент. 2026» (без времени), fmtDateTime — «18 янв. 2023, 12:00»", () => {
    expect({
      date: fmtDate(new Date(2026, 8, 15, 12, 0).toISOString()),
      dateTime: fmtDateTime(new Date(2023, 0, 18, 12, 0).toISOString()),
    }).toEqual({ date: "15 сент. 2026", dateTime: "18 янв. 2023, 12:00" });
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без нее «AUDIT_STRICT=1 зеленый» – тавтология.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const self = readFileSync(import.meta.path, "utf8");
    const parked = self.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
