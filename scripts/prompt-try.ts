// Прогон одной роли AI-обзора вне сервера: bun scripts/prompt-try.ts <org/repo> <роль> [флаги]
//
// Берет факты последнего завершенного скана репозитория из БД, собирает вход
// ровно так же, как конвейер (scopedFacts, рамки README, сегменты специалистов,
// точки истории, признаки ритма), печатает системный промпт и вход, зовет модель
// с инструментами и показывает сырой ответ, вердикт валидатора и чистый текст.
// В БД ничего не пишет. Хартии читаются с диска при каждом запуске.
//
// Роли: documentation code activity issues cicd security trajectory overview flagger
// Флаги:
//   --clone <path>   локальная копия репозитория: README и инструменты (grep, git_log)
//                    для специалистов; без нее специалисты идут без инструментов
//   --dry            только собрать и напечатать промпт, модель не звать
//   --public         публичная аудитория (4 категории, без почты в ленте)
//   --scan <id>      конкретный скан вместо последнего завершенного
//   --quiet          не печатать системный промпт и вход (только ответ и вердикт)
//   --model <name>   переопределить модель (и main, и side)
//   --temp <n>       одна температура для всех ролей на этот прогон (эксперименты)
// overview без флага --all берет тексты специалистов из ai_notes этого скана;
//   --all            сначала прогнать специалистов и динамику, потом overview на их ответах
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import type { AiAudience } from "../src/db";
import { makeLlm, type ChatMessage } from "../src/llm";
import { parseFactValue } from "../src/collectors/facts";
import { loadCharter } from "../src/summary/charters";
import { generateWithTools } from "../src/summary/agent";
import { frameUntrusted, makeNonce } from "../src/summary/input";
import { historyPoints, namedTrajectoryPoints, normalizeTypography, overviewScoreSummary, readGitLog, readReadme, scopedFacts, segmentsOf } from "../src/summary/pipeline";
import { rhythmSignals, RHYTHM_KEY } from "../src/summary/rhythm";
import { SUMMARY_ROLES, toolsAllowed, type SummaryRole } from "../src/summary/roles";
import { makeCalculatorExecutor, makeToolExecutor } from "../src/summary/tools";
import { validateFlagOutput, validateOutput, type FactInput } from "../src/summary/validator";

// --- аргументы ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && ["--clone", "--scan", "--model", "--temp"].includes(argv[i - 1]!)));
const slug = positional[0];
const roleArg = positional[1];
const usage = `usage: bun scripts/prompt-try.ts <org/repo> <${SUMMARY_ROLES.join("|")}> [--clone <path>] [--dry] [--public] [--scan <id>] [--quiet] [--model <name>] [--temp <n>] [--all]`;
if (!slug || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(slug) || !roleArg || !(SUMMARY_ROLES as readonly string[]).includes(roleArg)) {
  console.error(usage);
  process.exit(2);
}
const role = roleArg as SummaryRole;
const [org, repo] = slug.split("/") as [string, string];
const audience: AiAudience = flag("--public") ? "public" : "full";
const dry = flag("--dry");
const quiet = flag("--quiet");
const runAll = flag("--all");

const cloneArg = opt("--clone");
let clone: { root: string; gitDir: string | null } | null = null;
if (cloneArg !== null) {
  const root = resolve(cloneArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`--clone: каталог не найден: ${root}`);
    process.exit(2);
  }
  const gitDir = existsSync(join(root, ".git")) ? join(root, ".git") : null;
  clone = { root, gitDir };
}

// --- БД и скан ---------------------------------------------------------------
const config = loadConfig();
const modelOverride = opt("--model");
if (modelOverride !== null) {
  config.llm.mainModel = modelOverride;
  config.llm.sideModel = modelOverride;
}
const db = openDb(config);
const repoRow = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number } | null;
if (!repoRow) {
  console.error(`репозиторий ${slug} не найден в БД – сначала bun scripts/scan.ts ${slug}`);
  process.exit(1);
}
const scanOpt = opt("--scan");
const scanRow = (
  scanOpt !== null
    ? db.query("SELECT id, finished_at, started_at FROM scans WHERE id = ? AND repo_id = ?").get(Number(scanOpt), repoRow.id)
    : db.query("SELECT id, finished_at, started_at FROM scans WHERE repo_id = ? AND status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1").get(repoRow.id)
) as { id: number; finished_at: string | null; started_at: string } | null;
if (!scanRow) {
  console.error(`у ${slug} нет завершенного скана`);
  process.exit(1);
}
const scanId = scanRow.id;

// --- печать ------------------------------------------------------------------
const hr = (title: string) => console.log(`\n${"=".repeat(12)} ${title} ${"=".repeat(Math.max(0, 60 - title.length))}`);
const show = (title: string, body: string) => {
  if (quiet) return;
  hr(title);
  console.log(body);
};

// --temp <n>: одна температура для всех ролей на этот прогон (сравнение 0.2 и 0.4)
const tempArg = opt("--temp");
const tempOverride = tempArg === null ? null : Number(tempArg);
if (tempOverride !== null && !(tempOverride >= 0 && tempOverride <= 1)) {
  console.error("--temp: число от 0 до 1");
  process.exit(2);
}
const baseLlm = dry ? null : makeLlm(config, undefined, { priority: "interactive" });
const callLlm: typeof baseLlm = baseLlm === null ? null : tempOverride === null ? baseLlm : (o) => baseLlm({ ...o, temperature: tempOverride });
const log = (m: string) => console.log(`  · ${m}`);

interface RoleRun {
  ok: boolean;
  text: string;
  clean: string;
  reasons: string[];
}

function factsDigest(facts: FactInput[]): string {
  return facts.map((f) => `- ${f.key}: ${JSON.stringify(f.value)}`).join("\n");
}

/** Одна проза-роль: тот же вход и тот же цикл, что в pipeline.runRole, без ретраев и записи в БД. */
async function runProseRole(r: SummaryRole, facts: FactInput[], contentBlocks: string[], segments: ReturnType<typeof segmentsOf> | null): Promise<RoleRun> {
  const charter = loadCharter(r);
  const nonce = makeNonce();
  const blocks = [...contentBlocks];
  if (segments !== null) {
    blocks.push(
      [
        `=== НАЧАЛО ОТВЕТОВ СПЕЦИАЛИСТОВ (nonce ${nonce}) ===`,
        ...Object.entries(segments.numbered).map(([id, t]) => `{${id}} ${t}`),
        `=== КОНЕЦ ОТВЕТОВ СПЕЦИАЛИСТОВ (nonce ${nonce}) ===`,
      ].join("\n"),
    );
  }
  const userText = ["ФАКТЫ СКАНА (числа – отсюда и из выдачи инструментов, других источников нет):", factsDigest(facts), ...(blocks.length > 0 ? ["", ...blocks] : [])].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: charter.text },
    { role: "user", content: userText },
  ];
  show(`СИСТЕМНЫЙ ПРОМПТ ${r} (charter-version ${charter.version}, ${charter.text.length} зн.)`, charter.text);
  show(`ВХОД ${r} (${userText.length} зн.)`, userText);
  if (facts.length === 0) console.log(`\n! у роли ${r} нет фактов категории – конвейер ее не вызвал бы`);
  if (callLlm === null) return { ok: false, text: "", clean: "", reasons: ["--dry: модель не вызывалась"] };

  const executor = clone && toolsAllowed(r) ? makeToolExecutor({ root: clone.root, gitDir: clone.gitDir }, 12) : r === "security" ? makeCalculatorExecutor() : null;
  if (toolsAllowed(r) && clone === null) console.log(`\n! роль ${r} умеет инструменты, но --clone не задан: идет без них`);
  hr(`ГЕНЕРАЦИЯ ${r}`);
  const startedAt = Date.now();
  const res = await generateWithTools({ callLlm, role: r, executor: executor === null ? null : { specs: executor.specs, execute: executor.execute, budgetLeft: executor.budgetLeft }, log }, messages);
  const text = normalizeTypography(res.text);
  console.log(`  ${Date.now() - startedAt} мс, вызовов модели ${res.modelCalls}, инструментов ${res.toolCalls}${executor ? ` (осталось ${executor.budgetLeft()})` : ""}`);
  hr(`СЫРОЙ ОТВЕТ ${r} (${text.length} зн.)`);
  console.log(text);
  const verdict = validateOutput({ role: r, text, facts, segments: segments?.segments ?? [] });
  hr(`ВАЛИДАТОР ${r}: ${verdict.ok ? "OK" : "ОТКЛОНЕНО"}`);
  if (!verdict.ok) for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  if (verdict.refs.length) console.log(`  ссылки на факты: ${verdict.refs.join(", ")}`);
  if (verdict.segmentsUsed.length) console.log(`  ссылки на сегменты: ${verdict.segmentsUsed.join(", ")}`);
  if (verdict.ok) {
    hr(`ЧИСТЫЙ ТЕКСТ ${r} (то, что увидит читатель)`);
    console.log(verdict.clean);
  }
  return { ok: verdict.ok, text, clean: verdict.clean, reasons: verdict.reasons };
}

async function readmeBlocks(): Promise<string[]> {
  const readme = await readReadme({ clone });
  if (readme === null) return [];
  const framed = frameUntrusted("README.md", readme, makeNonce());
  return framed === null ? [] : [framed];
}

async function runSpecialist(r: SummaryRole): Promise<RoleRun> {
  const facts = scopedFacts(db, scanId, r, audience);
  // как в конвейере: README – только документации, git log – только активности
  const content = r === "documentation" ? await readmeBlocks() : [];
  if (r === "activity") {
    const gitLog = await readGitLog({ clone });
    if (gitLog !== null) content.push(gitLog);
    else console.log("\n! git log недоступен (нет --clone или .git) – activity идет без тем коммитов");
  }
  return runProseRole(r, facts, content, null);
}

async function runTrajectory(): Promise<RoleRun | null> {
  const points = historyPoints(db, scanId, audience);
  if (points.length === 0) {
    console.log("\n! точек истории нет – конвейер роль динамики не вызывает");
    return null;
  }
  return runProseRole("trajectory", [{ key: "scores.points", value: namedTrajectoryPoints(points) }], [], null);
}

async function runOverview(): Promise<RoleRun> {
  const texts: Record<string, string> = {};
  if (runAll) {
    const specialists = audience === "public" ? ["documentation", "code", "activity", "issues"] : ["documentation", "code", "activity", "issues", "cicd", "security"];
    for (const r of specialists as SummaryRole[]) {
      if (scopedFacts(db, scanId, r, audience).length === 0) continue;
      const run = await runSpecialist(r);
      if (run.ok) texts[r] = run.clean;
    }
    const traj = await runTrajectory();
    if (traj?.ok) texts.trajectory = traj.clean;
  } else {
    const rows = db
      .query("SELECT role, text FROM ai_notes WHERE scan_id = ? AND role NOT IN ('overview', 'flagger') AND audience = ? ORDER BY id")
      .all(scanId, audience) as { role: string; text: string }[];
    for (const row of rows) texts[row.role] = row.text;
    if (rows.length === 0) console.log("\n! в ai_notes нет ответов специалистов для этого скана – запустите с --all");
  }
  if (Object.keys(texts).length === 0) return { ok: false, text: "", clean: "", reasons: ["нет ни одного ответа специалистов"] };
  console.log(`\n  специалисты во входе overview: ${Object.keys(texts).join(", ")}`);
  return runProseRole("overview", overviewScoreSummary(db, scanId, org, repo, audience), [], segmentsOf(texts));
}

async function runFlaggerRole(): Promise<void> {
  const rows = db.query("SELECT key, value FROM facts WHERE scan_id = ? AND status = 'ok' AND key IN ('activity.git.timeline', 'activity.rest')").all(scanId) as { key: string; value: string }[];
  const timeline = rows.find((r) => r.key === "activity.git.timeline");
  const rest = rows.find((r) => r.key === "activity.rest");
  const events = (timeline ? (parseFactValue(timeline.value) as { events?: unknown } | null)?.events : null) ?? null;
  const asOf = new Date(scanRow!.finished_at ?? scanRow!.started_at);
  const signals = Array.isArray(events) ? rhythmSignals(events as Parameters<typeof rhythmSignals>[0], asOf) : null;
  if (signals === null) {
    console.log("\n! ленты коммитов нет – конвейер проверку не проводит");
    return;
  }
  const facts: FactInput[] = [{ key: RHYTHM_KEY, value: signals }];
  if (rest) facts.push({ key: "activity.rest", value: parseFactValue(rest.value) });
  const charter = loadCharter("flagger");
  const userText = `ФАКТЫ АКТИВНОСТИ (числа только из этого списка):\n${factsDigest(facts)}`;
  show(`СИСТЕМНЫЙ ПРОМПТ flagger (charter-version ${charter.version}, ${charter.text.length} зн.)`, charter.text);
  show(`ВХОД flagger (${userText.length} зн.)`, userText);
  if (callLlm === null) return;
  hr("ГЕНЕРАЦИЯ flagger");
  const startedAt = Date.now();
  const res = await generateWithTools({ callLlm, role: "flagger", executor: null, log }, [
    { role: "system", content: charter.text },
    { role: "user", content: userText },
  ]);
  console.log(`  ${Date.now() - startedAt} мс, вызовов модели ${res.modelCalls}`);
  hr("СЫРОЙ ОТВЕТ flagger");
  console.log(res.text);
  const verdict = validateFlagOutput(res.text, new Set(facts.map((f) => f.key)));
  hr(`ВАЛИДАТОР flagger: ${verdict.ok ? "OK" : "ОТКЛОНЕНО"}`);
  if (!verdict.ok) console.log(`  - ${verdict.reason}`);
  else console.log(JSON.stringify(verdict.flag, null, 2));
}

// --- запуск ------------------------------------------------------------------
console.log(`${slug}: скан ${scanId}, аудитория ${audience}, провайдер ${config.llm.provider}, модели main=${config.llm.mainModel} side=${config.llm.sideModel}${clone ? `, клон ${clone.root}` : ", без клона"}${dry ? ", --dry" : ""}${tempOverride === null ? "" : `, температура ${tempOverride}`}`);
if (role === "flagger") await runFlaggerRole();
else if (role === "overview") await runOverview();
else if (role === "trajectory") await runTrajectory();
else await runSpecialist(role);
