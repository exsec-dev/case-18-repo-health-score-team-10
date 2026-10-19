import { FRAUD_EXPLAIN } from "../src/web/format";
// CI с конфигурацией без запусков, действие, переводящее в следующую зону,
// язык и условие раздела о накрутке, подпись истории оценки. Утверждение о
// данных и пустое состояние проверяются на данных, а не по исходнику.
import { describe, expect, test } from "bun:test";
import type { CardAi, CardRecommendation, RepoCard } from "../src/api/repos";
import { thresholdActions, thresholdNote } from "../src/report/build";
import { renderRepoReport } from "../src/report/markdown";
import { INDEX, FULL } from "../src/report/sections";
import type { HistoryPoint } from "../src/summary/history-contract";
import { scoreHistoryView } from "../src/web/slots";
import { fixtureCard } from "./report-fixtures";

const rec = (patch: Partial<CardRecommendation>): CardRecommendation => ({
  ruleId: "r",
  kind: "presence",
  priority: 1,
  problem: "Проблема.",
  action: "Добавьте README.",
  factRefs: [],
  expectedImpact: null,
  deltaScore: null,
  opensCategory: null,
  source: "rule",
  channel: null,
  ...patch,
});

describe("Г1.17: CI с конфигурацией без запусков", () => {
  test("категория — «нет данных», фразы о половине балла конфигурации в отчете нет", () => {
    const { card, close } = fixtureCard("grant-ci");
    try {
      expect(card.score!.categories.cicd!.score).toBeNull();
      const md = renderRepoReport(card);
      expect(md).not.toContain("половина балла");
      expect(md).not.toContain("Балл категории CI/CD");
    } finally {
      close();
    }
  });
});

describe("Г1.16: строка порога называет одно действие, переводящее в следующую зону", () => {
  test("одно действие с эффектом не меньше разрыва — названо номером, названием и эффектом", () => {
    const note = thresholdNote(68.4, [
      { n: 1, action: "Добавьте лицензию.", delta: 1 },
      { n: 2, action: "Добавьте README.", delta: 2 },
    ])!;
    expect(note).toContain("69 – верхняя граница зоны");
    // 68,4 + 1 = 69,4 → 69: не переводит; 68,4 + 2 = 70,4 → 70: переводит
    expect(note).toContain("Рекомендация 2 одна переводит оценку в эту зону: «Добавьте README» (+2,0).");
    expect(note).not.toContain("Рекомендация 1");
  });

  test("эффекты не складываются: два действия по +1 при разрыве 2 — строка прежняя", () => {
    const base = thresholdNote(68)!;
    expect(thresholdNote(68, [
      { n: 1, action: "А.", delta: 1 },
      { n: 2, action: "Б.", delta: 1 },
    ])).toBe(base);
    expect(base).not.toContain("Рекомендация");
  });

  test("над границей и у отрицательного эффекта — действие не называется", () => {
    expect(thresholdNote(71, [{ n: 1, action: "А.", delta: 5 }])).not.toContain("Рекомендация");
    expect(thresholdNote(68.5, [{ n: 1, action: "А.", delta: -3 }])).not.toContain("Рекомендация");
  });

  test("нижняя граница зоны «риск → внимание» — тот же механизм", () => {
    expect(thresholdNote(38.2, [{ n: 3, action: "Настройте CI.", delta: 2 }])).toContain("Рекомендация 3 одна переводит");
  });

  test("эффект — в шкале своего показателя: индекс — правила без канала, полный Score — канальные", () => {
    const recs = [rec({ deltaScore: 3 }), rec({ deltaScore: 4, channel: "cicd" }), rec({ deltaScore: null }), rec({ deltaScore: 2, channel: "appsec" })];
    expect(thresholdActions(recs, INDEX).map((a) => a.n)).toEqual([1]);
    expect(thresholdActions(recs, FULL).map((a) => a.n)).toEqual([2, 4]);
  });

  test("на данных: отчет у индекса 68,6 с правилом +1,5 называет его; с канальным +5 — нет", () => {
    const { card, close } = fixtureCard("anon");
    try {
      const at = (recs: CardRecommendation[]): RepoCard => ({ ...card, score: { ...card.score!, healthcraftIndex: 68.6 }, recommendations: recs });
      expect(renderRepoReport(at([rec({ deltaScore: 1.5, action: "Добавьте README." })]))).toContain(
        "Рекомендация 1 одна переводит оценку в эту зону: «Добавьте README» (+1,5).",
      );
      expect(renderRepoReport(at([rec({ deltaScore: 5, channel: "cicd" })]))).not.toContain("одна переводит");
    } finally {
      close();
    }
  });
});

describe("К-5: раздел фрода в отчете", () => {
  const withFraud = (card: RepoCard, fraud: CardAi["fraud"]): RepoCard =>
    ({ ...card, ai: { scanId: 1, audience: "full", generatedAt: null, overview: null, specialists: [], failures: [], jobActive: false, cooldownUntil: null, check: { active: false, scanId: null, checkedAt: null, failure: null, retryable: false, latestScanId: null, oldRules: false }, fraud } }) as RepoCard;
  const factors = [{ key: "activity.git.timeline", note: "всплеск коммитов одного автора" }];

  test("флаг поднят — раздел есть, текст по правилу языка", () => {
    const { card, close } = fixtureCard("full");
    try {
      const md = renderRepoReport(withFraud(card, { flag: true, factors }));
      // UX 17.10: заголовок раздела — «Признаки искусственной активности»
      expect(md).toContain("## Признаки искусственной активности");
      expect(md).toContain(FRAUD_EXPLAIN); // тот же текст, что на карточке
      expect(md).not.toMatch(/pattern|нашёл/);
    } finally {
      close();
    }
  });

  test("флаг не поднят, но факторы есть — раздела нет (подозрения нет)", () => {
    const { card, close } = fixtureCard("full");
    try {
      expect(renderRepoReport(withFraud(card, { flag: false, factors }))).not.toContain("## Признаки искусственной активности");
    } finally {
      close();
    }
  });
});

describe("К-2: слот истории оценки — по точкам и правам на историю", () => {
  const pt = (i: number, hci: number | null, rhs: number | null = null): HistoryPoint => ({
    scanId: i,
    finishedAt: null,
    healthcraftIndex: hci,
    indexCoverage: 1,
    repoHealthScore: rhs,
    modelVersion: "m",
    headSha: null,
    codeEmpty: false,
  });

  test("нет точек — пустое состояние, графика нет", () => {
    const v = scoreHistoryView({ points: [], fullOpen: false });
    expect(v.chart).toBe(false);
    expect(v.text).toContain("Пока показывать нечего");
  });

  // UX 17.10: одна оценка говорит, когда появится график (со второго анализа)
  test("одна оценка — говорит, когда появится график, не «показывать нечего»", () => {
    const v = scoreHistoryView({ points: [pt(1, 60)], fullOpen: false });
    expect(v.chart).toBe(false);
    // не «1 оценка»: у карточки без оценки рядом с «Оценки нет» это читалось противоречием
    expect(v.text).toContain("одна оценка");
    expect(v.text).toContain("график появится со вторым анализом");
    expect(v.text).not.toContain("нечего");
  });

  // UX 17.10: легенда справа от графика — только нарисованные линии, без пояснений
  test("без прав на полный Score — в легенде только HealthCraft Index", () => {
    const v = scoreHistoryView({ points: [pt(1, 60), pt(2, 62), pt(3, 64)], fullOpen: false });
    expect(v.chart).toBe(true);
    expect(v.fullLine).toBe(false);
    expect(v.text).not.toContain("нечего");
  });

  test("с правами и числами Score — его пунктир в легенде; права без чисел — нет", () => {
    expect(scoreHistoryView({ points: [pt(1, 60, 55), pt(2, 62, 58), pt(3, 64, 60)], fullOpen: true }).fullLine).toBe(true);
    expect(scoreHistoryView({ points: [pt(1, 60), pt(2, 62)], fullOpen: true }).fullLine).toBe(false);
  });

  test("три состояния — три разных текста; жаргона нет", () => {
    const states = [
      scoreHistoryView({ points: [], fullOpen: false }),
      // UX 17.10: график — с трех точек
      scoreHistoryView({ points: [pt(1, 60), pt(2, 62), pt(3, 64)], fullOpen: false }),
      scoreHistoryView({ points: [pt(1, 60, 55), pt(2, 62, 58), pt(3, 64, 60)], fullOpen: true }),
    ];
    expect(new Set(states.map((s) => [s.text, s.fullLine].join("|"))).size).toBe(3);
    for (const s of states) expect(s.text).not.toMatch(/скан|tri-state|версии модели|ё/);
  });

  test("индекс не рассчитан ни в одной точке, полного нет — графика нет", () => {
    expect(scoreHistoryView({ points: [pt(1, null), pt(2, null)], fullOpen: false }).chart).toBe(false);
  });

});
