// Перенос пользовательских данных со стенда в пересобранную базу перед подменой.
//
// new — копия стенда, снятая раньше и пересобранная локально (полный пересбор
// каталога новым сборщиком); old — свежая копия стенда на момент подмены. Общая
// история у них — до снятия копии; граница определяется по new: первый скан
// пересбора (collector_version >= --collector) и время его старта.
//
// Что переносится из old в new:
// - users, sessions, user_tokens, user_settings, favorites — целиком (замена);
//   токены переносятся шифротекстом, ключ — APP_SECRET стенда;
// - репо, появившиеся на стенде после снятия копии, — по адресу org/repo;
// - пользовательские сканы после границы (факты, оценки, рекомендации, AI) —
//   если у репо в new нет скана новее: иначе их место занял пересбор;
// - AI-тексты и отказы после границы, чьи сканы не перенесены, — к последнему
//   скану репо до границы (карточка покажет их «по прошлому анализу»);
// - пользовательские заявки после границы — для лимитов частоты.
// Периодические сканы стенда после границы не переносятся: пересбор их заменил.
//
// usage: bun scripts/merge-user-data.ts <new.db> <old.db> [--apply] [--collector 6]
// Без --apply — только отчет (new открывается на чтение).
import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const ci = args.indexOf("--collector");
const collector = ci >= 0 ? Number(args[ci + 1]) : 6;
const [newPath, oldPath] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--collector");
if (!newPath || !oldPath) {
  console.error("usage: bun scripts/merge-user-data.ts <new.db> <old.db> [--apply] [--collector 6]");
  process.exit(2);
}

const db = apply ? new Database(newPath) : new Database(newPath, { readonly: true });
db.exec("PRAGMA busy_timeout = 60000");
db.exec(`ATTACH DATABASE '${oldPath.replaceAll("'", "''")}' AS o`);

type Row = Record<string, unknown>;
const one = <T = Row>(sql: string, ...p: unknown[]) => db.query(sql).get(...(p as never[])) as T | null;
const all = <T = Row>(sql: string, ...p: unknown[]) => db.query(sql).all(...(p as never[])) as T[];
const cols = (schema: "main" | "o", table: string): string[] => all<{ name: string }>(`PRAGMA ${schema}.table_info(${table})`).map((c) => c.name);
/** Колонки, общие для обеих баз (схема new могла получить новые колонки). */
const shared = (table: string, without: string[] = []): string[] => {
  const o = new Set(cols("o", table));
  return cols("main", table).filter((c) => o.has(c) && !without.includes(c));
};

// ---------- граница общей истории ----------
const first = one<{ id: number; started_at: string }>("SELECT id, started_at FROM scans WHERE collector_version >= ? ORDER BY id LIMIT 1", collector);
if (!first) throw new Error(`в new нет сканов сборщика ${collector}: это не пересобранная база`);
const scanX = first.id - 1;
const since = first.started_at;
const oldScanMax = one<{ m: number }>("SELECT MAX(id) m FROM o.scans")!.m;
// снятие копии раньше границы: в old сканы до scanX должны совпадать с new
const probe = one<{ n: number }>("SELECT COUNT(*) n FROM o.scans os JOIN scans s ON s.id = os.id WHERE os.id <= ? AND os.id > ? - 50 AND (s.repo_id <> os.repo_id OR s.started_at <> os.started_at)", scanX, scanX);
if (probe && probe.n > 0) throw new Error(`история old и new расходится до границы (скан ${scanX}): old не тот стенд или new снята не с него`);
console.log(`граница: скан ${scanX} (пересбор с ${since}); в old сканов до ${oldScanMax}`);

const report: Record<string, number | string> = {};

const run = () => {
  // ---------- репо: новые на стенде — по адресу ----------
  const repoCols = shared("repos", ["id"]);
  const missing = all("SELECT orp.* FROM o.repos orp LEFT JOIN repos r ON r.org_slug = orp.org_slug AND r.repo_slug = orp.repo_slug WHERE r.id IS NULL");
  report["репо: новые со стенда"] = missing.length;
  if (apply && missing.length > 0) {
    db.exec(`INSERT INTO repos (${repoCols.join(",")}) SELECT ${repoCols.map((c) => `orp.${c}`).join(",")} FROM o.repos orp LEFT JOIN repos r ON r.org_slug = orp.org_slug AND r.repo_slug = orp.repo_slug WHERE r.id IS NULL`);
  }
  const repoMap = new Map<number, number>();
  for (const r of all<{ oid: number; nid: number }>("SELECT orp.id oid, r.id nid FROM o.repos orp JOIN repos r ON r.org_slug = orp.org_slug AND r.repo_slug = orp.repo_slug")) repoMap.set(r.oid, r.nid);
  const repoOf = (oid: unknown): number | null => repoMap.get(Number(oid)) ?? null;

  // ---------- пользователи: замена целиком ----------
  for (const t of ["users", "sessions", "user_tokens", "user_settings", "favorites"]) {
    const n = one<{ n: number }>(`SELECT COUNT(*) n FROM o.${t}`)!.n;
    const was = one<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)!.n;
    report[`${t}: было → стало`] = `${was} → ${n}`;
    if (apply) {
      const c = shared(t);
      db.exec(`DELETE FROM ${t}`);
      db.exec(`INSERT INTO ${t} (${c.join(",")}) SELECT ${c.join(",")} FROM o.${t}`);
    }
  }

  // ---------- пользовательские сканы после границы ----------
  const scanCols = shared("scans", ["id", "repo_id"]);
  const userScans = all<Row & { id: number; repo_id: number; started_at: string }>("SELECT * FROM o.scans WHERE id > ? AND user_id IS NOT NULL ORDER BY id", scanX);
  const scanMap = new Map<number, number>();
  let skippedNewer = 0;
  for (const s of userScans) {
    const repo = repoOf(s.repo_id);
    if (repo === null) continue;
    // уже перенесен прошлым запуском — второй запуск ничего не дублирует
    if (one("SELECT 1 FROM scans WHERE repo_id = ? AND started_at = ? AND user_id IS ?", repo, s.started_at, s.user_id as never)) continue;
    const newer = one("SELECT 1 FROM scans WHERE repo_id = ? AND started_at > ? LIMIT 1", repo, s.started_at);
    if (newer) {
      skippedNewer++;
      continue;
    }
    if (!apply) {
      scanMap.set(s.id, -1);
      continue;
    }
    const res = db.query(`INSERT INTO scans (repo_id, ${scanCols.join(",")}) VALUES (?, ${scanCols.map(() => "?").join(",")})`).run(repo, ...(scanCols.map((c) => s[c]) as never[]));
    const nid = Number(res.lastInsertRowid);
    scanMap.set(s.id, nid);
    const fc = shared("facts", ["scan_id"]);
    db.query(`INSERT INTO facts (scan_id, ${fc.join(",")}) SELECT ?, ${fc.join(",")} FROM o.facts WHERE scan_id = ?`).run(nid, s.id);
    const sc = shared("scores", ["scan_id", "repo_id"]);
    db.query(`INSERT INTO scores (scan_id, repo_id, ${sc.join(",")}) SELECT ?, ?, ${sc.join(",")} FROM o.scores WHERE scan_id = ?`).run(nid, repo, s.id);
    const rc = shared("recommendations", ["scan_id"]);
    db.query(`INSERT INTO recommendations (scan_id, ${rc.join(",")}) SELECT ?, ${rc.join(",")} FROM o.recommendations WHERE scan_id = ?`).run(nid, s.id);
  }
  report["сканы пользователей после границы: перенесено"] = scanMap.size;
  report["сканы пользователей после границы: заменены пересбором"] = skippedNewer;
  report["периодические сканы стенда после границы (не переносятся)"] = one<{ n: number }>("SELECT COUNT(*) n FROM o.scans WHERE id > ? AND user_id IS NULL", scanX)!.n;

  // ---------- AI-тексты и отказы после границы ----------
  // «после границы» — строки old, которых нет в new: номера строк для этого не
  // годятся (ретеншен удаляет старые строки, и SQLite выдает номера повторно)
  for (const table of ["ai_notes", "ai_fails"] as const) {
    const c = shared(table, ["id", "repo_id", "scan_id"]);
    let moved = 0;
    let toOlder = 0;
    let lost = 0;
    for (const n of all<Row & { repo_id: number; scan_id: number }>(
      `SELECT x.* FROM o.${table} x JOIN o.repos orp ON orp.id = x.repo_id
       WHERE NOT EXISTS (SELECT 1 FROM ${table} y JOIN repos r ON r.id = y.repo_id
         WHERE r.org_slug = orp.org_slug AND r.repo_slug = orp.repo_slug AND y.role = x.role AND y.audience IS x.audience AND y.created_at = x.created_at)
       ORDER BY x.id`,
    )) {
      const repo = repoOf(n.repo_id);
      let scan: number | null = null;
      if (scanMap.has(n.scan_id)) scan = scanMap.get(n.scan_id)!;
      else if (n.scan_id <= scanX) scan = n.scan_id;
      else if (repo !== null) {
        scan = one<{ m: number | null }>("SELECT MAX(id) m FROM scans WHERE repo_id = ? AND id <= ?", repo, scanX)?.m ?? null;
        if (scan !== null) toOlder++;
      }
      if (repo === null || scan === null) {
        lost++;
        continue;
      }
      moved++;
      if (apply) db.query(`INSERT INTO ${table} (repo_id, scan_id, ${c.join(",")}) VALUES (?, ?, ${c.map(() => "?").join(",")})`).run(repo, scan, ...(c.map((k) => n[k]) as never[]));
    }
    report[`${table} после границы: перенесено`] = moved;
    report[`${table}: из них к прошлому анализу`] = toOlder;
    if (lost > 0) report[`${table}: не перенесено (нет скана репо)`] = lost;
  }

  // ---------- пользовательские заявки после границы ----------
  const jc = shared("jobs", ["id", "repo_id", "status", "claimed_at", "lease_until"]);
  let jobs = 0;
  for (const j of all<Row & { repo_id: number; status: string }>(
    "SELECT x.* FROM o.jobs x WHERE x.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs y WHERE y.user_id = x.user_id AND y.kind = x.kind AND y.created_at IS x.created_at) ORDER BY x.id",
  )) {
    const repo = repoOf(j.repo_id);
    if (repo === null) continue;
    jobs++;
    // заявка «в работе» на остановленном стенде доделана не будет
    const status = j.status === "running" ? "failed" : j.status;
    if (apply) db.query(`INSERT INTO jobs (repo_id, status, ${jc.join(",")}) VALUES (?, ?, ${jc.map(() => "?").join(",")})`).run(repo, status, ...(jc.map((k) => j[k]) as never[]));
  }
  report["заявки пользователей после границы"] = jobs;
};

if (apply) db.transaction(run)();
else run();

for (const [k, v] of Object.entries(report)) console.log(`  ${k}: ${v}`);
if (apply) {
  const check = one<{ quick_check: string }>("PRAGMA main.quick_check");
  console.log(`готово; quick_check: ${check?.quick_check}`);
} else console.log("отчет без записи; для записи — --apply");
