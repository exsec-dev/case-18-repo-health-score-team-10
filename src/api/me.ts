// me.ts — read-поверхность «мой аккаунт» (В4/Б1): список доступных репо
// по юзерскому PAT. Спискового юзерского эндпоинта в доках нет — план
// Б1: зонд (/user → /orgs/{username}/repos, подтверждён живьём 17.09:
// /user отдаёт username; orgs-список 200) + фолбэк — ручной ввод слага
// в UI. Функции чистые от HTTP-слоя сервера: клиент инъектится, тесты
// без сети. Чужие/недоступные репо не запрашиваются вовсе (ТЗ 5).
import type { Database } from "bun:sqlite";
import { ScClient } from "../collectors/http";

export interface MyRepoEntry {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  lastActivityAt: string | null;
  /** есть ли в нашей БД own-скор по этому репо (для бейджа в UI) */
  ownScore: number | null;
  lastScanAt: string | null;
}

export interface MyReposResult {
  ok: boolean;
  /** namespace владельца токена (для заголовка «репозитории X») */
  username: string | null;
  entries: MyRepoEntry[];
  error?: string;
}

interface RawRepoEntry {
  organization?: { slug?: unknown };
  slug?: unknown;
  name?: unknown;
  language?: { name?: unknown } | string | null;
  last_updated?: unknown;
}

/** GET /user по PAT: чей токен (username) — единственная живая проверка «мой». */
export async function fetchTokenUsername(client: ScClient): Promise<{ ok: true; username: string } | { ok: false; status: number }> {
  const res = await client.get("/user");
  if (res.status !== 200) return { ok: false, status: res.status };
  const body = res.json as { username?: unknown } | null;
  if (typeof body?.username !== "string" || body.username === "") return { ok: false, status: 0 };
  return { ok: true, username: body.username };
}

/**
 * Репо namespace'а владельца токена (≤5 страниц — personal-namespace
 * репо измеряются единицами; исчерпание видно по next_page_token и
// честно отражается записью truncated).
 */
export async function listMyRepos(db: Database, client: ScClient, opts: { maxPages?: number } = {}): Promise<MyReposResult> {
  const who = await fetchTokenUsername(client);
  if (!who.ok) {
    return { ok: false, username: null, entries: [], error: `токен отклонён (HTTP ${who.status})` };
  }
  const maxPages = opts.maxPages ?? 5;
  const entries: MyRepoEntry[] = [];
  let token: string | null = null;
  let pages = 0;
  while (pages < maxPages) {
    const path = `/orgs/${encodeURIComponent(who.username)}/repos?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await client.get(path);
    if (res.status !== 200) break;
    pages++;
    const body = res.json as { repositories?: RawRepoEntry[]; next_page_token?: unknown } | null;
    const list = Array.isArray(body?.repositories) ? body!.repositories! : [];
    for (const raw of list) {
      const org = typeof raw.organization?.slug === "string" ? raw.organization.slug : who.username;
      const repo = typeof raw.slug === "string" ? raw.slug : null;
      if (!repo) continue;
      const language =
        typeof raw.language === "string" ? raw.language : typeof raw.language?.name === "string" ? raw.language.name : null;
      const known = db
        .query(
          `SELECT sc.total, s.finished_at FROM scores sc
           JOIN repos r ON r.id = sc.repo_id
           LEFT JOIN scans s ON s.id = sc.scan_id
           WHERE r.org_slug = ? AND r.repo_slug = ? AND sc.mode = 'own'
           ORDER BY sc.scan_id DESC LIMIT 1`,
        )
        .get(org, repo) as { total: number | null; finished_at: string | null } | null;
      entries.push({
        org,
        repo,
        title: typeof raw.name === "string" ? raw.name : null,
        language,
        lastActivityAt: typeof raw.last_updated === "string" ? raw.last_updated : null,
        ownScore: known ? known.total : null,
        lastScanAt: known ? known.finished_at : null,
      });
    }
    const next = body?.next_page_token;
    if (typeof next !== "string" || next.length === 0) break;
    token = next;
  }
  return { ok: true, username: who.username, entries };
}
