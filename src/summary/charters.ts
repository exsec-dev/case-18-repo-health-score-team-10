// charters.ts — загрузчик хартий prompts/ (закон 4: fail-fast на старте
// использования; спека В5 К5.1). Тон-гайд prompts/tone.md включается во все
// хартии: итоговый системный промпт = tone + хартия роли. Версия хартии
// живёт в первой строке файла (`<!-- charter-version: N -->`) и в записи
// результата (ai_notes.charter_version).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SummaryRole } from "./roles";
import { SUMMARY_ROLES } from "./roles";

export interface Charter {
  role: SummaryRole;
  version: string;
  /** полный системный промпт: тон-гайд + хартия */
  text: string;
}

/** Каталог хартий: лениво (env-шов тестов читается на каждый вызов). */
function promptsDir(): string {
  return process.env.CHARTERS_DIR ?? join(import.meta.dir, "..", "..", "prompts");
}
const VERSION_RE = /^<!--\s*charter-version:\s*(\S+)\s*-->/;

function readCharterFile(role: SummaryRole): { version: string; body: string } {
  const path = join(promptsDir(), `summary.${role}.md`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`charter for role "${role}" is missing: ${path} (${String((e as Error).message)})`);
  }
  const m = raw.match(VERSION_RE);
  if (!m || !m[1]) {
    throw new Error(`charter for role "${role}" has no charter-version marker on the first line: ${path}`);
  }
  const body = raw.slice(raw.indexOf("-->")! + 3).trim();
  if (body.length === 0) {
    throw new Error(`charter for role "${role}" is empty: ${path}`);
  }
  return { version: m[1], body };
}

function readTone(): string {
  const path = join(promptsDir(), "tone.md");
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) throw new Error(`tone guide is empty: ${path}`);
  return raw.replace(VERSION_RE, "").trim();
}

const cache = new Map<SummaryRole, Charter>();
let tone: string | null = null;

/**
 * Хартия роли. Fail-fast: отсутствующий/пустой файл или маркер версии —
 * исключение в момент первого использования роли (не молчаливый промпт
 * «что-нибудь»). Повторные вызовы берут из кэша процесса.
 */
export function loadCharter(role: SummaryRole): Charter {
  const hit = cache.get(role);
  if (hit) return hit;
  tone ??= readTone();
  const { version, body } = readCharterFile(role);
  const charter: Charter = { role, version, text: `${tone}\n\n${body}` };
  cache.set(role, charter);
  return charter;
}

/** Все хартии на месте (самопроверка старта конвейера: 9 ролей + тон). */
export function loadAllCharters(): Record<SummaryRole, Charter> {
  const out = {} as Record<SummaryRole, Charter>;
  for (const role of SUMMARY_ROLES) out[role] = loadCharter(role);
  return out;
}

/** Шов тестов: сброс кэша (смена CHARTERS_DIR между тестами). */
export function __resetCharterCache(): void {
  cache.clear();
  tone = null;
}
