// В5.3, круг 2 (решения владельца, §2 24.09 «В5.3, круг 2»): К-5 — место и
// названия факторов раздела фрода; К-7 — AI-описание в MD/PDF только зрителю с
// правами на полный Score, официальным названием модели. Поведенческие тесты на
// временной БД: «равно источнику» и «без прав не раскрывается» (AGENTS.md 21.09).
import { describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import type { AccessResult } from "../src/auth/access";
import { fmtDateUtc, fraudFactorFact, fraudFactorTitle } from "../src/web/format";
import { renderRepoReport } from "../src/report/markdown";
import { aiModelName } from "../src/web/format";
import { cardFacts, makeApiDb, seedRepo, type ApiTestDb } from "./api-fixtures";
import { scoredScan } from "./report-fixtures";

const GRANTED: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
const NO_PAT: AccessResult = { cicd: "no-pat", appsec: "no-pat", repo: "no-pat" };
const OVERVIEW = "Репозиторий живой: README есть, задачи закрываются.\nСлабое место – нет CONTRIBUTING.";
const DOCS = "Документация покрывает запуск, но не сборку.";

function seeded(): { t: ApiTestDb; card: (access: AccessResult) => ReturnType<typeof getRepoCard> } {
  const t = makeApiDb();
  const repoId = seedRepo(t, { org: "v53", repo: "ai" });
  const scanId = scoredScan(t, repoId, { status: "ok", trigger: "periodic", facts: cardFacts() });
  const note = (role: string, text: string): void => {
    t.db
      .query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(repoId, scanId, role, text, "[]", "1", "yandexgpt", "2026-09-16T12:00:00.000Z");
  };
  note("overview", OVERVIEW);
  note("documentation", DOCS);
  note("flagger", JSON.stringify({ flag: true, factors: [{ key: "activity.git.timeline", note: "всплеск коммитов одного автора" }] }));
  return { t, card: (access) => getRepoCard(t.db, "v53", "ai", { access, viewerAuth: access === GRANTED ? "pat" : "no-session" }) };
}

describe("К-7: AI-описание в отчете", () => {
  test("с правами на полный Score — текст равен заметке, модель названа официально", () => {
    const { t, card } = seeded();
    try {
      const md = renderRepoReport(card(GRANTED)!);
      expect(md).toContain("## AI-обзор репозитория"); // В5.3 круг 3: заголовок раздела
      expect(md).toContain("Репозиторий живой: README есть, задачи закрываются.");
      expect(md).toContain("Слабое место – нет CONTRIBUTING.");
      expect(md).toContain(DOCS);
      expect(md).toContain("**Документация**");
      expect(md).toContain("моделью YandexGPT Pro 5 по фактам анализа");
      expect(md).not.toContain("yandexgpt");
    } finally {
      t.close();
    }
  });

  // В5.2 (Б2, §2 «В5.2 — публичный AI-обзор…» п.1-2; пересматривает К-7 (а) и К-3 (а)):
  // без прав документ печатает только то, что зритель видит на карточке — полный
  // текст (все факты) не печатается; метка фрода видна всем
  test("без прав — полного текста и раздела нет, подозрение фрода печатается", () => {
    const { t, card } = seeded();
    try {
      const md = renderRepoReport(card(NO_PAT)!);
      expect(md).not.toContain("AI-обзор репозитория");
      expect(md).not.toContain("Репозиторий живой");
      expect(md).not.toContain(DOCS);
      expect(md).toContain("Подозрение на искусственную активность");
    } finally {
      t.close();
    }
  });

  test("заметок нет — раздела нет", () => {
    const t = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "v53", repo: "bare" });
      scoredScan(t, repoId, { status: "ok", trigger: "periodic", facts: cardFacts() });
      const md = renderRepoReport(getRepoCard(t.db, "v53", "bare", { access: GRANTED, viewerAuth: "pat" })!);
      expect(md).not.toContain("AI-обзор репозитория");
    } finally {
      t.close();
    }
  });

  test("официальные названия: псевдонимы latest/rc и полный URI", () => {
    expect(aiModelName("yandexgpt")).toBe("YandexGPT Pro 5");
    expect(aiModelName("gpt://b1gfolder/yandexgpt/latest")).toBe("YandexGPT Pro 5");
    expect(aiModelName("yandexgpt/rc")).toBe("YandexGPT Pro 5.1");
    expect(aiModelName("yandexgpt-5.1")).toBe("YandexGPT Pro 5.1");
    expect(aiModelName("yandexgpt-lite")).toBe("YandexGPT Lite 5");
    expect(aiModelName("glm-5.3")).toBe("glm-5.3");
  });
});

describe("К-5: раздел фрода — после ограничений данных, факторы названиями", () => {
  test("порядок: Ограничения данных → Подозрение → Описание для менеджера → разбор и приложения", () => {
    const { t, card } = seeded();
    try {
      const md = renderRepoReport(card(GRANTED)!);
      const at = (s: string): number => md.indexOf(s);
      expect(at("## Рекомендации")).toBeGreaterThan(-1);
      expect(at("## Подозрение на искусственную активность")).toBeGreaterThan(at("## Рекомендации"));
      if (at("## Ограничения данных") > -1) expect(at("## Подозрение на искусственную активность")).toBeGreaterThan(at("## Ограничения данных"));
      expect(at("## AI-обзор репозитория")).toBeGreaterThan(at("## Подозрение на искусственную активность"));
      expect(at("### А. Расчет итоговой оценки")).toBeGreaterThan(at("## AI-обзор репозитория"));
      // В5.3 круг 3 (способ 2): текст фактора строит код из факта; нет факта — формулировка модели
      const timeline = card(GRANTED)!.evidence.find((e) => e.key === "activity.git.timeline")?.value;
      expect(md).toContain(`**История коммитов** – ${fraudFactorFact("activity.git.timeline", timeline, fmtDateUtc) ?? "всплеск коммитов одного автора"}`);
      expect(md).not.toContain("**activity.git.timeline**");
    } finally {
      t.close();
    }
  });

  test("каждый ключ, который видит флаггер, — своим названием; неизвестный — как есть", () => {
    expect(fraudFactorTitle("activity.git.timeline")).toBe("История коммитов");
    expect(fraudFactorTitle("activity.git.summary")).toBe("Сводка истории git");
    expect(fraudFactorTitle("activity.rest")).toBe("Участники, релизы и запросы на слияние");
    expect(fraudFactorTitle("activity.new_kind")).toBe("activity.new_kind");
  });
});
