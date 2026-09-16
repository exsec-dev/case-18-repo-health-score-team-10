// acceptance-own.ts — приёмка сценария ТЗ 5 «свой репо» (В4/Б6) живьём:
// мок-сессия (строка sessions + подписанная cookie — живой клик Я ID
// остаётся приёмке HQ), PAT = SOURCECRAFT_TOKEN как юзерский (валидный
// PAT с правами на наш репо — инструкция промпта). Полный цикл по HTTP:
// PUT /api/me/pat (живая проверка GET /user) → GET /api/me/repos (живой
// /orgs/{username}/repos) → POST scan → воркер сервера исполняет own-скан
// (git + REST на PAT + AppSec официальный API) → GET own-карточка
// (6 категорий, Security с фактами, CI-раны, рекомендации).
// Проверка «PAT не утечки»: ответы всех me-эндпоинтов не содержат
// значения токена (только маска/отсутствие).
// Запуск ПОСЛЕ rescan-m2 и ПОДНЯТОГО сервера: bun scripts/acceptance-own.ts <port>
import { readFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? 8488);
const BASE = `http://127.0.0.1:${PORT}`;

const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#")) continue;
  const idx = s.indexOf("=");
  if (idx > 0) env[s.slice(0, idx).trim()] = s.slice(idx + 1).trim();
}

const SLUG = "lct-hackaton-2026/case-18-repo-health-score-team-10";

async function main() {
  // 1) мок-сессия: живой логин Я ID = живой клик (HQ); здесь строка в БД
  const { loadConfig } = await import("../src/config");
  const { openDb } = await import("../src/db");
  const { upsertUser, createSession, SESSION_COOKIE } = await import("../src/auth/session");
  const config = loadConfig();
  const db = openDb(config);
  if (!config.auth.appSecret) throw new Error("APP_SECRET не задан");
  const userId = upsertUser(db, "acceptance-mock-ya-id", "acceptance");
  const cookieValue = createSession(db, config.auth.appSecret, userId);
  db.close();
  const cookie = `${SESSION_COOKIE}=${cookieValue}`;
  console.log("мок-сессия создана (login=acceptance); живой клик Я ID — приёмка HQ");

  const j = async (path: string, init?: RequestInit): Promise<{ status: number; text: string; json: any }> => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init?.headers ?? {}), cookie } });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json };
  };

  // 2) PUT PAT: живая проверка GET /user на вставленном токене
  const pat = await j("/api/me/pat", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: env.SOURCECRAFT_TOKEN }) });
  console.log(`PUT /api/me/pat → ${pat.status}`, pat.status === 200 ? `tokenOwner=${pat.json?.tokenOwner}` : pat.text.slice(0, 200));
  if (pat.status !== 200) process.exit(1);

  // 3) мои репо (живой /user + /orgs/{username}/repos)
  const repos = await j("/api/me/repos");
  console.log(`GET /api/me/repos → ${repos.status} username=${repos.json?.username} entries=${repos.json?.entries?.length ?? "-"}`);

  // 4) запуск own-скана
  const [org, repo] = SLUG.split("/");
  const enc = `${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const scan = await j(`/api/me/repos/${enc}/scan`, { method: "POST" });
  console.log(`POST scan → ${scan.status}`, scan.json);
  if (scan.status !== 202) process.exit(1);

  // 5) опрос own-карточки (воркер сервера исполняет: клон+REST+AppSec)
  const t0 = Date.now();
  let since = 0;
  try {
    const pre = await j(`/api/me/repos/${enc}`);
    since = pre.json?.scan?.id ?? 0;
  } catch {}
  console.log(`ждём скан новее #${since}…`);
  let card: any = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await j(`/api/me/repos/${enc}`);
    const scanInfo = res.json?.scan;
    if (res.status === 200 && scanInfo && scanInfo.id > since && scanInfo.status !== "running" && scanInfo.finishedAt) {
      card = res.json;
      break;
    }
    console.log(`  … карточка: скан #${scanInfo?.id ?? "-"} ${scanInfo?.status ?? res.status}`);
    if (Date.now() - t0 > 15 * 60_000) {
      console.error("таймаут ожидания own-скана (15 мин)");
      process.exit(1);
    }
  }

  // 6) итоговая карточка: 6 категорий, Security, CI, рекомендации
  const cats = card.score.categories as Record<string, { score: number | null; no_data?: string }>;
  console.log(`\nown-карточка ${SLUG}:`);
  console.log(`  scan #${card.scan.id} ${card.scan.status} (${card.scan.trigger}), модель ${card.score.modelVersion}, режим ${card.score.mode}`);
  console.log(`  Score=${card.score.total} coverage=${card.score.coverage}`);
  for (const key of ["documentation", "cicd", "security", "activity", "issues", "code"]) {
    const c = cats[key];
    console.log(`  ${key.padEnd(13)} ${c?.score === null || c?.score === undefined ? "no-data" : String(Math.round(c.score)).padStart(3)}${c?.no_data ? `  (${c.no_data.slice(0, 60)})` : ""}`);
  }
  const appsec = (card.evidence as { key: string; status: string; value: any }[]).find((e) => e.key === "appsec.findings");
  if (appsec && appsec.status === "ok") {
    console.log(`  appsec.findings: severity=${JSON.stringify(appsec.value.severity_counts)} resolved_share=${appsec.value.resolved_share} open_groups=${appsec.value.backlog?.open_groups} engines=${JSON.stringify(appsec.value.backlog?.engines)}`);
    console.log(`  provenance: scan=${appsec.value.provenance?.scan_uuid?.slice(0, 13)}… commit=${appsec.value.provenance?.commit_hash?.slice(0, 8)} finished=${appsec.value.provenance?.time_finished}`);
  } else {
    console.log(`  appsec.findings: ${appsec?.status} ${JSON.stringify(appsec?.value)?.slice(0, 160)}`);
  }
  const runs = (card.evidence as { key: string; status: string; value: any }[]).find((e) => e.key === "cicd.runs");
  console.log(`  cicd.runs: ${runs?.status} ${JSON.stringify(runs?.value)}`);
  console.log(`  рекомендации (${card.recommendations.length}): ${card.recommendations.slice(0, 4).map((r: any) => r.ruleId).join(", ")}`);

  // 7) изоляция: публичная карточка нашего репо не вытеснена own-скором
  const pub = await j(`/api/repos/${enc}`);
  console.log(`\nизоляция: публичная карточка → ${pub.status} mode=${pub.json?.score?.mode ?? "-"} total=${pub.json?.score?.total ?? "-"}`);

  // 8) PAT не утечки: ответы me-поверхности не содержат значения токена
  const surfaces = ["/api/me", "/api/me/repos", "/api/me/settings", `/api/me/repos/${enc}`];
  let leaked = false;
  for (const s of surfaces) {
    const res = await j(s);
    if (res.text.includes(env.SOURCECRAFT_TOKEN)) {
      leaked = true;
      console.error(`УТЕЧКА: ${s} содержит PAT`);
    }
  }
  console.log(leaked ? "ПАТ УТЕК — ПРОВАЛ" : "PAT не утечки: 4 me-поверхности чисты (значение отсутствует в ответах)");
  if (leaked) process.exit(1);
  console.log("\nown-сценарий принят");
}

await main();
