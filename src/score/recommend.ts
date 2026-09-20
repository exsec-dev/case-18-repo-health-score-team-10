// recommend.ts — детерминированный движок рекомендаций (§8, ТЗ 3.3):
// правило = (условие на фактах → шаблон), каждая фраза привязана к
// fact_refs. Числовой ΔScore — ТОЛЬКО у presence-правил. В4.1-fix (К-Ф1.2):
// реальный прирост итога — разность computeFromFacts на подменённых фактах
// и на фактах скана, с фактической перенормировкой и капом 49 (решение
// Екатерины 17.09 «Прирост в рекомендациях — реальная цифра»); прежний
// номинальный вектор 100 отменён. Активационные — отдельная ветка без числа:
// приоритет «открывает категорию», Δ от NULL — текстом coverage X→Y.
// Порядок: числовые Δ desc → активационные по весу категории desc →
// скор-правила. LLM (В5) ничего не решает — только формулировки.
// В4.1 (К1): одна выдача на скан; правило несёт channel (cicd | appsec |
// null = публичное) — карточка отфильтровывает правила закрытых зрителю
// каналов. Δ правил с channel относится к Repo Health Score, остальных —
// к HealthCraft Index (В4.3).
// В4.1-fix круг 2: движок — чистая recommendFromFacts(ok, ctx) с инъекцией
// оценщика Δ; карточка собирает канальные правила на ПОКАЗАННЫХ фактах
// (CI/Security из своих сканов) своим оценщиком; порядок — одна функция
// orderRecommendations для движка и для объединённой выдачи карточки.
import type { Database } from "bun:sqlite";
import { AppsecFindingsValue, DocsPresenceValue, DocsReadmeValue } from "./fact-shapes";
import { SCORE_WEIGHTS, CategoryKey, SECRETS_CRITICAL_TOTAL_CAP } from "./model";
import { compute, computeFromFacts, effectiveFacts, Scores } from "./compute";

/** Канал правила: данные, видимые только зрителю с доступом (К2). */
export type RecommendationChannel = "cicd" | "appsec";

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
  /** null = публичное правило (видно всем) */
  channel: RecommendationChannel | null;
}

export interface RecommendOptions {
  now?: Date;
  /** предвычисленный Scores (hook считает compute один раз) */
  scores?: Scores;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
export const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/** Реальный прирост итога правила при подмене фактов (К-Ф1.2); reason — причина Δ = 0. */
export type DeltaEvaluator = (
  channel: RecommendationChannel | null,
  patch: (facts: Map<string, unknown>) => void,
) => { delta: number; reason: string | null };

export interface RecommendFactsContext {
  delta: DeltaEvaluator;
  /** скор категории Issues — текст start-tracker */
  issuesScore: number | null;
  /** "channel" — только правила каналов CI/Security (карточка, круг 2) */
  only?: "all" | "channel";
}

/** Порядок score-правил движка (§8) — общий для движка и объединённой выдачи карточки. */
export const SCORE_RULE_ORDER = ["fix-red-runs", "speed-up-pipeline", "appsec-critical", "resolve-old-todos", "reduce-stale-issues", "speed-up-issue-close"];

interface Orderable {
  ruleId: string;
  kind: string;
  deltaScore: number | null;
  opensCategory: string | null;
  priority: number;
}

/**
 * Порядок выдачи (§8, К-Ф1.2; круг 2 LOW-3). Вход — одна или несколько
 * выдач, каждая уже в порядке движка (карточка: сохранённые правила P и
 * канальные правила на показанных фактах). presence с числовым Δ — по Δ
 * убыв., затем rule_id; presence со скрытым Δ (null) — после них по rule_id
 * (позиция не раскрывает величину); активационные — по весу категории убыв.,
 * rule_id; score-правила — слиянием выдач по порядку движка
 * (SCORE_RULE_ORDER; правило вне списка сохраняет место в своей выдаче).
 * Номера 1..N.
 */
export function orderRecommendations<T extends Orderable>(...lists: T[][]): T[] {
  const all = lists.flat();
  const presence = all.filter((r) => r.kind === "presence");
  const activation = all.filter((r) => r.kind === "activation");
  presence.sort((a, b) => {
    if (a.deltaScore === null || b.deltaScore === null) {
      if (a.deltaScore !== b.deltaScore) return a.deltaScore === null ? 1 : -1;
      return a.ruleId.localeCompare(b.ruleId);
    }
    return b.deltaScore - a.deltaScore || a.ruleId.localeCompare(b.ruleId);
  });
  activation.sort(
    (a, b) =>
      SCORE_WEIGHTS[(b.opensCategory ?? "issues") as CategoryKey] - SCORE_WEIGHTS[(a.opensCategory ?? "issues") as CategoryKey] ||
      a.ruleId.localeCompare(b.ruleId),
  );
  let scoreRules: T[] = [];
  for (const list of lists) {
    const next = list.filter((r) => r.kind === "score");
    const merged: T[] = [];
    let i = 0;
    let j = 0;
    while (i < scoreRules.length || j < next.length) {
      if (j >= next.length) merged.push(scoreRules[i++]!);
      else if (i >= scoreRules.length) merged.push(next[j++]!);
      else {
        const ra = SCORE_RULE_ORDER.indexOf(scoreRules[i]!.ruleId);
        const rb = SCORE_RULE_ORDER.indexOf(next[j]!.ruleId);
        if (ra !== -1 && rb !== -1 && rb < ra) merged.push(next[j++]!);
        else merged.push(scoreRules[i++]!);
      }
    }
    scoreRules = merged;
  }
  const out = [...presence, ...activation, ...scoreRules];
  out.forEach((r, i) => (r.priority = i + 1));
  return out;
}

export function recommend(db: Database, scanId: number, opts: RecommendOptions = {}): Recommendation[] {
  const scores = opts.scores ?? compute(db, scanId, { now: opts.now });
  // те же факты, из которых посчитан Score (включая замещение историей):
  // рекомендация не противоречит числу на карточке
  const eff = effectiveFacts(db, scanId, scores.repoId);
  const ok = eff.ok;

  // ---------- presence-правила (реальный Δ итога, К-Ф1.2) ----------
  // Δ = итог на подменённых фактах − итог на фактах скана: правила без
  // канала — к Score в рейтинге (4 категории, фактическая перенормировка),
  // канальные — к полному Score (кап 49 учитывается). Один вызов
  // computeFromFacts на правило; подмены — таблица плана К-Ф1.2.
  const now = opts.now ?? new Date(scores.computedAt);
  const input = { scanId, repoId: scores.repoId, stale: eff.stale, staleCats: eff.staleCats };
  const base = computeFromFacts(ok, input, now);
  const secretsCritical = (ok.get("appsec.findings") as { secrets_critical?: unknown } | undefined)?.secrets_critical === true;
  const realDelta = (channel: RecommendationChannel | null, patch: (facts: Map<string, unknown>) => void): { delta: number; reason: string | null } => {
    const facts = new Map(ok);
    patch(facts);
    const after = computeFromFacts(facts, input, now);
    const pick = (s: Scores) => (channel === null ? s.healthcraftIndex : s.repoHealthScore);
    if (base.codeEmpty) return { delta: 0, reason: "в репозитории нет кода" };
    const b = pick(base);
    const a = pick(after);
    if (b === null || a === null) return { delta: 0, reason: "итог появится при большем покрытии" };
    const delta = round4(a - b);
    if (delta === 0 && channel !== null && secretsCritical && b >= SECRETS_CRITICAL_TOTAL_CAP) return { delta: 0, reason: "упирается в кап 49" };
    return { delta, reason: null };
  };
  return recommendFromFacts(ok, { delta: realDelta, issuesScore: scores.categories.issues.score });
}

/** Чистый движок правил на эффективных фактах (без БД). */
export function recommendFromFacts(ok: Map<string, unknown>, ctx: RecommendFactsContext): Recommendation[] {
  const pub = ctx.only !== "channel";
  const realDelta = ctx.delta;
  const presence: Recommendation[] = [];
  const activation: Recommendation[] = [];
  const scoreRules: Recommendation[] = [];
  const presenceRule = (
    ruleId: string,
    problem: string,
    action: string,
    factRefs: string[],
    patch: (facts: Map<string, unknown>) => void,
    channel: RecommendationChannel | null = null,
  ) => presence.push(mk(ruleId, problem, action, factRefs, realDelta(channel, patch), channel));
  const withPresence = (field: keyof DocsPresenceValue) => (facts: Map<string, unknown>) => {
    facts.set("docs.presence", { ...(facts.get("docs.presence") as DocsPresenceValue), [field]: true });
  };

  const presence_ = ok.get("docs.presence") as DocsPresenceValue | undefined;
  if (pub && presence_) {
    if (presence_.license !== true) {
      presenceRule("license-missing", "В репозитории нет файла лицензии", "Добавьте LICENSE (MIT/Apache-2.0) в корень – лицензия условие переиспользования", ["docs.presence"], withPresence("license"));
    }
    if (presence_.contributing !== true) {
      presenceRule("contributing-missing", "Нет CONTRIBUTING – как вносить правки не описано", "Добавьте CONTRIBUTING.md с процессом контрибуции", ["docs.presence"], withPresence("contributing"));
    }
    if (presence_.codeowners !== true) {
      presenceRule("codeowners-missing", "Нет CODEOWNERS – код без ответственных", "Добавьте CODEOWNERS с владельцами каталогов", ["docs.presence"], withPresence("codeowners"));
    }
    const readme = ok.get("docs.readme") as DocsReadmeValue | undefined;
    if (presence_.readme !== true) {
      // обещание: README появился (подмена К-Ф1.2 — присутствие без объёма и секций)
      presenceRule("readme-missing", "В репозитории нет README", "Добавьте README с описанием проекта и базовыми инструкциями", ["docs.presence", "docs.readme"], (facts) => {
        withPresence("readme")(facts);
        facts.set("docs.readme", { present: true, bytes: 0, flags: {} });
      });
    } else if (readme && (readme as { present?: boolean }).present !== false) {
      const flags = readme.flags ?? {};
      const missing = ["install", "build", "test"].filter((k) => flags[k as keyof typeof flags] !== true);
      if (missing.length > 0) {
        const names = missing.map((k) => ({ install: "запуска/установки", build: "сборки", test: "тестов" })[k]).join("/");
        presenceRule("readme-sections-missing", `README без инструкции ${names}`, `Добавьте секцию ${names} в README (заголовки Install/Build/Test или Установка/Сборка/Тесты)`, ["docs.readme"], (facts) => {
          const current = facts.get("docs.readme") as { flags?: Record<string, unknown> };
          facts.set("docs.readme", { ...current, flags: { ...(current.flags ?? {}), ...Object.fromEntries(missing.map((k) => [k, true])) } });
        });
      }
    }
  }
  const cicdCfg = ok.get("cicd.configs") as { has_ci_yaml?: unknown; has_steps?: unknown } | undefined;
  // CI-правила — канал cicd: Δ по CI-весу исполняется только в полном
  // Score, поэтому правило видит лишь зритель с доступом к CI (К2)
  if (cicdCfg && !(cicdCfg.has_ci_yaml === true && cicdCfg.has_steps === true)) {
    const hasYaml = cicdCfg.has_ci_yaml === true;
    presenceRule(
      hasYaml ? "ci-no-steps" : "ci-missing",
      hasYaml ? "ci.yaml есть, но без шагов – CI фактически не заявлен" : "CI не заявлен: нет .sourcecraft/ci.yaml",
      hasYaml
        ? "Добавьте в ci.yaml хотя бы один task с непустой командой (build/test)"
        : "Добавьте .sourcecraft/ci.yaml с task и командой (образец – ci.yaml этого проекта)",
      ["cicd.configs"],
      (facts) => {
        facts.set("cicd.configs", hasYaml ? { ...(facts.get("cicd.configs") as object), has_steps: true } : { has_ci_yaml: true, has_steps: true });
      },
      "cicd",
    );
  }

  // ---------- активационные (без числа; «открывает категорию») ----------
  const stats = ok.get("issues.stats") as { open?: unknown; closed?: unknown } | undefined;
  if (pub && stats && (stats.open ?? 0) === 0 && (stats.closed ?? 0) === 0) {
    activation.push(
      act("start-tracker", "issues", "Трекер не ведется: 0 открытых и 0 закрытых issues", "Начните вести трекер issues (баги + планы) – источник метрик поддержки", ["issues.stats"], `Issues: скор с минимума категории (${ctx.issuesScore ?? 0}/100) до фактического по данным`),
    );
  }
  if (!ok.has("appsec.findings")) {
    // нейтральный текст (К1): рекомендация видна только зрителю с доступом
    // к Security, а данных AppSec у скана нет — ни подключения, ни скана
    activation.push(
      act(
        "connect-appsec",
        "security",
        "Security без данных: результатов AppSec SourceCraft по репозиторию нет",
        "Подключите AppSec к репозиторию и дождитесь завершенного скана – SAST/SCA/secrets закроют 20% Repo Health Score",
        ["appsec.findings"],
        "AppSec-данные недоступны: проверьте право PAT src.repositories.useAppSecScan и завершенность скана – Security заработает в Repo Health Score",
        "appsec",
      ),
    );
  }
  const runsFact = ok.get("cicd.runs");
  if (!runsFact && cicdCfg?.has_ci_yaml === true && cicdCfg?.has_steps === true) {
    activation.push(
      act("grant-ci-runs", "cicd", "CI заявлен, но статусы прогонов недоступны (403 для чужих репо)", "Дайте доступ к прогонам CI (свой репо / права токена) – доказательства вместо потолка", ["cicd.runs", "cicd.configs"], "CI/CD: 50 → до 100 по фактическим прогонам", "cicd"),
    );
  }

  // ---------- скор-правила (после появления данных; влияние текстом) ----------
  if (runsFact && typeof (runsFact as { runs_count?: unknown }).runs_count === "number" && (runsFact as { runs_count?: number }).runs_count! > 0) {
    const rf = runsFact as { last_status?: unknown; success_rate?: unknown; duration_p50?: unknown };
    if (rf.last_status !== "success" || (typeof rf.success_rate === "number" && rf.success_rate < 0.9)) {
      scoreRules.push(
        mkScore("fix-red-runs", "Красные прогоны CI: свежий статус не success", "Почините пайплайн: последние прогоны падают", ["cicd.runs"], "повысит категорию CI/CD", "cicd"),
      );
    }
    if (typeof rf.duration_p50 === "number" && rf.duration_p50 > 15 * 60) {
      scoreRules.push(
        mkScore("speed-up-pipeline", `Долгий пайплайн: медиана ${round1(rf.duration_p50 / 60)} мин`, "Ускорьте пайплайн (кэш, параллельные задачи, узкие шаги)", ["cicd.runs"], "повысит категорию CI/CD", "cicd"),
      );
    }
  }
  const appsec = ok.get("appsec.findings") as AppsecFindingsValue | undefined;
  if (appsec) {
    const crit = (appsec.severity_counts?.critical as number | undefined) ?? 0;
    if (appsec.secrets_critical === true || crit > 0) {
      scoreRules.push(
        mkScore("appsec-critical", "Критичные находки AppSec (secrets/SAST critical)", "Закройте критичные находки: утечки секретов капят Repo Health Score на 49", ["appsec.findings"], "снимет кап Repo Health Score ≤ 49 и поднимет Security", "appsec"),
      );
    }
  }
  const todo = ok.get("code.todo") as { older_180d?: unknown; count?: unknown; fixme?: unknown } | undefined;
  if (pub && todo) {
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
  if (pub && statsFull && openCount > 0) {
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

  // ---------- порядок (§8): реальный Δ desc (затем rule_id) → активационные по весу desc → score ----------
  return orderRecommendations([...presence, ...activation, ...scoreRules]);
}

function mk(
  ruleId: string,
  problem: string,
  action: string,
  factRefs: string[],
  real: { delta: number; reason: string | null },
  channel: RecommendationChannel | null = null,
): Recommendation {
  // Δ канального правила — к Repo Health Score, публичного — к HealthCraft
  // Index (К-Ф1.2, В4.3). Дельта ЗНАКОВАЯ: инверсия законна (плохие
  // CI/Security опускают полный Score ниже индекса) — «+» безусловно
  // рисовало «+-2.5»; знак берётся из фактического прироста.
  // В4.6 круг 2 (Р18): разделитель в тексте эффекта — среднее тире (правило
  // языка UI): строка едет на карточку и в MD-отчёт как есть.
  const scope = channel === null ? "к HealthCraft Index" : "к Repo Health Score";
  const sign = real.delta < 0 ? "-" : "+";
  return {
    ruleId,
    kind: "presence",
    priority: 0,
    problem,
    action,
    factRefs,
    expectedImpact: `${sign}${Math.abs(real.delta).toFixed(1)} ${scope}${real.reason ? ` – ${real.reason}` : ""}`,
    deltaScore: real.delta,
    opensCategory: null,
    channel,
  };
}

function act(
  ruleId: string,
  opens: CategoryKey,
  problem: string,
  action: string,
  factRefs: string[],
  impact: string,
  channel: RecommendationChannel | null = null,
): Recommendation {
  return { ruleId, kind: "activation", priority: 0, problem, action, factRefs, expectedImpact: impact, deltaScore: null, opensCategory: opens, channel };
}

function mkScore(
  ruleId: string,
  problem: string,
  action: string,
  factRefs: string[],
  impact: string,
  channel: RecommendationChannel | null = null,
): Recommendation {
  return { ruleId, kind: "score", priority: 0, problem, action, factRefs, expectedImpact: impact, deltaScore: null, opensCategory: null, channel };
}

/** Запись: PK (scan_id, model_version, rule_id) — пересчёт не дублирует. */
export function writeRecommendations(db: Database, scanId: number, modelVersion: string, recs: Recommendation[]): void {
  const stmt = db.query(
    `INSERT OR REPLACE INTO recommendations
       (scan_id, model_version, rule_id, priority, problem, action, fact_ref, expected_impact, delta_score, opens_category, source, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?)`,
  );
  // одна выдача на скан: пересчёт заменяет набор целиком (исчезнувшее
  // правило не остаётся висеть от прошлого прогона)
  db.query("DELETE FROM recommendations WHERE scan_id = ? AND model_version = ?").run(scanId, modelVersion);
  for (const r of recs) {
    stmt.run(scanId, modelVersion, r.ruleId, r.priority, r.problem, r.action, r.factRefs.join(","), r.expectedImpact, r.deltaScore, r.opensCategory, r.channel);
  }
}
