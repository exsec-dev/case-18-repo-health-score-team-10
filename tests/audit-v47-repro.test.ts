// audit-v47-repro.test.ts — репро-трипваи вехи В4.7 (блок Б0).
// Закон вехи: reports/2026-09-20-m47-plan.md, ревизия 4 (контракты П1–П5),
// одноразовый промпт workers/V4.7-oneshot.md, решения владельца — TASK.md §2
// (записи 21.09 про В4.7).
//
// Механика — как в audit-v46r2-repro.test.ts: находка стоит под обёрткой
// `repro` — в обычном прогоне это `test.failing` (набор зелёный), под
// AUDIT_STRICT=1 — обычный `test`, то есть красный, пока находка не закрыта.
// Закрытая находка выходит из-под обёртки в закрывшем её блоке, утверждение
// при этом НЕ меняется. В конце файла — strict-самопроверка «ни одной находки
// под repro», иначе «зелёный строгий режим» был бы тавтологией.
//
// Живых запросов нет: API и MD — чистые функции на временной БД, UI-ветки —
// source-assert (приём tests/me.test.ts) или чистый хелпер. Числа (фасеты,
// счётчик) — поведенческие, на данных (правило AGENTS.md 21.09).
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
// П1 — PDF: пункт меню «PDF (.pdf)» с пустым обработчиком и нет маршрута.
// ---------------------------------------------------------------------------

describe("П1: PDF-выгрузка", () => {
  test("кнопка PDF качает файл, а не молчит (ReportMenu без пустого обработчика)", () => {
    const menu = between(src("web/RepoPage.tsx"), "function ReportMenu", "\n}\n");
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
// П2 — повторяемый lang и цвет языка в фасете.
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
// П3 — кабинет: плашка про PAT, формулировки, глифы прав, счётчик.
// ---------------------------------------------------------------------------

describe("П3: кабинет «Мои репозитории»", () => {
  const me = (): string => stripComments(src("web/MePage.tsx"));
  const section = (): string => between(me(), "function MyReposSection", "\nfunction RepoRow");

  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (круг 2 части 2 В4.9, Е17 / W1): плашка из 3 шагов
  // снята, вернулось предупреждение «нет токена» одной строкой с кнопкой на /settings.
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

  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (круг 2 части 2 В4.9, Е17 / Е18): кроме обертки
  // `CabinetAlert` Alert стоит в 2 местах с особым видом — предупреждение «нет
  // токена» одной строкой (W1, `layout="horizontal"`) и плашка «Токен
  // показывается один раз» (Н1, `view="filled"`); у всех — `<Alert theme=`.
  test("П3.4 → Е17/Е18: Alert — обертка и 2 места с особым видом", () => {
    const alerts = me().match(/<Alert\b[^>]*/g) ?? [];
    expect(alerts.length).toBe(3);
    // круг 3 (10): кнопка под текстом — горизонтальной раскладки нет, иконка — синим
    expect(me()).not.toContain('layout="horizontal"');
    expect(me()).toContain('className="rh-info-icon"');
    expect(me()).toMatch(/<Alert theme="warning" view="filled" size="s" message="Токен показывается один раз/);
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
// П4 — подметрики, правило языка в кабинете, route.path.
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
// П5 — единый формат дат UI (месяцы закрытой таблицей, время первым).
// ---------------------------------------------------------------------------

describe("П5: формат дат UI", () => {
  test("fmtDate — «15 сент. 2026» (без времени), fmtDateTime — «12:00 18 янв. 2023»", () => {
    expect({
      date: fmtDate(new Date(2026, 8, 15, 12, 0).toISOString()),
      dateTime: fmtDateTime(new Date(2023, 0, 18, 12, 0).toISOString()),
    }).toEqual({ date: "15 сент. 2026", dateTime: "12:00 18 янв. 2023" });
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без неё «AUDIT_STRICT=1 зелёный» — тавтология.
// На Б0-коммите этот тест красный вместе с находками.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const self = readFileSync(import.meta.path, "utf8");
    const parked = self.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
