// v59-a-templates.test.ts — В5.9 (воркер А): файлы-заготовки presence-правил.
// Шаблон, который не подтвержден детектором (файл лег бы, а анализ его не
// увидел), — дефект: каждый шаблон кладется в локальный git-репозиторий и
// проходит через НАСТОЯЩИЙ сборщик (cloneBare + extractFacts, file://, без
// сети), после чего правило на собранных фактах больше не срабатывает.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupClone, cloneBare, extractFacts, readmeSectionFlags } from "../src/collectors/git";
import type { Fact } from "../src/collectors/facts";
import { computeFromFacts } from "../src/score/compute";
import { presencePatches, recommendFromFacts } from "../src/score/recommend";
import { LICENSES } from "../src/fix/licenses";
import { FIX_RULE_IDS, fixTemplateOf, LICENSE_IDS, templateFor, type FixFile } from "../src/fix/templates";

const NOW = new Date("2026-09-27T00:00:00Z");
const LIMITS = { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 };
const EXTRACT = { maxBlameFiles: 50, textCapBytes: 1_000_000 };
const REPO = { org: "acme", repo: "widgets", title: "Widgets" };
const work = mkdtempSync(join(tmpdir(), "rh-v59a-work-"));
const sources: string[] = [];

afterAll(() => {
  for (const d of [...sources, work]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* EBUSY на Windows — уборка tmp не влияет на результат */
    }
  }
});

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

/** Репозиторий: код в src/ (автор с e-mail) + файлы шаблонов → факты настоящего сборщика. */
async function collect(files: Record<string, string>): Promise<Map<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "rh-v59a-src-"));
  sources.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Alice Dev"]);
  git(dir, ["config", "user.email", "alice@example.com"]);
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
  const when = "2026-09-01T10:00:00+00:00";
  const mk = (p: string, body: string) => {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  mk("src/app.ts", "export const answer = 42;\nexport function add(a: number, b: number) {\n  return a + b;\n}\n");
  mk("lib/util.ts", "export const util = () => 1;\n");
  git(dir, ["add", "-A"], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  git(dir, ["commit", "-q", "-m", "code"], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  for (const [p, body] of Object.entries(files)) mk(p, body);
  if (Object.keys(files).length > 0) {
    git(dir, ["add", "-A"], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    git(dir, ["commit", "-q", "-m", "templates"], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  }
  const out = await cloneBare(`file://${dir}`, work, { ...LIMITS });
  if (!out.ok) throw new Error(`clone failed: ${out.reason}`);
  try {
    const facts: Fact[] = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
    return new Map(facts.filter((f) => f.status === "ok").map((f) => [f.key, f.value]));
  } finally {
    cleanupClone(out.dir);
  }
}

/** Правила, которые срабатывают на фактах (движок с положительным Δ-заглушкой: важно условие, не число). */
function firing(ok: Map<string, unknown>): string[] {
  const s = computeFromFacts(ok, { scanId: 1, repoId: 1 }, NOW);
  return recommendFromFacts(ok, { delta: () => ({ delta: 1, reason: null }), issuesScore: 50, codeEmpty: s.codeEmpty }).map((r) => r.ruleId);
}

const tpl = (ruleId: string, facts: Map<string, unknown>, license?: (typeof LICENSE_IDS)[number]): FixFile => {
  const f = templateFor(ruleId, facts, REPO, { license, now: NOW });
  if (f === null) throw new Error(`no template for ${ruleId}`);
  return f;
};

describe("В5.9: шаблон → настоящий сборщик → правило больше не срабатывает", () => {
  test("исходный репозиторий: все 4 правила документации срабатывают", async () => {
    const ok = await collect({});
    const ids = firing(ok);
    for (const id of ["license-missing", "contributing-missing", "codeowners-missing", "readme-missing"]) expect(ids).toContain(id);
  }, 60_000);

  test("CONTRIBUTING.md, CODEOWNERS, LICENSE (MIT и Apache-2.0), README.md: признаки есть, правил нет", async () => {
    const before = await collect({});
    for (const license of LICENSE_IDS) {
      const files = [tpl("contributing-missing", before), tpl("codeowners-missing", before), tpl("license-missing", before, license), tpl("readme-missing", before)];
      expect(files.map((f) => f.filename)).toEqual(["CONTRIBUTING.md", "CODEOWNERS", "LICENSE", "README.md"]);
      const after = await collect(Object.fromEntries(files.map((f) => [f.filename, f.content])));
      expect(after.get("docs.presence")).toMatchObject({ readme: true, license: true, contributing: true, codeowners: true });
      // скелет README со всеми разделами — флаги сборщика «есть»
      expect((after.get("docs.readme") as { flags: unknown }).flags).toEqual({ install: true, build: true, test: true });
      const ids = firing(after);
      for (const id of ["license-missing", "contributing-missing", "codeowners-missing", "readme-missing", "readme-sections-missing"]) expect(ids).not.toContain(id);
    }
  }, 120_000);

  test("README без разделов сборки и тестов: фрагмент README-sections.md закрывает ровно недостающие", async () => {
    const readme = "# Widgets\n\nA library.\n\n## Install\n\nRun the installer.\n";
    const before = await collect({ "README.md": readme });
    expect((before.get("docs.readme") as { flags: unknown }).flags).toEqual({ install: true, build: false, test: false });
    expect(firing(before)).toContain("readme-sections-missing");
    const frag = tpl("readme-sections-missing", before);
    expect(frag.filename).toBe("README-sections.md");
    // фрагмент содержит только недостающие разделы — и детектор видит в нем именно их
    expect(readmeSectionFlags(frag.content)).toEqual({ install: false, build: true, test: true });
    expect(frag.content).not.toContain("## Установка");
    // фрагмент, перенесенный в README, закрывает правило (и сам файл-фрагмент README не подменяет)
    const after = await collect({ "README.md": `${readme}\n${frag.content}`, "README-sections.md": frag.content });
    expect((after.get("docs.readme") as { flags: unknown }).flags).toEqual({ install: true, build: true, test: true });
    expect((after.get("docs.readme") as { bytes: number }).bytes).toBe(Buffer.byteLength(`${readme}\n${frag.content}`));
    expect(firing(after)).not.toContain("readme-sections-missing");
  }, 60_000);

  test("каждый набор недостающих разделов → скелет ровно из них", () => {
    const sections = ["install", "build", "test"] as const;
    for (let mask = 1; mask < 8; mask++) {
      const flags = Object.fromEntries(sections.map((k, i) => [k, (mask & (1 << i)) === 0]));
      const facts = new Map<string, unknown>([
        ["docs.presence", { readme: true }],
        ["docs.readme", { bytes: 100, sections: 1, flags }],
      ]);
      const frag = tpl("readme-sections-missing", facts);
      const want = Object.fromEntries(sections.map((k) => [k, flags[k] !== true]));
      expect(readmeSectionFlags(frag.content)).toEqual(want as { install: boolean; build: boolean; test: boolean });
    }
    // разделы все есть — добавлять нечего: шаблона нет
    const full = new Map<string, unknown>([["docs.readme", { bytes: 100, sections: 3, flags: { install: true, build: true, test: true } }]]);
    expect(templateFor("readme-sections-missing", full, REPO)).toBeNull();
    expect(fixTemplateOf("readme-sections-missing", full)).toBeNull();
  });
});

describe("В5.9: CODEOWNERS — черновик из карты владельцев, без e-mail", () => {
  test("из собранной карты: каталоги с @login, имя автора — в комментарии, e-mail нет", async () => {
    const ok = await collect({});
    const own = ok.get("code.ownership") as { dirs: { dir: string; owner: string }[] };
    expect(own.dirs.map((d) => d.dir).sort()).toEqual(["lib", "src"]);
    const f = tpl("codeowners-missing", ok);
    expect(f.content).not.toContain("alice@example.com");
    expect(f.content).not.toMatch(/[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i);
    expect(f.content).toContain("* @login");
    expect(f.content).toContain("/src/ @login");
    expect(f.content).toContain("/lib/ @login");
    expect(f.content).toMatch(/# src: главный автор – Alice Dev, 100% изменений/);
    // владельцы в строках шаблона — только плейсхолдер: имя из git логином не выдается
    for (const line of f.content.split("\n").filter((l) => l && !l.startsWith("#"))) expect(line).toMatch(/ @login$/);
  }, 60_000);

  test("имя-адрес маскируется, корень — /*, спецсимволы и переводы строк не ломают файл", () => {
    const facts = new Map<string, unknown>([
      [
        "code.ownership",
        {
          dirs: [
            { dir: ".", changes: 5, authors: 1, owner: "root@corp.example.com", owner_share: 1 },
            { dir: "my docs", changes: 3, authors: 2, owner: "Bob <bob@corp.example.com>", owner_share: 0.5 },
            { dir: "evil\ndir", changes: 1, authors: 1, owner: "Eve\n* @attacker", owner_share: 1 },
          ],
        },
      ],
    ]);
    const f = tpl("codeowners-missing", facts);
    expect(f.content).not.toContain("corp.example.com");
    expect(f.content).not.toContain("@attacker\n");
    expect(f.content).toContain("/* @login");
    expect(f.content).toContain("# файлы в корне: главный автор – (имя не указано), 100% изменений");
    expect(f.content).toContain("/my\\ docs/ @login");
    expect(f.content).toContain("# my docs: главный автор – Bob, 50% изменений");
    // каталог с переводом строки строкой шаблона не записывается
    expect(f.content).not.toContain("evil");
    expect(f.content.split("\n").filter((l) => l && !l.startsWith("#")).every((l) => / @login$/.test(l))).toBe(true);
  });

  test("карты нет: владелец по умолчанию и подсказка вписать каталоги вручную", () => {
    const f = tpl("codeowners-missing", new Map());
    expect(f.content).toContain("* @login");
    expect(f.content).toContain("Карта владельцев за 365 дней пуста");
  });
});

describe("В5.9: LICENSE — выбирает человек, текст канонический", () => {
  test("без выбора шаблона нет; признак карточки перечисляет варианты", () => {
    expect(templateFor("license-missing", new Map(), REPO)).toBeNull();
    expect(fixTemplateOf("license-missing", new Map())).toEqual({ filename: "LICENSE", licenses: ["mit", "apache-2.0"] });
  });

  test("тексты не правлены руками: sha256 совпадает с зафиксированным при генерации", () => {
    for (const id of LICENSE_IDS) expect(createHash("sha256").update(LICENSES[id].text).digest("hex")).toBe(LICENSES[id].sha256);
    expect(LICENSES["apache-2.0"].text.length).toBe(11357);
    expect(LICENSES["apache-2.0"].text).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(LICENSES.mit.text.startsWith("MIT License\n\nCopyright (c) {{year}} {{owner}}\n")).toBe(true);
  });

  test("MIT: год и владелец подставлены, остальное — канон; Apache-2.0 — без изменений", () => {
    const mit = tpl("license-missing", new Map(), "mit").content;
    expect(mit.split("\n")[2]).toBe("Copyright (c) 2026 acme");
    expect(mit).not.toContain("{{");
    expect(mit.replace("Copyright (c) 2026 acme", "Copyright (c) {{year}} {{owner}}")).toBe(LICENSES.mit.text);
    expect(tpl("license-missing", new Map(), "apache-2.0").content).toBe(LICENSES["apache-2.0"].text);
  });
});

describe("В5.9: набор правил и типографика", () => {
  test("заготовки есть ровно у 5 правил документации; прочие — null", () => {
    expect([...FIX_RULE_IDS].sort()).toEqual(["codeowners-missing", "contributing-missing", "license-missing", "readme-missing", "readme-sections-missing"]);
    for (const id of ["add-tests", "ci-missing", "start-tracker", "fix-red-runs", "connect-appsec", "unknown"]) {
      expect(fixTemplateOf(id, new Map())).toBeNull();
      expect(templateFor(id, new Map(), REPO)).toBeNull();
    }
  });

  test("русские шаблоны: без длинного тире и буквы «ё» (AGENTS.md, пользовательские тексты)", () => {
    const facts = new Map<string, unknown>([
      ["docs.readme", { bytes: 1, sections: 0, flags: {} }],
      ["code.ownership", { dirs: [{ dir: "src", owner: "Alice", owner_share: 0.9 }] }],
    ]);
    for (const id of ["contributing-missing", "readme-missing", "readme-sections-missing", "codeowners-missing"]) {
      const c = tpl(id, facts).content;
      expect(c).not.toContain("—");
      expect(c).not.toMatch(/[ёЁ]/);
    }
  });

  test("заготовки детерминированы: те же факты — тот же файл", () => {
    const facts = new Map<string, unknown>([["code.ownership", { dirs: [{ dir: "src", owner: "Alice", owner_share: 0.9 }] }]]);
    for (const id of ["contributing-missing", "readme-missing", "codeowners-missing"]) expect(tpl(id, facts)).toEqual(tpl(id, facts));
  });

  test("presencePatches и шаблоны покрывают одни и те же публичные правила документации", () => {
    const ok = new Map<string, unknown>([
      ["docs.presence", { readme: false, license: false, contributing: false, codeowners: false, content_checked: true }],
      ["docs.readme", { present: false }],
    ]);
    const presence = presencePatches(ok, { pub: true, codeScored: false }).map((p) => p.ruleId);
    for (const id of presence) expect(fixTemplateOf(id, ok)).not.toBeNull();
  });
});
