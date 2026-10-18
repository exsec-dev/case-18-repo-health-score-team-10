// Компактная лента коммитов во входе модели (pipeline.ts compactTimelineFact):
// 60 полных событий с ISO-датами вызывали у YandexGPT отказ «не могу обсуждать
// эту тему»; компактная форма тех же событий проходит. Код ленту из БД берет
// напрямую, эта форма – только для текста модели.
import { describe, expect, test } from "bun:test";
import { compactTimelineFact } from "../src/summary/pipeline";

const full = {
  key: "activity.git.timeline",
  value: {
    events: [
      {
        sha: "b2acfd4f8fba4e91996224b29c992cf83be30904",
        author: { name: "Alice", email: "a@e.com", date: "2026-09-19T20:04:03.000Z" },
        committer: { name: "Alice", email: "a@e.com", date: "2026-09-19T20:04:03.000Z" },
        robot: false,
        robot_reasons: [],
      },
      {
        sha: "1ba512f0000000000000000000000000000000000",
        author: { name: "Bob", email: "b@e.com", date: "2026-09-18T10:00:00.000Z" },
        committer: { name: "Alice", email: "a@e.com", date: "2026-09-18T11:30:00.000Z" },
        robot: false,
        robot_reasons: [],
      },
      {
        sha: "deadbeef00000000000000000000000000000000",
        author: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date: "2026-09-17T03:00:00.000Z" },
        committer: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date: "2026-09-17T03:00:00.000Z" },
        robot: true,
        robot_reasons: ["committer-pattern"],
      },
    ],
    capped: true,
    total: 250,
  },
};

describe("compactTimelineFact", () => {
  test("sha до 7 знаков, дата до минут, коммиттер только если отличается, робот только у роботов", () => {
    const out = compactTimelineFact(full).value as { events: Record<string, unknown>[]; capped: boolean; total: number };
    expect(out.capped).toBe(true);
    expect(out.total).toBe(250);
    expect(out.events).toEqual([
      { sha: "b2acfd4", author: { name: "Alice", email: "a@e.com", date: "2026-09-19 20:04" } },
      {
        sha: "1ba512f",
        author: { name: "Bob", email: "b@e.com", date: "2026-09-18 10:00" },
        committer: { name: "Alice", email: "a@e.com", date: "2026-09-18 11:30" },
      },
      {
        sha: "deadbee",
        author: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date: "2026-09-17 03:00" },
        robot: true,
        robot_reasons: ["committer-pattern"],
      },
    ]);
  });

  test("компактная лента заметно короче полной", () => {
    const before = JSON.stringify(full.value).length;
    const after = JSON.stringify(compactTimelineFact(full).value).length;
    expect(after).toBeLessThan(before * 0.6);
  });

  test("чужие факты и битые значения не трогаются", () => {
    const other = { key: "activity.git.summary", value: { commits: 3 } };
    expect(compactTimelineFact(other)).toBe(other);
    const broken = { key: "activity.git.timeline", value: null };
    expect(compactTimelineFact(broken)).toBe(broken);
  });
});

describe("withoutScanInternals: служебные поля сканера во вход модели не идут", () => {
  test("tree.stats теряет source_unread и loc_note, code.todo – test_markers, остальное на месте", async () => {
    const { withoutScanInternals } = await import("../src/summary/pipeline");
    const tree = withoutScanInternals({ key: "tree.stats", value: { file_count: 22, source_files: 16, test_files: 0, source_unread: 1, loc_note: "incomplete" } });
    expect(tree.value).toEqual({ file_count: 22, source_files: 16, test_files: 0 });
    const todo = withoutScanInternals({ key: "code.todo", value: { count: 0, fixme: 0, older_180d: 0, test_markers: 3 } });
    expect(todo.value).toEqual({ count: 0, fixme: 0, older_180d: 0 });
    const other = { key: "docs.readme", value: { bytes: 1 } };
    expect(withoutScanInternals(other)).toBe(other);
  });
});
