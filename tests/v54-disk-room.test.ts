// Перед клоном – резерв свободного места в tmp; меньше резерва – ждать соседние клоны.
// Смысл скана не меняется: после предела ожидания клон идет как раньше.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { scanFromEnv } from "../src/config";
import { cleanupClone, cloneBare, waitForDiskRoom, type SpawnedGit } from "../src/collectors/git";

const GiB = 1024 ** 3;
const FAST = { pollMs: 1, maxWaitMs: 200 };

function fakeGitProc(code: number): SpawnedGit {
  return { pid: 1, exited: Promise.resolve(code), stderr: new Response("").body!, kill: () => {} };
}

describe("В5.4: резерв диска перед клоном — конфиг", () => {
  test("дефолт (SCAN_MIN_FREE_MB не задана): ключа нет — проверки места нет", () => {
    const clone = scanFromEnv({}).clone;
    expect("minFreeBytes" in clone).toBe(false);
  });

  test("SCAN_MIN_FREE_MB=4096 → резерв 4 ГиБ в байтах", () => {
    expect(scanFromEnv({ SCAN_MIN_FREE_MB: "4096" }).clone.minFreeBytes).toBe(4 * GiB);
  });

  test("мусор и 0 в переменной — как не задана (fail-soft envInt)", () => {
    expect("minFreeBytes" in scanFromEnv({ SCAN_MIN_FREE_MB: "abc" }).clone).toBe(false);
    expect("minFreeBytes" in scanFromEnv({ SCAN_MIN_FREE_MB: "0" }).clone).toBe(false);
  });
});

describe("В5.4: waitForDiskRoom", () => {
  test("резерв не задан — диск не опрашивается вовсе", async () => {
    let calls = 0;
    const r = await waitForDiskRoom("/x", undefined, { freeBytes: () => (calls++, 0), diskWait: FAST });
    expect(r).toEqual({ waitedMs: 0, freeBytes: null, room: true });
    expect(calls).toBe(0);
  });

  test("места хватает — без ожидания, один опрос", async () => {
    let calls = 0;
    const r = await waitForDiskRoom("/x", 2 * GiB, { freeBytes: () => (calls++, 10 * GiB), diskWait: FAST });
    expect(r.room).toBe(true);
    expect(r.freeBytes).toBe(10 * GiB);
    expect(calls).toBe(1);
  });

  test("места мало, соседний клон освободил диск — ждет и продолжает", async () => {
    const seq = [1 * GiB, 1 * GiB, 1 * GiB, 5 * GiB];
    let i = 0;
    const r = await waitForDiskRoom("/x", 2 * GiB, { freeBytes: () => seq[Math.min(i++, seq.length - 1)]!, diskWait: FAST });
    expect(r.room).toBe(true);
    expect(r.freeBytes).toBe(5 * GiB);
    expect(i).toBe(4);
  });

  test("места нет дольше предела — ожидание кончается, клон идет как раньше (room=false)", async () => {
    const r = await waitForDiskRoom("/x", 2 * GiB, { freeBytes: () => 1 * GiB, diskWait: { pollMs: 5, maxWaitMs: 30 } });
    expect(r.room).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(30);
  });

  test("statfs бросает — проверка пропускается, клон не стоит", async () => {
    const r = await waitForDiskRoom("/x", 2 * GiB, {
      freeBytes: () => {
        throw new Error("ENOSYS");
      },
      diskWait: FAST,
    });
    expect(r.room).toBe(true);
    expect(r.freeBytes).toBeNull();
  });

  test("реальный statfs по tmp отвечает числом (шов по умолчанию)", async () => {
    const r = await waitForDiskRoom(tmpdir(), 1, { diskWait: FAST });
    expect(r.room).toBe(true);
    expect(typeof r.freeBytes).toBe("number");
  });
});

describe("В5.4: cloneBare ждет место ДО запуска git", () => {
  test("git стартует только после того, как место освободилось", async () => {
    const order: string[] = [];
    const seq = [1 * GiB, 5 * GiB];
    let i = 0;
    const out = await cloneBare(
      "https://example.com/o/r.git",
      tmpdir(),
      { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000, minFreeBytes: 2 * GiB },
      {
        freeBytes: () => (order.push(`statfs:${seq[Math.min(i, 1)]! / GiB}`), seq[Math.min(i++, 1)]!),
        diskWait: FAST,
        spawnGit: () => (order.push("spawn"), fakeGitProc(0)),
      },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(cleanupClone(out.dir)).toBeNull();
    expect(order).toEqual(["statfs:1", "statfs:5", "spawn"]);
  });

  test("без резерва в лимитах (дефолт) cloneBare диск не опрашивает", async () => {
    let calls = 0;
    const out = await cloneBare(
      "https://example.com/o/r.git",
      tmpdir(),
      { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 },
      { freeBytes: () => (calls++, 0), diskWait: FAST, spawnGit: () => fakeGitProc(0) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(cleanupClone(out.dir)).toBeNull();
    expect(calls).toBe(0);
  });
});
