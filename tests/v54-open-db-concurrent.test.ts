// В5.4 (живой старт стенда 26.09, TASK.md §2 «В5.4 — README отдельным этапом, db.ts, снимки» п.3):
// роли web и rating открывают одну БД одновременно. Миграция openDb шла в отложенной (deferred)
// транзакции: чтение схемы, затем запись schema_version — если другой процесс за это время
// записал и закоммитил, снимок устарел и SQLite отвечает SQLITE_BUSY сразу, без ожидания
// busy_timeout. Процесс rating падал на старте (рестарт 1). Контракт: openDb ждет чужую запись
// и не падает.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows держит дескриптор БД упавшего openDb (EBUSY) — каталог уберет ОС */
    }
  }
});

describe("В5.4: openDb при одновременной записи другого процесса", () => {
  test("чужая транзакция пишет и коммитит, пока идет миграция, — openDb дожидается и не падает", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v54-open-"));
    dirs.push(dir);
    // база уже мигрирована (как на стенде: оба процесса стартуют на готовой БД)
    openDb({ ...loadConfig(), dataDir: dir }).close();

    // «второй процесс»: берет блокировку записи, пишет, держит 700 мс и коммитит
    const script = `
      const { Database } = require("bun:sqlite");
      const db = new Database(${JSON.stringify(join(dir, "repo-health.db"))});
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      db.query("INSERT INTO meta (key, value) VALUES ('v54_probe', '1') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
      console.log("locked");
      await Bun.sleep(700);
      db.exec("COMMIT");
      db.close();
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");

    // миграция стартует, пока чужая запись не закоммичена
    let error: unknown = null;
    try {
      openDb({ ...loadConfig(), dataDir: dir }).close();
    } catch (e) {
      error = e;
    }
    expect(await child.exited).toBe(0);
    expect(error).toBeNull();
  });
});
