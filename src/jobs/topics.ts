// Пересчет тематик репозиториев (api/topics.ts) в колонку repos.topics.
// Вход правил: адрес, заголовок и описание из каталога, язык платформы и
// зависимости из последнего факта `tree.deps` любого скана. Считается при
// изменении строки каталога (reconcileCatalogRepo), после каждого скана с
// фактами (runScan) и целиком при старте сервера, если версия правил в meta
// отстала от TOPIC_RULES_VERSION (новые правила – новые темы у всей базы).
import type { Database } from "bun:sqlite";
import { parseFactValue } from "../collectors/facts";
import { classifyTopics, encodeTopics, TOPIC_RULES_VERSION } from "../api/topics";
import { getMetaValue, setMetaValue } from "../db";

const META_KEY = "topic_rules_version";

interface RepoTopicRow {
  id: number;
  org_slug: string;
  repo_slug: string;
  title: string | null;
  description: string | null;
  language: string | null;
  topics: string | null;
}

function depsOf(db: Database, repoId: number): string[] {
  const row = db
    .query(
      `SELECT f.value FROM facts f JOIN scans s ON s.id = f.scan_id
       WHERE s.repo_id = ? AND f.key = 'tree.deps' AND f.status = 'ok' ORDER BY f.scan_id DESC LIMIT 1`,
    )
    .get(repoId) as { value: string } | null;
  if (row === null) return [];
  const value = parseFactValue(row.value) as { deps?: unknown } | null;
  return value !== null && typeof value === "object" && Array.isArray(value.deps) ? value.deps.filter((d): d is string => typeof d === "string") : [];
}

function topicsOf(db: Database, row: RepoTopicRow): string | null {
  return encodeTopics(
    classifyTopics({
      slug: `${row.org_slug}/${row.repo_slug}`,
      title: row.title,
      description: row.description,
      language: row.language,
      deps: depsOf(db, row.id),
    }),
  );
}

/** Пересчитать темы одного репозитория; true – значение изменилось. */
export function refreshRepoTopics(db: Database, repoId: number): boolean {
  const row = db.query("SELECT id, org_slug, repo_slug, title, description, language, topics FROM repos WHERE id = ?").get(repoId) as RepoTopicRow | null;
  if (row === null) return false;
  const next = topicsOf(db, row);
  if (next === row.topics) return false;
  db.query("UPDATE repos SET topics = ? WHERE id = ?").run(next, repoId);
  return true;
}

/**
 * Пересчет всей базы при старте: только если версия правил в meta отстала
 * (первый запуск после миграции или правки правил). 30 тыс. строк – секунды,
 * одной транзакцией. Возвращает число пересчитанных строк или null, если
 * пересчет не требовался.
 */
export function backfillTopics(db: Database, log?: (m: string) => void): number | null {
  if (getMetaValue(db, META_KEY) === TOPIC_RULES_VERSION) return null;
  const rows = db.query("SELECT id, org_slug, repo_slug, title, description, language, topics FROM repos").all() as RepoTopicRow[];
  let changed = 0;
  const update = db.query("UPDATE repos SET topics = ? WHERE id = ?");
  db.transaction(() => {
    for (const row of rows) {
      const next = topicsOf(db, row);
      if (next !== row.topics) {
        update.run(next, row.id);
        changed++;
      }
    }
    setMetaValue(db, META_KEY, TOPIC_RULES_VERSION);
  })();
  log?.(`[topics] правила v${TOPIC_RULES_VERSION}: пересчитано ${rows.length} репо, изменилось ${changed}`);
  return changed;
}
