// recheck.ts — В4.8.5 (К8.5.14 (д), §2-В1, §2-Р1): фоновая перепроверка прав
// избранного. Насос в памяти процесса: один активный на пользователя, порции
// по нескольку записей с паузой, запросы к SourceCraft — через общий ритм
// (хост, токен) клиента `http.ts` (К8.5.5a). Окно действий человека (проверок
// прав в минуту) насос НЕ расходует; анализ НЕ ставит (§2-Р1: первый анализ
// своего — только при явном добавлении). Запускается из `PUT /api/me/pat`
// (после гашения прав) и `GET /api/me/repos` (записи «не проверено» или
// старше суток). Очередь теряется при рестарте — её покрывает то же правило
// «не проверено или старше суток» при следующем открытии списка. UI узнаёт
// итог при следующем чтении списка (без пуша).
//
// Сбой SourceCraft (0/429/5xx) на записи — порция и очередь пользователя
// останавливаются (не долбить лежащую платформу), права записи не трогаются
// (К8.5.6); отклонённый токен (401) — тоже стоп: следующие записи дадут то же.
import type { Database } from "bun:sqlite";
import { checkFavoriteAccess, type FavoriteCheckResult } from "./me";
import type { ProbeIo } from "../auth/access";

export interface RecheckPumpDeps {
  db: Database;
  /** ввод-вывод проверки на PAT пользователя; null — токена нет (очередь гасится) */
  probeIo: (userId: number) => ProbeIo | null;
  /** записей в порции (дефолт 5) */
  batchSize?: number;
  /** пауза между порциями, мс (дефолт 2 с) */
  pauseMs?: number;
  /** шов фейковых часов */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface RecheckPump {
  /** поставить записи пользователю (повтор уже стоящей — no-op) и запустить насос, если он стоит */
  enqueue(userId: number, slugs: { org: string; repo: string }[]): void;
  /** сколько записей ждёт у пользователя */
  pending(userId: number): number;
  /** идёт ли насос пользователя */
  running(userId: number): boolean;
  /** снять очередь пользователя (токен удалён) */
  clear(userId: number): void;
  /** промис текущего прохода пользователя (тесты) */
  idle(userId: number): Promise<void>;
}

export const RECHECK_BATCH = 5;
export const RECHECK_PAUSE_MS = 2_000;

export function makeRecheckPump(deps: RecheckPumpDeps): RecheckPump {
  const batchSize = Math.max(1, deps.batchSize ?? RECHECK_BATCH);
  const pauseMs = Math.max(0, deps.pauseMs ?? RECHECK_PAUSE_MS);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const queues = new Map<number, string[]>();
  const runs = new Map<number, Promise<void>>();

  const run = async (userId: number): Promise<void> => {
    try {
      for (;;) {
        const queue = queues.get(userId);
        if (!queue || queue.length === 0) break;
        const io = deps.probeIo(userId);
        if (io === null) {
          queues.delete(userId);
          break;
        }
        const portion = queue.splice(0, batchSize);
        let stop: FavoriteCheckResult | null = null;
        for (const slug of portion) {
          const [org, repo] = slug.split("/") as [string, string];
          // запись могли убрать из избранного, пока она ждала
          const still = deps.db.query("SELECT 1 FROM favorites WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").get(userId, org, repo);
          if (!still) continue;
          try {
            const out = await checkFavoriteAccess(deps.db, userId, org, repo, { ...io, cooldownMs: Number.POSITIVE_INFINITY }, null);
            if (out.result !== "checked") {
              stop = out.result;
              break;
            }
          } catch (e) {
            log(`[recheck] user ${userId} ${slug}: ${String((e as Error).message).slice(0, 160)}`);
          }
        }
        if (stop !== null) {
          log(`[recheck] user ${userId}: stopped (${stop}), ${queues.get(userId)?.length ?? 0} left for the next list read`);
          queues.delete(userId);
          break;
        }
        if ((queues.get(userId)?.length ?? 0) > 0 && pauseMs > 0) await sleep(pauseMs);
      }
    } finally {
      runs.delete(userId);
      if ((queues.get(userId)?.length ?? 0) === 0) queues.delete(userId);
    }
  };

  return {
    enqueue(userId, slugs) {
      if (slugs.length === 0) return;
      const queue = queues.get(userId) ?? [];
      for (const { org, repo } of slugs) {
        const slug = `${org}/${repo}`;
        if (!queue.includes(slug)) queue.push(slug);
      }
      queues.set(userId, queue);
      if (!runs.has(userId)) runs.set(userId, run(userId));
    },
    pending: (userId) => queues.get(userId)?.length ?? 0,
    running: (userId) => runs.has(userId),
    clear(userId) {
      queues.delete(userId);
    },
    idle: (userId) => runs.get(userId) ?? Promise.resolve(),
  };
}
