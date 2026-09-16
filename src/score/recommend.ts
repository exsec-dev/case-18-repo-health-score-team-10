// recommend.ts — детерминированный движок рекомендаций (§8, ТЗ 3.3):
// правило = (условие на фактах → шаблон), каждая фраза привязана к
// fact_refs. Числовой ΔScore — ТОЛЬКО у presence-правил, считается на
// замороженном номинальном весовом векторе (без перенормировки —
// обещание не съедается перестройкой весов; показывается «по одному»,
// капы неаддитивны). Активационные — отдельная ветка без числа:
// приоритет «открывает категорию», Δ от NULL — текстом coverage X→Y.
// Порядок: числовые Δ desc → активационные по весу категории desc →
// скор-правила. LLM (В5) ничего не решает — только формулировки.
import type { Database } from "bun:sqlite";
import { AppsecFindingsValue, DocsPresenceValue, DocsReadmeValue } from "./fact-shapes";
import {
  CATEGORY_WEIGHTS,
  CategoryKey,
  CI_CONFIG_ONLY_FACTOR,
  PASS_RATE,
  README_BYTES,
  README_QUALITY_SPLIT,
  README_SPLIT,
  SUBWEIGHTS,
  anchorScore,
} from "./model";
import { compute, ScoreMode, Scores } from "./compute";

export interface Recommendation {
  ruleId: string;
  kind: "presence" | "activation" | "score";
  priority: number;
  problem: string;
  action: string;
  factRefs: string[];
  expectedImpact: string;
  deltaScore: number | null;
  opensCategory: CategoryKey | null;
}

export interface RecommendOptions {
  mode?: ScoreMode;
  now?: Date;
  /** предвычисленный Scores (hook считает compute один раз) */
  scores?: Scores;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Загрузить ok-значения фактов скана (для условий правил). */
function loadOk(db: Database, scanId: number): Map<string, unknown> {
  const rows = db.query("SELECT key, value, status FROM facts WHERE scan_id = ?").all(scanId) as {
    key: string;
    value: string;
    status: string;
  }[];
  const ok = new Map<string, unknown>();
  for (const r of rows) {
    if (r.status === "ok") ok.set(r.key, JSON.parse(r.value));
  }
  return ok;
}

export function recommend(db: Database, scanId: number, opts: RecommendOptions = {}): Recommendation[] {
  const mode = opts.mode ?? "public";
  const scores = opts.scores ?? compute(db, scanId, mode, { now: opts.now });
  const ok = loadOk(db, scanId);

  const presence: Recommendation[] = [];
  const activation: Recommendation[] = [];
  const scoreRules: Recommendation[] = [];

  // ---------- presence-правила (числовой Δ на замороженном векторе) ----------
  const Wdoc = CATEGORY_WEIGHTS.documentation / 100;
  const doc = SUBWEIGHTS.documentation;
  const presence_ = ok.get("docs.presence") as DocsPresenceValue | undefined;
  if (presence_) {
    if (presence_.license !== true) {
      const d = Wdoc * doc.license * 100;
      presence.push(mk("license-missing", "В репозитории нет файла лицензии", "Добавьте LICENSE (MIT/Apache-2.0) в корень — лицензия условие переиспользования", ["docs.presence"], d));
    }
    if (presence_.contributing !== true) {
      const d = Wdoc * doc.contributing * 100;
      presence.push(mk("contributing-missing", "Нет CONTRIBUTING — как вносить правки не описано", "Добавьте CONTRIBUTING.md с процессом контрибуции", ["docs.presence"], d));
    }
    if (presence_.codeowners !== true) {
      const d = Wdoc * doc.codeowners * 100;
      presence.push(mk("codeowners-missing", "Нет CODEOWNERS — код без ответственных", "Добавьте CODEOWNERS с владельцами каталогов", ["docs.presence"], d));
    }
    const readme = ok.get("docs.readme") as DocsReadmeValue | undefined;
    if (presence_.readme !== true) {
      // обещание: минимальный README (присутствие + bytes-скор <500Б, без секций)
      const gain = README_SPLIT.presence + README_SPLIT.quality * (README_QUALITY_SPLIT.bytes * anchorScore(README_BYTES, 0));
      const d = Wdoc * doc.readme * gain * 100;
      presence.push(mk("readme-missing", "В репозитории нет README", "Добавьте README с описанием проекта и базовыми инструкциями", ["docs.presence", "docs.readme"], d));
    } else if (readme && (readme as { present?: boolean }).present !== false) {
      const flags = readme.flags ?? {};
      const missing = ["install", "build", "test"].filter((k) => flags[k as keyof typeof flags] !== true);
      if (missing.length > 0) {
        const d = Wdoc * doc.readme * README_SPLIT.quality * README_QUALITY_SPLIT.sections * (missing.length / 3) * 100;
        const names = missing.map((k) => ({ install: "запуска/установки", build: "сборки", test: "тестов" })[k]).join("/");
        presence.push(mk("readme-sections-missing", `README без инструкции ${names}`, `Добавьте секцию ${names} в README (заголовки Install/Build/Test или Установка/Сборка/Тесты)`, ["docs.readme"], d));
      }
    }
  }
  const cicdCfg = ok.get("cicd.configs") as { has_ci_yaml?: unknown; has_steps?: unknown } | undefined;
  // CI-правила — только own-режим (В4/Б4: публичный рейтинг = 4 категории,
  // ΔScore по CI-весу в публичном total не исполняется — обещание без
  // исполнения не выдаём)
  if (mode === "own" && cicdCfg && !(cicdCfg.has_ci_yaml === true && cicdCfg.has_steps === true)) {
    const runs = ok.get("cicd.runs") as { runs_count?: unknown; success_rate?: unknown; duration_p50?: unknown } | undefined;
    let deltaCat: number;
    let impact: string;
    if (runs && (typeof runs.runs_count === "number" ? runs.runs_count : 0) > 0) {
      const p = typeof runs.success_rate === "number" ? anchorScore(PASS_RATE, runs.success_rate) : 0;
      const d = typeof runs.duration_p50 === "number" ? 1 : 0;
      deltaCat = SUBWEIGHTS.cicd.config + SUBWEIGHTS.cicd.pass_rate * p + SUBWEIGHTS.cicd.duration * d;
      impact = "прогоны уже видны — конфиг докроет категорию";
    } else {
      deltaCat = CI_CONFIG_ONLY_FACTOR; // 0 → потолок 50 (§5.1)
      impact = "конфиг со шагами = 50/100 даже без видимых прогонов";
    }
    const d = (CATEGORY_WEIGHTS.cicd / 100) * deltaCat * 100;
    presence.push(
      mk(
        cicdCfg.has_ci_yaml === true ? "ci-no-steps" : "ci-missing",
        cicdCfg.has_ci_yaml === true ? "ci.yaml есть, но без шагов — CI фактически не заявлен" : "CI не заявлен: нет .sourcecraft/ci.yaml",
        cicdCfg.has_ci_yaml === true
          ? "Добавьте в ci.yaml хотя бы один task с непустой командой (build/test)"
          : "Добавьте .sourcecraft/ci.yaml с task и командой (образец — ci.yaml этого проекта)",
        ["cicd.configs"],
        d,
        impact,
      ),
    );
  }

  // ---------- активационные (без числа; «открывает категорию») ----------
  const stats = ok.get("issues.stats") as { open?: unknown; closed?: unknown } | undefined;
  if (stats && (stats.open ?? 0) === 0 && (stats.closed ?? 0) === 0) {
    activation.push(
      act("start-tracker", "issues", "Трекер не ведётся: 0 открытых и 0 закрытых issues", "Начните вести трекер issues (баги + планы) — источник метрик поддержки", ["issues.stats"], `Issues: скор с минимума категории (${scores.categories.issues.score ?? 0}/100) до фактического по данным`),
    );
  }
  if (!ok.has("appsec.findings")) {
    // В4/Б4 (парковка В3 закрыта): вместо пустого «coverage 1.00→1.00» —
    // честный текст про режимы. Публично Security исключена (Q&A №1),
    // категория возвращается только в оценке своего репо с PAT.
    const impact =
      mode === "own"
        ? "AppSec-данные недоступны: проверьте права PAT (src.repositories.useAppSecScan) и завершённость скана — Security заработает"
        : "Security доступна в режиме своего репо: вес 20% вернётся в расчёт после входа и анализа с вашим PAT";
    activation.push(
      act("connect-appsec", "security", "Security без данных: AppSec SourceCraft не подключён (публичный режим)", "Подключите AppSec (сценарий своего репо) — SAST/SCA/secrets закроют 20% Score", ["appsec.findings"], impact),
    );
  }
  const runsFact = ok.get("cicd.runs");
  if (mode === "own" && !runsFact && cicdCfg?.has_ci_yaml === true && cicdCfg?.has_steps === true) {
    activation.push(
      act("grant-ci-runs", "cicd", "CI заявлен, но статусы прогонов недоступны (403 для чужих репо)", "Дайте доступ к прогонам CI (свой репо / права токена) — доказательства вместо потолка", ["cicd.runs", "cicd.configs"], "CI/CD: 50 → до 100 по фактическим прогонам"),
    );
  }

  // ---------- скор-правила (после появления данных; влияние текстом) ----------
  if (mode === "own" && runsFact && typeof (runsFact as { runs_count?: unknown }).runs_count === "number" && (runsFact as { runs_count?: number }).runs_count! > 0) {
    const rf = runsFact as { last_status?: unknown; success_rate?: unknown; duration_p50?: unknown };
    if (rf.last_status !== "success" || (typeof rf.success_rate === "number" && rf.success_rate < 0.9)) {
      scoreRules.push(
        mkScore("fix-red-runs", "Красные прогоны CI: свежий статус не success", "Почините пайплайн: последние прогоны падают", ["cicd.runs"], "повысит категорию CI/CD"),
      );
    }
    if (typeof rf.duration_p50 === "number" && rf.duration_p50 > 15 * 60) {
      scoreRules.push(
        mkScore("speed-up-pipeline", `Долгий пайплайн: медиана ${round1(rf.duration_p50 / 60)} мин`, "Ускорьте пайплайн (кэш, параллельные задачи, узкие шаги)", ["cicd.runs"], "повысит категорию CI/CD"),
      );
    }
  }
  const appsec = ok.get("appsec.findings") as AppsecFindingsValue | undefined;
  if (appsec) {
    const crit = (appsec.severity_counts?.critical as number | undefined) ?? 0;
    if (appsec.secrets_critical === true || crit > 0) {
      scoreRules.push(
        mkScore("appsec-critical", "Критичные находки AppSec (secrets/SAST critical)", "Закройте критичные находки: утечки секретов капят total на 49", ["appsec.findings"], "снимет кап total ≤ 49 и поднимет Security"),
      );
    }
  }
  const todo = ok.get("code.todo") as { older_180d?: unknown; count?: unknown; fixme?: unknown } | undefined;
  if (todo) {
    const total = ((todo.count ?? 0) as number) + ((todo.fixme ?? 0) as number);
    const older = (todo.older_180d ?? 0) as number;
    if (total > 0 && older / total >= 0.3) {
      scoreRules.push(
        mkScore("resolve-old-todos", `Старые TODO: ${older} из ${total} маркеров старше 180 дней`, "Разберите накопленный техдолг: закрыть или удалить устаревшие TODO/FIXME", ["code.todo"], "повысит категорию Code health"),
      );
    }
  }
  const statsFull = ok.get("issues.stats") as { open?: unknown; stale_90d?: unknown; median_close_days?: unknown } | undefined;
  const openCount = typeof statsFull?.open === "number" ? statsFull.open : 0;
  if (statsFull && openCount > 0) {
    const share = ((statsFull.stale_90d ?? 0) as number) / Math.max(1, openCount);
    if (share >= 0.5) {
      scoreRules.push(
        mkScore("reduce-stale-issues", `Зависшие issues: ${Math.round(share * 100)}% открытых без активности 90+ дней`, "Закройте или оживите зависшие issues (триаж + автозакрытие)", ["issues.stats"], "повысит категорию Issues"),
      );
    }
    if (typeof statsFull.median_close_days === "number" && statsFull.median_close_days >= 30) {
      scoreRules.push(
        mkScore("speed-up-issue-close", `Медленное закрытие issues: медиана ${statsFull.median_close_days} дн.`, "Ускорьте обработку: шаблоны, приоритеты, ответственный за триаж", ["issues.stats"], "повысит категорию Issues"),
      );
    }
  }

  // ---------- порядок (§8): числовые Δ desc → активационные по весу desc ----------
  presence.sort((a, b) => (b.deltaScore ?? 0) - (a.deltaScore ?? 0) || a.ruleId.localeCompare(b.ruleId));
  activation.sort((a, b) => CATEGORY_WEIGHTS[b.opensCategory ?? "issues"] - CATEGORY_WEIGHTS[a.opensCategory ?? "issues"] || a.ruleId.localeCompare(b.ruleId));
  const all = [...presence, ...activation, ...scoreRules];
  all.forEach((r, i) => (r.priority = i + 1));
  return all;
}

function mk(ruleId: string, problem: string, action: string, factRefs: string[], deltaScore: number, note?: string): Recommendation {
  return {
    ruleId,
    kind: "presence",
    priority: 0,
    problem,
    action,
    factRefs,
    expectedImpact: `+${round1(deltaScore)} Score (по одному)${note ? ` — ${note}` : ""}`,
    deltaScore: Math.round(deltaScore * 10000) / 10000,
    opensCategory: null,
  };
}

function act(ruleId: string, opens: CategoryKey, problem: string, action: string, factRefs: string[], impact: string): Recommendation {
  return { ruleId, kind: "activation", priority: 0, problem, action, factRefs, expectedImpact: impact, deltaScore: null, opensCategory: opens };
}

function mkScore(ruleId: string, problem: string, action: string, factRefs: string[], impact: string): Recommendation {
  return { ruleId, kind: "score", priority: 0, problem, action, factRefs, expectedImpact: impact, deltaScore: null, opensCategory: null };
}

/** Запись: PK (scan_id, model_version, rule_id) — пересчёт не дублирует. */
export function writeRecommendations(db: Database, scanId: number, modelVersion: string, recs: Recommendation[]): void {
  const stmt = db.query(
    `INSERT OR REPLACE INTO recommendations
       (scan_id, model_version, rule_id, priority, problem, action, fact_ref, expected_impact, delta_score, opens_category, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule')`,
  );
  for (const r of recs) {
    stmt.run(scanId, modelVersion, r.ruleId, r.priority, r.problem, r.action, r.factRefs.join(","), r.expectedImpact, r.deltaScore, r.opensCategory);
  }
}
