// Передача клона от скана к AI-обзору внутри одного процесса.
//
// Кнопка полного AI-обзора при устаревшем анализе ставит две заявки подряд:
// сначала скан, затем обзор по нему (обзор ждет свой скан, см. claimNext).
// Без передачи обзор клонировал бы тот же репозиторий второй раз – для крупного
// репозитория это минуты. Скан, за которым в очереди стоит обзор того же
// пользователя, не убирает клон, а кладет его сюда; обзор забирает его вместо
// своего клона и убирает сам. Во всех остальных случаях (скан без обзора
// следом, обзор без скана, плановые сканы, топ рейтинга) ничего не меняется:
// скан убирает клон, обзор клонирует неглубоко.
//
// Реестр живет в памяти процесса: обе заявки пользователя исполняет один
// процесс (роль web/all). Клон, который никто не забрал за TTL (обзор отвален
// лимитом, воркер занят), убирается таймером; при штатной остановке –
// releaseAll; после падения процесса каталог rh-clone-* подберет свип сирот.
import { cleanupClone } from "../collectors/git";

export interface HandoffClone {
  dir: string;
  gitEnv: Record<string, string>;
  /** скан, из которого клон: обзор берет его только для этого же скана */
  scanId: number;
  headSha: string | null;
  bytes: number;
}

/** Сколько клон ждет обзор; обычно обзор заявляется через секунды после скана. */
export const HANDOFF_TTL_MS = 15 * 60_000;

export const handoffKey = (repoId: number, userId: number): string => `${repoId}:${userId}`;

interface Entry extends HandoffClone {
  timer: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();

/** Снять запись с реестра (таймер остановлен); null – записи нет. */
function detach(key: string): Entry | null {
  const entry = entries.get(key);
  if (!entry) return null;
  clearTimeout(entry.timer);
  entries.delete(key);
  return entry;
}

/** Снять запись и убрать ее клон с диска. */
function release(key: string, why: string): boolean {
  const entry = detach(key);
  if (!entry) return false;
  const error = cleanupClone(entry.dir);
  if (error) console.error(`[handoff] cleanup ${entry.dir} (${why}): ${error}`);
  return true;
}

/** Положить клон; прежний клон того же ключа убирается (его уже никто не возьмет). */
export function offerClone(key: string, clone: HandoffClone, ttlMs = HANDOFF_TTL_MS): void {
  release(key, "replaced");
  const timer = setTimeout(() => {
    if (entries.get(key)?.dir === clone.dir) release(key, "expired");
  }, ttlMs);
  timer.unref?.();
  entries.set(key, { ...clone, timer });
}

/**
 * Забрать клон для скана `scanId`. Клон другого скана (между сканом и обзором
 * успел пройти еще один) убирается здесь же – обзор клонирует сам.
 */
export function takeClone(key: string, scanId: number): HandoffClone | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.scanId !== scanId) {
    release(key, `scan ${entry.scanId} != ${scanId}`);
    return null;
  }
  detach(key);
  return { dir: entry.dir, gitEnv: entry.gitEnv, scanId: entry.scanId, headSha: entry.headSha, bytes: entry.bytes };
}

/** Убрать ждущий клон, если обзор до него не дойдет (нет токена, скана, текст уже есть). */
export function releaseHandoff(key: string): boolean {
  return release(key, "not needed");
}

/** Сколько клонов ждет (тесты, диагностика). */
export function pendingHandoffs(): number {
  return entries.size;
}

/** Убрать все ждущие клоны (штатная остановка процесса). Возвращает, сколько убрано. */
export function releaseAllHandoffs(): number {
  const n = entries.size;
  for (const key of Array.from(entries.keys())) release(key, "shutdown");
  return n;
}
