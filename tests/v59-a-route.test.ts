// v59-a-route.test.ts — В5.9 (воркер А): маршрут скачивания файла-заготовки
// `GET /api/repos/:org/:repo/fix/:ruleId[?license=]` на настоящем сервере
// (временный каталог, мок внешних API, сети нет). Видимость — как у карточки;
// признак `fixTemplate` карточки ⇔ маршрут отдает 200 (тест «равно источнику»);
// лестница в карточке есть, в /api/v1 — нет.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import type { RepoCard } from "../src/api/repos";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { FIX_RULE_IDS, LICENSE_IDS } from "../src/fix/templates";
import { healthyFacts } from "./score-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";
import { seedScored, unreachedFacts } from "./v59-a-fixtures";

const dir = mkdtempSync(join(tmpdir(), "rh-v59a-route-"));
const mock = startMockApi();
let base = "";
let server: SpawnedServer | null = null;

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t = { db, close: () => db.close() };
  seedScored(t, "acme", "weak", unreachedFacts());
  seedScored(t, "acme", "healthy", healthyFacts());
  seedScored(t, "acme", "secret", unreachedFacts(), "private");
  db.close();
  server = await spawnServer({ dataDir: dir, mock });
  base = server.base;
}, 30_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* EBUSY на Windows — уборка tmp */
  }
});

const card = async (slug: string): Promise<RepoCard> => (await (await fetch(`${base}/api/repos/acme/${slug}`)).json()) as RepoCard;
const fix = (slug: string, ruleId: string, license?: string) => fetch(`${base}/api/repos/acme/${slug}/fix/${ruleId}${license ? `?license=${license}` : ""}`);

describe("В5.9: маршрут файла-заготовки", () => {
  test("200: text/plain, attachment с именем файла, содержимое — заготовка", async () => {
    const res = await fix("weak", "contributing-missing");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="CONTRIBUTING.md"');
    const body = await res.text();
    expect(body).toContain("## Как сообщить об ошибке");
    const lic = await fix("weak", "license-missing", "apache-2.0");
    expect(lic.status).toBe(200);
    expect(lic.headers.get("content-disposition")).toBe('attachment; filename="LICENSE"');
    expect(await lic.text()).toContain("Apache License");
  });

  test("признак fixTemplate карточки ⇔ маршрут отдает 200 (по всем правилам и лицензиям)", async () => {
    for (const slug of ["weak", "healthy"]) {
      const c = await card(slug);
      for (const ruleId of FIX_RULE_IDS) {
        const rec = c.recommendations.find((r) => r.ruleId === ruleId);
        const has = rec !== undefined && rec.fixTemplate != null;
        const licenses = ruleId === "license-missing" ? [...LICENSE_IDS] : [undefined];
        for (const license of licenses) {
          const res = await fix(slug, ruleId, license);
          await res.text();
          expect(`${slug} ${ruleId} ${res.status}`).toBe(`${slug} ${ruleId} ${has ? 200 : 404}`);
          if (has) expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${rec!.fixTemplate!.filename}"`);
        }
        if (has && ruleId === "license-missing") expect(rec!.fixTemplate!.licenses).toEqual([...LICENSE_IDS]);
      }
    }
  });

  test("404: правило у репо сейчас не срабатывает — шаблон «на всякий случай» не отдается", async () => {
    const c = await card("healthy");
    expect(c.recommendations.some((r) => r.ruleId === "license-missing")).toBe(false);
    const res = await fix("healthy", "license-missing", "mit");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("404: приватный без прав — тот же ответ, что у карточки (ничего не раскрывается)", async () => {
    const cardRes = await fetch(`${base}/api/repos/acme/secret`);
    const cardBody = await cardRes.text();
    for (const ruleId of ["contributing-missing", "codeowners-missing"]) {
      const res = await fix("secret", ruleId);
      expect(res.status).toBe(cardRes.status);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(cardBody);
    }
    const lic = await fix("secret", "license-missing", "mit");
    expect(lic.status).toBe(404);
    // несуществующий репо — тот же 404
    expect((await fix("nope", "contributing-missing")).status).toBe(404);
  });

  test("400: неизвестное правило, неизвестная лицензия, лицензия не выбрана", async () => {
    for (const [ruleId, license] of [
      ["no-such-rule", undefined],
      ["add-tests", undefined],
      ["fix-red-runs", undefined],
      ["license-missing", "gpl-3.0"],
      ["contributing-missing", "wtfpl"],
      ["license-missing", undefined],
    ] as const) {
      const res = await fix("weak", ruleId, license);
      expect(`${ruleId} ${license} ${res.status}`).toBe(`${ruleId} ${license} 400`);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_query");
    }
    // 400 не зависит от видимости репо: приватный не раскрывается и так
    expect((await fix("secret", "no-such-rule")).status).toBe(400);
  });

  test("лимит — минутное окно карточки: заготовка списывает открытие, окно общее с карточкой", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "rh-v59a-route-limit-"));
    const SECRET = "v59a-route-limit-secret-0123456789";
    const db = openDb({ ...loadConfig(), dataDir: dir2 });
    seedScored({ db, close: () => db.close() }, "acme", "weak", unreachedFacts());
    const cookie = `${SESSION_COOKIE}=${createSession(db, SECRET, upsertUser(db, "ya-v59a", "v59a"))}`;
    db.close();
    const mock2 = startMockApi();
    const server2 = await spawnServer({ dataDir: dir2, mock: mock2, appSecret: SECRET, env: { QUEUE_CARD_PER_MINUTE: "2" } });
    try {
      const get = (path: string) => fetch(`${server2.base}${path}`, { headers: { cookie } });
      expect((await get("/api/repos/acme/weak/fix/contributing-missing")).status).toBe(200);
      expect((await get("/api/repos/acme/weak")).status).toBe(200);
      const limited = await get("/api/repos/acme/weak/fix/codeowners-missing");
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await get("/api/repos/acme/weak")).status).toBe(429);
    } finally {
      await server2.stop();
      mock2.stop();
      try {
        rmSync(dir2, { recursive: true, force: true });
      } catch {
        /* EBUSY на Windows */
      }
    }
  }, 30_000);

  test("лестница — в карточке, но не в /api/v1", async () => {
    const c = await card("weak");
    expect(c.ladder).not.toBeNull();
    expect(c.ladder!.steps[0]!.delta).toBe(c.recommendations.find((r) => r.ruleId === c.ladder!.steps[0]!.ruleId)!.deltaScore!);
    const v1 = await fetch(`${base}/api/v1/repos/acme/weak`);
    expect(v1.status).toBe(200);
    const text = await v1.text();
    for (const leak of ["ladder", "indexAfter", "withoutNumber", "fixTemplate"]) expect(text).not.toContain(leak);
  });
});
