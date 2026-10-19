// Согласованность отчета и карточки:
//
//   - подписи полосы вклада не наезжают друг на друга ни при каком
//     распределении (намеренно малые соседние сегменты);
//   - место в рейтинге в отчете = место карточки, приватному места нет;
//   - метка «данные из прошлого анализа» у строки категории отчета ⇔
//     плашка у категории на карточке;
//   - предупреждение о потолке CI в отчете ⇔ предупреждение карточки;
//   - оговорки рекомендаций (CODEOWNERS у 1-2 авторов, CI у зеркала) и
//     сильная сторона у здоровой категории: меняется только текст, условие,
//     эффект и порядок правил прежние;
//   - поле карточки `repo.badge` = ответ маршрута `badge.svg`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pdfmake from "pdfmake";
import { getRepoCard, listRepos, parseReposQuery, type RepoCard } from "../src/api/repos";
import type { AccessResult } from "../src/auth/access";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { buildReportModel } from "../src/report/build";
import { serializeMarkdown } from "../src/report/markdown";
import { textWidth } from "../src/report/metrics";
import type { Block, ReportModel } from "../src/report/model";
import { CONTENT_W, FONT_DIR, FONT_FILES, SEG_LABEL_GAP, SEG_LABEL_H, buildPdfDocument, placeSegmentLabels, type SegmentSlot } from "../src/report/pdf";
import { whyText } from "../src/report/sections";
import { submetricContext } from "../src/report/submetrics";
import { recommendFromFacts, recommendationText } from "../src/score/recommend";
import { cardView } from "../src/web/cardView";
import { CI_CAP_TEXT, CI_CAP_TITLE, NO_RANK_NOT_PUBLIC, STALE_CATEGORY_MARK } from "../src/web/format";
import { cardFacts, makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { REPORT_FIXTURES, fixtureCard } from "./report-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

/** Все строки `text` дерева описания pdfmake по порядку (как в report-pdf.test.ts; импорт тест-файла повторил бы его тесты). */
function pdfTreeText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const n of node) pdfTreeText(n, out);
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("text" in o) pdfTreeText(o.text, out);
    for (const key of ["stack", "columns", "ul", "ol"]) if (key in o) pdfTreeText(o[key], out);
    if ("table" in o) pdfTreeText((o.table as { body: unknown }).body, out);
  }
  return out;
}

const GRANTED: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
const ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Подписи полосы вклада
// ---------------------------------------------------------------------------

type Contrib = Extract<Block, { kind: "contributions" }>;
const seg = (title: string, v: number) => ({ title, value: `+${v.toFixed(1).replace(".", ",")}`, share: v / 100 });
const bar = (segments: ReturnType<typeof seg>[], rest: number): Contrib => ({
  kind: "contributions",
  title: "Вклад категорий в оценку",
  segments,
  rest: { title: "не набрано", value: String(rest), share: rest / 100 },
  zones: [
    { theme: "danger", text: "в зоне риска 0-39", share: 0.4 },
    { theme: "warning", text: "требует внимания 40-69", share: 0.3 },
    { theme: "success", text: "здоров 70-100", share: 0.3 },
  ],
  note: null,
});

/** Распределения с намеренно малыми соседними сегментами: крайний случай проверяется отдельно, живые данные его не покажут. */
const CROWDED: Record<string, Contrib> = {
  "три малых соседа посередине": bar([seg("Документация", 30), seg("CI/CD", 1.2), seg("Безопасность", 0.8), seg("Активность", 1.5), seg("Задачи", 20), seg("Состояние кода", 16)], 31),
  "малые у обоих краев и малый остаток": bar([seg("Документация", 0.5), seg("CI/CD", 0.4), seg("Безопасность", 40), seg("Активность", 30), seg("Задачи", 26.8), seg("Состояние кода", 1.5)], 1),
  "все сегменты малые": bar([seg("Документация", 1), seg("CI/CD", 1), seg("Безопасность", 1), seg("Активность", 1), seg("Задачи", 1), seg("Состояние кода", 1)], 94),
  "один малый между крупными": bar([seg("Документация", 12.7), seg("Активность", 12.2), seg("Задачи", 1.4), seg("Состояние кода", 24.8)], 49),
  "нужен второй ряд": bar([seg("Документация", 9), seg("CI/CD", 3), seg("Безопасность", 9), seg("Активность", 2), seg("Задачи", 12), seg("Состояние кода", 30)], 35),
  "малый остаток у правого края": bar([seg("Документация", 23), seg("Активность", 23), seg("Задачи", 22.5), seg("Состояние кода", 30.5)], 1),
};

interface Box {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Подписи и засечки блока вклада из дерева описания pdfmake: подпись — узел с
 * `relativePosition` (ширина — по метрикам Inter, как у раскладки), засечка —
 * вертикальная линия canvas.
 */
function layoutOf(node: Record<string, unknown>): { labels: Box[]; ticks: { x: number; y0: number; y1: number }[]; legend: string | null } {
  const inner = (node.stack as Record<string, unknown>[])[1]!;
  const children = (inner.stack as Record<string, unknown>[] | undefined) ?? null;
  if (children === null) {
    // легенда: полоса и строка подписей под ней
    const legend = pdfTreeText((node.stack as unknown[])[2]).join("");
    const canvas = (inner.canvas as Record<string, number | string>[]).filter((s) => s.type === "line" && s.lineColor !== "#ffffff");
    return { labels: [], ticks: canvas.map((l) => ({ x: l.x1 as number, y0: Math.min(l.y1 as number, l.y2 as number), y1: Math.max(l.y1 as number, l.y2 as number) })), legend };
  }
  const labels: Box[] = [];
  let canvas: Record<string, number | string>[] = [];
  for (const c of children) {
    if (c.canvas) canvas = c.canvas as Record<string, number | string>[];
    if (!c.relativePosition) continue;
    const [title, value] = c.stack as { text: string; alignment: string }[];
    const lw = Math.max(textWidth(FONT_DIR, FONT_FILES.normal, title!.text, 7.5), textWidth(FONT_DIR, FONT_FILES.bold, value!.text, 8));
    const pos = c.relativePosition as { x: number; y: number };
    const x0 = title!.alignment === "right" ? CONTENT_W - lw : pos.x;
    labels.push({ text: `${title!.text} ${value!.text}`, x0, x1: x0 + lw, y0: pos.y, y1: pos.y + SEG_LABEL_H });
  }
  const ticks = canvas
    .filter((s) => s.type === "line" && s.lineColor !== "#ffffff")
    .map((l) => ({ x: l.x1 as number, y0: Math.min(l.y1 as number, l.y2 as number), y1: Math.max(l.y1 as number, l.y2 as number) }));
  return { labels, ticks, legend: null };
}

function contribNode(block: Contrib): Record<string, unknown> {
  const model: ReportModel = { title: "t", fileStem: "t", footer: "t", runningHead: ["t", "t"], aiSummary: null, blocks: [block] };
  return (buildPdfDocument(model).content as Record<string, unknown>[])[0]!;
}

/** Инварианты вёрстки: подписи не пересекаются, засечка не проходит сквозь чужую подпись, все внутри полосы набора. */
function expectNoCollisions(block: Contrib): void {
  const { labels, ticks, legend } = layoutOf(contribNode(block));
  const all = [...block.segments, ...(block.rest ? [block.rest] : [])];
  if (legend !== null) {
    // легенда: каждая подпись один раз и в порядке сегментов
    let at = 0;
    for (const s of all) {
      const i = legend.indexOf(`${s.title} ${s.value}`, at);
      expect(i).toBeGreaterThanOrEqual(at);
      at = i + 1;
    }
    return;
  }
  expect(labels.map((l) => l.text)).toEqual(all.map((s) => `${s.title} ${s.value}`));
  for (const l of labels) {
    expect(l.x0).toBeGreaterThanOrEqual(-0.01);
    expect(l.x1).toBeLessThanOrEqual(CONTENT_W + 0.01);
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!;
      const b = labels[j]!;
      const overlapX = a.x0 < b.x1 + SEG_LABEL_GAP - 0.01 && b.x0 < a.x1 + SEG_LABEL_GAP - 0.01;
      const overlapY = a.y0 < b.y1 - 0.01 && b.y0 < a.y1 - 0.01;
      expect({ a: a.text, b: b.text, collide: overlapX && overlapY }).toEqual({ a: a.text, b: b.text, collide: false });
    }
  }
  for (const t of ticks) {
    for (const l of labels) {
      const insideX = t.x > l.x0 - 0.5 && t.x < l.x1 + 0.5;
      const insideY = t.y0 < l.y1 - 0.5 && t.y1 > l.y0 + 0.5;
      expect({ tick: t.x, label: l.text, crosses: insideX && insideY }).toEqual({ tick: t.x, label: l.text, crosses: false });
    }
  }
}

describe("П-3: подписи полосы вклада не наезжают друг на друга", () => {
  test.each(Object.keys(CROWDED))("%s: подписи не пересекаются, засечки не проходят сквозь подписи", (name) => {
    expectNoCollisions(CROWDED[name]!);
  });

  test.each([...REPORT_FIXTURES])("фикстура %s: те же инварианты у настоящих полос вклада", (name) => {
    const { card, close } = fixtureCard(name);
    try {
      for (const b of buildReportModel(card).blocks) if (b.kind === "contributions" && b.note === null) expectNoCollisions(b);
    } finally {
      close();
    }
  });

  test("раскладка: второй ряд — когда первого не хватает; не хватает двух — легенда, а не наложение", () => {
    const two = layoutOf(contribNode(CROWDED["нужен второй ряд"]!));
    expect(two.legend).toBeNull();
    // подписей в трех и более уровнях по высоте — значит использован второй ряд
    expect(new Set(two.labels.map((l) => Math.round(l.y0))).size).toBeGreaterThan(2);
    const legend = layoutOf(contribNode(CROWDED["все сегменты малые"]!));
    expect(legend.labels).toEqual([]);
    expect(legend.legend).toContain("Документация +1,0");
    // обычное распределение – один ряд над и один под полосой
    const plain = layoutOf(contribNode(bar([seg("Документация", 21), seg("Активность", 18.4), seg("Задачи", 11.8), seg("Состояние кода", 18.8)], 30)));
    expect(new Set(plain.labels.map((l) => Math.round(l.y0))).size).toBe(2);
  });

  test("placeSegmentLabels: подпись у правого края не выходит за полосу, соседи ряда — с зазором", () => {
    const slots: SegmentSlot[] = [
      { x0: 0, w: 480, lw: 60, tick: true, right: false },
      { x0: 480, w: 10, lw: 70, tick: true, right: false },
      { x0: 490, w: 9, lw: 50, tick: false, right: true },
    ];
    const places = placeSegmentLabels(slots, 499)!;
    expect(places).not.toBeNull();
    for (const p of places) expect(p.b).toBeLessThanOrEqual(499);
    for (let i = 0; i < places.length; i++)
      for (let j = i + 1; j < places.length; j++) {
        const [a, b] = [places[i]!, places[j]!];
        if (a.side === b.side && a.lane === b.lane) expect(a.b + SEG_LABEL_GAP <= b.a || b.b + SEG_LABEL_GAP <= a.a).toBe(true);
      }
  });

  test("отрисовка: PDF с тесными полосами собирается (подписи с relativePosition внутри неразрывного блока)", async () => {
    const model: ReportModel = { title: "t", fileStem: "t", footer: "t", runningHead: ["t", "t"], aiSummary: null, blocks: Object.values(CROWDED) };
    const pdf = await pdfmake.createPdf(buildPdfDocument(model)).getBuffer();
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

// ---------------------------------------------------------------------------
// Место в рейтинге – число карточки, приватному места нет
// ---------------------------------------------------------------------------

function passportRank(card: RepoCard): string | null {
  const md = serializeMarkdown(buildReportModel(card));
  const m = /^\| Место в рейтинге \| (.+) \|$/m.exec(md);
  return m ? m[1]! : null;
}

describe("С14: место в рейтинге в отчете", () => {
  test("публичный оцененный: «#N из M» = место карточки = позиция строки рейтинга", () => {
    const t = makeApiDb();
    try {
      const facts = cardFacts();
      for (const [repo, total] of [["top", 90], ["mid", 70], ["low", 50]] as const) {
        const id = seedRepo(t, { org: "rank", repo });
        seedScore(t, id, seedScan(t, id, { facts }), { total });
      }
      const card = getRepoCard(t.db, "rank", "mid", { access: GRANTED })!;
      const parsed = parseReposQuery(new URLSearchParams());
      if (!parsed.ok) throw new Error("query");
      const rating = listRepos(t.db, parsed.query);
      const row = rating.items.find((i) => i.repo === "mid")!;
      expect(card.score!.rank).toBe(row.rank);
      expect(passportRank(card)).toBe(`#${row.rank} из ${card.score!.rankedTotal}`);
      expect(passportRank(card)).toBe("#2 из 3");
    } finally {
      t.close();
    }
  });

  test("приватный с индексом: места нет — строка «не в публичном рейтинге», без числа", () => {
    const t = makeApiDb();
    try {
      const facts = cardFacts();
      const pub = seedRepo(t, { org: "rank", repo: "pub" });
      seedScore(t, pub, seedScan(t, pub, { facts }), { total: 40 });
      const priv = seedRepo(t, { org: "rank", repo: "priv" });
      t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
      seedScore(t, priv, seedScan(t, priv, { facts }), { total: 95 });
      const card = getRepoCard(t.db, "rank", "priv", { access: GRANTED })!;
      expect(card.score!.healthcraftIndex).toBe(95);
      expect(passportRank(card)).toBe(NO_RANK_NOT_PUBLIC);
      expect(serializeMarkdown(buildReportModel(card))).not.toMatch(/#\d+ из \d+/);
    } finally {
      t.close();
    }
  });

  test("паспорт карточки печатает то же правило, а не прочерк «нет данных»", () => {
    const page = readFileSync(join(ROOT, "src", "web", "RepoPage.tsx"), "utf8");
    const aside = page.slice(page.indexOf('name="Место в рейтинге"'), page.indexOf('name="Место в рейтинге"') + 400);
    expect(aside).toContain("rankText(card.repo.visibility, score)");
    expect(aside).not.toContain(': "–"');
  });
});

// ---------------------------------------------------------------------------
// Метка «данные из прошлого анализа» ⇔ плашка категории на карточке
// ---------------------------------------------------------------------------

describe("С13: метка у строки категории отчета", () => {
  function staleCard(t: ApiTestDb): RepoCard {
    const id = seedRepo(t, { org: "st", repo: "r" });
    const cats = { issues: { score: 40, stale: true, submetrics: { stale: { score: 0.4, value: 0.5 } } } };
    seedScore(t, id, seedScan(t, id, { facts: cardFacts() }), { total: 60, categories: cats, stale: ["issues.stats"] });
    return getRepoCard(t.db, "st", "r", { access: GRANTED })!;
  }

  test("метка стоит ровно у тех строк, где карточка рисует плашку, и тем же текстом", () => {
    const t = makeApiDb();
    try {
      const card = staleCard(t);
      const view = cardView(card);
      const model = buildReportModel(card);
      const rows = (model.blocks.find((b) => b.kind === "categories") as Extract<Block, { kind: "categories" }>).rows;
      const cardStale = new Map(view.categories.map((c) => [c.title, c.stale]));
      expect([...cardStale.values()].filter(Boolean).length).toBe(1);
      for (const row of rows) {
        if (!cardStale.has(row.name)) continue;
        expect({ name: row.name, mark: row.mark?.text ?? null }).toEqual({ name: row.name, mark: cardStale.get(row.name) ? STALE_CATEGORY_MARK : null });
      }
      const md = serializeMarkdown(model);
      expect(md).toMatch(new RegExp(`^\\| Задачи \\| 40 \\| требует внимания \\| \\*\\*${STALE_CATEGORY_MARK}\\.\\*\\* `, "m"));
      // PDF: та же метка плашкой над «почему» (сверка слов PDF = MD — в report-pdf.test.ts)
      expect(pdfTreeText(buildPdfDocument(model).content).join(" ")).toContain(STALE_CATEGORY_MARK);
      // карточка рисует ту же константу
      expect(readFileSync(join(ROOT, "src", "web", "RepoPage.tsx"), "utf8")).toContain("{STALE_CATEGORY_MARK}");
    } finally {
      t.close();
    }
  });

  test("без устаревших данных метки нет ни у одной строки", () => {
    for (const name of REPORT_FIXTURES) {
      const { card, close } = fixtureCard(name);
      try {
        const rows = (buildReportModel(card).blocks.find((b) => b.kind === "categories") as Extract<Block, { kind: "categories" }>).rows;
        expect(rows.filter((r) => r.mark !== null)).toEqual([]);
      } finally {
        close();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Потолок CI – отчет говорит то же, что карточка
// ---------------------------------------------------------------------------

describe("С19: предупреждение о потолке CI", () => {
  test.each([...REPORT_FIXTURES])("фикстура %s: предупреждение в отчете ⇔ предупреждение карточки, по одному разу", (name) => {
    const { card, close } = fixtureCard(name);
    try {
      const md = serializeMarkdown(buildReportModel(card));
      const onCard = cardView(card).topMarkers.includes("ci-cap");
      expect(md.split(CI_CAP_TEXT).length - 1).toBe(onCard ? 1 : 0);
      expect(md.includes(CI_CAP_TITLE)).toBe(onCard);
    } finally {
      close();
    }
  });

  test("у grant-ci (CI открыт, запусков не видно) предупреждение есть — фикстура покрывает ветку", () => {
    const { card, close } = fixtureCard("grant-ci");
    try {
      expect(card.markers.ciConfigOnlyCap).toBe(true);
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// Оговорки рекомендаций и «почему» здоровой категории
// ---------------------------------------------------------------------------

describe("Г1.21: только текст — условие, эффект и порядок правил те же", () => {
  const facts = (): Map<string, unknown> =>
    new Map<string, unknown>([
      ["docs.presence", { readme: true, license: true, contributing: false, codeowners: false }],
      ["cicd.configs", { has_ci_yaml: false, has_steps: false }],
      ["cicd.runs", { runs_count: 3, runs_total: 3, last_status: "success", success_rate: 1 }],
    ]);
  const run = (authors: number | null) =>
    recommendFromFacts(facts(), { delta: () => ({ delta: 2.5, reason: null }), issuesScore: 50, authors }).map((r) => ({ ...r }));

  test("CODEOWNERS у 1-2 авторов — задел на будущее; с 3 авторов и без числа — прежний текст", () => {
    const base = run(null);
    for (const n of [1, 2, 3, null]) {
      const recs = run(n);
      // условие и эффект правил от числа авторов не зависят
      expect(recs.map((r) => [r.ruleId, r.priority, r.deltaScore, r.expectedImpact, r.action])).toEqual(base.map((r) => [r.ruleId, r.priority, r.deltaScore, r.expectedImpact, r.action]));
      const problem = recs.find((r) => r.ruleId === "codeowners-missing")!.problem;
      if (n === 1) expect(problem).toContain("Пока автор один,");
      if (n === 2) expect(problem).toContain("Пока авторов двое,");
      if (n === 1 || n === 2) expect(problem).toContain("хватит одной строки с вашим логином");
      else expect(problem).toBe("Не указано, кто отвечает за код. С CODEOWNERS предложения изменений сразу попадают к ответственным.");
    }
  });

  test("CI без ci.yaml — оговорка про зеркало, эффект прежний", () => {
    const text = recommendationText("ci-missing", { delta: 1.2, channel: "cicd" })!;
    expect(text.problem).toContain("Если репозиторий – зеркало, сборка может идти у источника");
    expect(text.expectedImpact).toBe("+1,2 к Repo Health Score");
  });

  test("карточка и отчет: у репо одного автора совет CODEOWNERS звучит как задел (число авторов — показатель карточки)", () => {
    const t = makeApiDb();
    try {
      const id = seedRepo(t, { org: "g121", repo: "solo" });
      const scan = seedScan(t, id, { facts: cardFacts() });
      seedScore(t, id, scan, { total: 60, categories: { activity: { score: 70, submetrics: { contributors: { score: 0.3, value: 1 } } } } });
      seedRecommendation(t, scan, { ruleId: "codeowners-missing", priority: 1, factRef: "docs.presence", deltaScore: 3.5, expectedImpact: "+3,5 к HealthCraft Index" });
      const card = getRepoCard(t.db, "g121", "solo", { access: GRANTED })!;
      const rec = card.recommendations.find((r) => r.ruleId === "codeowners-missing")!;
      expect(rec.problem).toContain("Пока автор один,");
      expect(rec.deltaScore).toBe(3.5);
      expect(serializeMarkdown(buildReportModel(card))).toContain("Пока автор один,");
    } finally {
      t.close();
    }
  });

  test("«почему» здоровой категории — сначала сильная сторона; у категории ниже 70 — только слабые", () => {
    const ctx = submetricContext("2026-09-16T12:00:00Z");
    const subs = { root: { score: 1, value: 1 }, old_share: { score: 0.6, value: 0.4 } };
    const healthy = whyText("code", { score: 80, submetrics: subs, weight: 20 } as never, ctx);
    expect(healthy.startsWith("Сильная сторона: ")).toBe(true);
    expect(healthy).toContain("Слабее: ");
    const weak = whyText("code", { score: 55, submetrics: subs, weight: 20 } as never, ctx);
    expect(weak).not.toContain("Сильная сторона");
    // все показатели на максимуме – общая фраза
    expect(whyText("code", { score: 100, submetrics: { root: { score: 1, value: 1 } }, weight: 20 } as never, ctx)).toBe("Все показатели категории на максимуме.");
  });
});

// ---------------------------------------------------------------------------
// Доступность бейджа – поле карточки, а не пробный запрос
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const servers: SpawnedServer[] = [];
const mocks: { stop(): void }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const m of mocks) m.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("П-2: repo.badge = ответ маршрута badge.svg", () => {
  test("публичный оцененный, публичный без оценки, приватный, internal: поле карточки = статус маршрута", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v55-badge-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => {} } as ApiTestDb;
    const pub = seedRepo(t, { org: "bdg", repo: "rated" });
    seedScore(t, pub, seedScan(t, pub, { facts: cardFacts() }), { total: 70 });
    seedRepo(t, { org: "bdg", repo: "fresh" });
    for (const [repo, visibility] of [["priv", "private"], ["int", "internal"]] as const) {
      const id = seedRepo(t, { org: "bdg", repo });
      seedScore(t, id, seedScan(t, id, { facts: cardFacts() }), { total: 80 });
      db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(visibility, id);
    }
    const fields = new Map(["rated", "fresh", "priv", "int"].map((r) => [r, getRepoCard(db, "bdg", r, { access: GRANTED })!.repo.badge]));
    db.close();
    const mock = startMockApi();
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock });
    servers.push(server);
    for (const [repo, field] of fields) {
      const res = await fetch(`${server.base}/api/v1/repos/bdg/${repo}/badge.svg`);
      await res.arrayBuffer();
      expect({ repo, field, route: res.status === 200 }).toEqual({ repo, field: res.status === 200, route: res.status === 200 });
    }
    // обе ветки покрыты: и есть, и нет
    expect([...fields.values()].sort()).toEqual([false, false, true, true]);
  }, 120_000);

  test("фронтенд не пробует badge.svg запросом: кнопка и пункт меню — от поля карточки", () => {
    const v5 = readFileSync(join(ROOT, "src", "web", "RepoV5.tsx"), "utf8");
    const page = readFileSync(join(ROOT, "src", "web", "RepoPage.tsx"), "utf8");
    expect(v5).not.toMatch(/fetch\([^)]*badge\.svg/);
    expect(v5).not.toContain("useBadgeAvailable");
    // кнопка — от полей карточки (и списка своих репо), не от пробного запроса
    expect(page).toContain("card.repo.badge || card.repo.badgeKey !== undefined");
  });
});
