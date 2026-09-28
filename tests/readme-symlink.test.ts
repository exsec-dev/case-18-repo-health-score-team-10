// README для AI-обзора читается только как обычный файл: закоммиченный симлинк
// (например, README.md → /app/.env хоста) в промпт модели не попадает – так же,
// как у инструментов read_file / grep (src/summary/tools.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReadme } from "../src/summary/pipeline";

const dir = mkdtempSync(join(tmpdir(), "rh-readme-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const host = join(dir, "host.env");
writeFileSync(host, "APP_SECRET=do-not-leak\n");

/** Симлинки на Windows без прав разработчика не создаются – тогда проверка ссылки пропускается. */
function canSymlink(): boolean {
  try {
    symlinkSync(host, join(dir, "probe"));
    return true;
  } catch {
    return false;
  }
}

describe("readReadme", () => {
  test("обычный README читается", async () => {
    const root = join(dir, "plain");
    mkdirSync(root);
    writeFileSync(join(root, "README.md"), "# Проект\n");
    expect(await readReadme({ clone: { root } as never })).toBe("# Проект\n");
  });

  test.skipIf(!canSymlink())("README-симлинк на файл хоста не читается", async () => {
    const root = join(dir, "link");
    mkdirSync(root);
    symlinkSync(host, join(root, "README.md"));
    expect(await readReadme({ clone: { root } as never })).toBeNull();
  });

  test("README-каталог не читается", async () => {
    const root = join(dir, "folder");
    mkdirSync(join(root, "README"), { recursive: true });
    expect(await readReadme({ clone: { root } as never })).toBeNull();
  });
});
