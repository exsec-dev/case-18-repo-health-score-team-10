// Дерево владельцев (19.10.2026): подкаталоги второго уровня и доли главных авторов
// в факте `code.ownership`; карточка читает и старый факт без новых полей.
import { describe, expect, test } from "bun:test";
import { OWNERSHIP_TOP_AUTHORS, OWNERSHIP_TOP_SUBDIRS, aggregateOwnership, subDir, type OwnershipCommit } from "../src/collectors/ownership";
import { ownershipView } from "../src/report/sections";

const NOW = new Date("2026-10-01T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
let seq = 0;
const commit = (name: string, paths: string[], ago = 10): OwnershipCommit => ({ sha: `s${++seq}`, name, email: `${name.toLowerCase()}@x.example`, authorDate: day(ago), paths });

type Dir = { dir: string; changes: number; owner: string; top_authors: { name: string; share: number }[]; children?: Dir[] };

describe("subDir: подкаталог второго уровня", () => {
  test("только путь из 3 частей и больше; файл не становится каталогом", () => {
    expect(subDir("apps/web/main.ts")).toBe("apps/web");
    expect(subDir("apps/web/src/deep/x.ts")).toBe("apps/web");
    expect(subDir("apps/main.ts")).toBeNull();
    expect(subDir("main.ts")).toBeNull();
    expect(subDir("/abs/x.ts")).toBeNull();
  });
});

describe("aggregateOwnership: ветви и доли", () => {
  test("подкаталоги — до OWNERSHIP_TOP_SUBDIRS самых изменяемых, имя — последняя часть пути", () => {
    const commits: OwnershipCommit[] = [];
    // 7 подкаталогов apps/*: в apps/p{i} — i изменений
    for (let i = 1; i <= OWNERSHIP_TOP_SUBDIRS + 2; i++) for (let k = 0; k < i; k++) commits.push(commit("Alice", [`apps/p${i}/f${k}.ts`]));
    // файл прямо в apps/ — в каталог считается, подкаталогом не становится
    commits.push(commit("Bob", ["apps/root.ts"]));
    const v = aggregateOwnership(commits, { now: NOW, excluded: new Set() }) as { dirs: Dir[] };
    const apps = v.dirs.find((d) => d.dir === "apps")!;
    expect(apps.children!.map((c) => c.dir)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    expect(apps.children!.length).toBe(OWNERSHIP_TOP_SUBDIRS);
    expect(apps.children!.some((c) => c.dir.includes("/") || c.dir.endsWith(".ts"))).toBe(false);
  });

  test("корзина файлов корня — без ветвей; каталог без подкаталогов — без поля children", () => {
    const v = aggregateOwnership([commit("Alice", ["main.go"]), commit("Alice", ["lib/x.ts"])], { now: NOW, excluded: new Set() }) as { dirs: Dir[] };
    expect(v.dirs.find((d) => d.dir === ".")!.children).toBeUndefined();
    expect(v.dirs.find((d) => d.dir === "lib")!.children).toBeUndefined();
  });

  test("доли — до OWNERSHIP_TOP_AUTHORS главных авторов по убыванию, без адресов почты", () => {
    const commits = [
      ...Array.from({ length: 4 }, (_, k) => commit("Alice", [`src/a${k}.ts`])),
      ...Array.from({ length: 3 }, (_, k) => commit("Bob", [`src/b${k}.ts`])),
      ...Array.from({ length: 2 }, (_, k) => commit("Carol", [`src/c${k}.ts`])),
      commit("Dave", ["src/d.ts"]),
    ];
    const v = aggregateOwnership(commits, { now: NOW, excluded: new Set() }) as { dirs: Dir[] };
    const src = v.dirs.find((d) => d.dir === "src")!;
    expect(src.top_authors.length).toBe(OWNERSHIP_TOP_AUTHORS);
    expect(src.top_authors).toEqual([
      { name: "Alice", share: 0.4 },
      { name: "Bob", share: 0.3 },
      { name: "Carol", share: 0.2 },
    ]);
    expect(JSON.stringify(v)).not.toContain("@");
  });
});

describe("ownershipView: старый факт без новых полей", () => {
  test("нет top_authors и children — доля одного владельца, ветвей нет", () => {
    const cat = {
      score: 90,
      submetrics: {
        ownership: {
          score: null,
          value: { threshold: 0.8, window_days: 365, dirs_total: 1, dirs: [{ dir: "src", changes: 4, authors: 2, owner: "Alice", owner_share: 0.75 }] },
        },
      },
    };
    const view = ownershipView(cat as never)!;
    expect(view.rows[0]!.children).toEqual([]);
    expect(view.rows[0]!.shares).toEqual([{ name: "Alice", share: 0.75 }]);
    expect(view.rows[0]!.single).toBe(false);
  });
});
