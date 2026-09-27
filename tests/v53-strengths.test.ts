// Строка «Сильные стороны / Слабые стороны» под заголовком «Категории» карточки
// и MD/PDF. Утверждение о данных проверяется на данных: пустые и крайние
// состояния, tri-state, закрытые каналы, пустой репо.
import { afterAll, describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import type { AccessResult } from "../src/auth/access";
import { strengthsLine } from "../src/report/sections";
import { renderRepoReport } from "../src/report/markdown";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const dbs: ApiTestDb[] = [];
afterAll(() => {
  for (const t of dbs) {
    try {
      t.close();
    } catch {}
  }
});

const cat = (score: number | null) => (score === null ? { score: null, no_data: "issues channel no-data", submetrics: {} } : { score, submetrics: {} });

function cardWith(categories: Record<string, unknown>, opts: { access?: AccessResult; codeEmpty?: boolean } = {}) {
  const t = makeApiDb();
  dbs.push(t);
  const id = seedRepo(t, { org: "st", repo: "r" });
  seedScore(t, id, seedScan(t, id, { facts: cardFacts() }), { total: 70, categories });
  if (opts.codeEmpty) t.db.query("UPDATE scores SET code_empty = 1 WHERE repo_id = ?").run(id);
  return getRepoCard(t.db, "st", "r", opts.access ? { access: opts.access } : {})!;
}

describe("К-4: сильные стороны / требует внимания — на данных", () => {
  test("до 2 лучших от 70 и до 2 худших ниже 70, по убыванию и возрастанию балла", () => {
    const card = cardWith({ documentation: cat(90), activity: cat(75), issues: cat(40), code: cat(99) });
    expect(strengthsLine(card)).toBe("Сильные стороны: состояние кода, документация. Слабые стороны: задачи.");
  });

  test("все от 70 — только сильные; все ниже 70 — только «требует внимания»; утверждения «слабых нет» нет", () => {
    expect(strengthsLine(cardWith({ documentation: cat(90), activity: cat(80), issues: cat(70), code: cat(85) }))).toBe(
      "Сильные стороны: документация, состояние кода.",
    );
    expect(strengthsLine(cardWith({ documentation: cat(10), activity: cat(30), issues: cat(60), code: cat(50) }))).toBe(
      "Слабые стороны: документация, активность.",
    );
  });

  test("порог — по показанному целому: 69,6 показано как 70 — сильная сторона", () => {
    expect(strengthsLine(cardWith({ documentation: cat(69.6), activity: cat(20), issues: cat(null), code: cat(null) }))).toBe(
      "Сильные стороны: документация. Слабые стороны: активность.",
    );
  });

  test("«нет данных» не участвует ни как сильная, ни как слабая; нет ни одной категории с баллом — строки нет", () => {
    expect(strengthsLine(cardWith({ documentation: cat(null), activity: cat(null), issues: cat(null), code: cat(null) }))).toBeNull();
  });

  test("закрытые зрителю CI/CD и Безопасность не участвуют; открытые — участвуют, «CI/CD» без смены регистра", () => {
    const cats = { documentation: cat(60), activity: cat(65), issues: cat(62), code: cat(66) };
    const anon = cardWith(cats);
    expect(strengthsLine(anon)).not.toContain("CI/CD");
    expect(strengthsLine(anon)).not.toContain("безопасность");
  });

  test("пустой репо (code_empty) — строки нет: оценивать нечего", () => {
    expect(strengthsLine(cardWith({ documentation: cat(90), activity: cat(20), issues: cat(null), code: cat(0) }, { codeEmpty: true }))).toBeNull();
  });

  test("MD-отчет печатает ту же строку под «Категории» (одна копия с карточкой)", () => {
    const card = cardWith({ documentation: cat(90), activity: cat(75), issues: cat(40), code: cat(99) });
    const md = renderRepoReport(card);
    const at = md.indexOf("## Категории");
    expect(at).toBeGreaterThan(-1);
    expect(md.slice(at, at + 200)).toContain(strengthsLine(card)!);
  });
});
