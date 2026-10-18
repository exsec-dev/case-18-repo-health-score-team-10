// Живой список SourceCraft по токену пользователя (`GET /me/repos`) в памяти
// процесса – общий для «Моих репозиториев», пикера избранного и права запуска
// анализа по кнопке (`launchRightOf`: репозиторий ваших организаций). Обход
// страниц дорогой (платформа отдает по 1-2 записи на страницу), поэтому полный
// список живет `ttlMs`; одновременные промахи одного пользователя делят один
// обход. В память попадает только полный обход тем же токеном: прерванный сбоем
// список не живет `ttlMs`, а обход прежним токеном, закончившийся после его
// смены, не возвращается. Значение PAT не хранится дольше обхода.
import type { TokenMembership } from "../auth/access";
import type { OrgInfo, ScRepoLite } from "./me";

export interface TokenRepoList {
  /** когда список прочитан из SourceCraft (мс) */
  at: number;
  repos: ScRepoLite[];
  /** список не полный: потолок обхода или обход прерван */
  partial: boolean;
  /** обход прерван сбоем SourceCraft – такой список в память не попадает */
  interrupted: boolean;
  /** логотипы и названия организаций списка (`orgInfoOf`); нет ключа – инициалы и слаг */
  orgs: Record<string, OrgInfo>;
}

/** Обход `/me/repos` одним токеном (`listSourcecraftRepos` с клиентом на этом токене); `userId` – чей список (порядок организаций). */
export type TokenRepoWalk = (
  pat: string,
  userId: number,
) => Promise<{ status: "ok" | "source_http"; partial: boolean; repos: ScRepoLite[]; interrupted?: boolean; orgs?: Record<string, OrgInfo> }>;

export type TokenRepoLoad =
  /** `stale` – новый обход не дало окно, отдан прежний список (возможно, истекший) */
  | { kind: "list"; list: TokenRepoList; stale: boolean }
  /** окно обходов исчерпано, а прежнего списка нет */
  | { kind: "limited" }
  /** SourceCraft не отдал первую страницу */
  | { kind: "failed" };

export interface TokenRepoCache {
  /** Свежий список без сети; null – списка нет или он истек. */
  peek(userId: number): TokenRepoList | null;
  /**
   * Список пользователя: свежий из памяти или обходом. Идущий обход тем же
   * токеном общий – к нему присоединяются без окна; новый обход начинается,
   * только если `mayWalk()` (окно чтений) разрешает.
   */
  load(userId: number, pat: string, opts: { refresh?: boolean; mayWalk: () => boolean }): Promise<TokenRepoLoad>;
  /** Смена или удаление токена: список прежнего токена больше не отдается. */
  forget(userId: number): void;
}

export interface TokenRepoCacheDeps {
  ttlMs: number;
  walk: TokenRepoWalk;
  /** текущий токен пользователя – обход прежним токеном в память не пишется */
  currentPat: (userId: number) => string | null;
  now?: () => number;
}

export function makeTokenRepoCache(deps: TokenRepoCacheDeps): TokenRepoCache {
  const now = deps.now ?? Date.now;
  const lists = new Map<number, TokenRepoList>();
  const flights = new Map<number, { pat: string; promise: ReturnType<TokenRepoWalk> }>();
  const fresh = (list: TokenRepoList | undefined, at: number): list is TokenRepoList => list !== undefined && at - list.at <= deps.ttlMs;
  // просроченные списки уходят из памяти при записи нового – карта не растет с числом пользователей
  const evictExpired = (at: number) => {
    for (const [id, list] of lists) if (!fresh(list, at)) lists.delete(id);
  };

  const startWalk = (userId: number, pat: string) => {
    const started: { pat: string; promise: ReturnType<TokenRepoWalk> } = { pat, promise: deps.walk(pat, userId) };
    // завершение обхода снимает только свою запись: обход прежним токеном не стирает новый
    started.promise = started.promise.finally(() => {
      if (flights.get(userId) === started) flights.delete(userId);
    });
    flights.set(userId, started);
    return started;
  };

  return {
    peek(userId) {
      const list = lists.get(userId);
      return fresh(list, now()) ? list : null;
    },
    async load(userId, pat, opts) {
      const cached = lists.get(userId);
      if (!opts.refresh && fresh(cached, now())) return { kind: "list", list: cached, stale: false };
      let flight = flights.get(userId);
      if (!flight || flight.pat !== pat) {
        if (!opts.mayWalk()) return cached ? { kind: "list", list: cached, stale: true } : { kind: "limited" };
        flight = startWalk(userId, pat);
      }
      const result = await flight.promise;
      if (result.status === "source_http") return { kind: "failed" };
      const list: TokenRepoList = { at: now(), repos: result.repos, partial: result.partial, interrupted: result.interrupted === true, orgs: result.orgs ?? {} };
      if (!list.interrupted && deps.currentPat(userId) === pat) {
        lists.set(userId, list);
        evictExpired(list.at);
      }
      return { kind: "list", list, stale: false };
    },
    forget(userId) {
      lists.delete(userId);
    },
  };
}

/**
 * Есть ли репозиторий в списке. Слаг сравнивается точно, в том виде, как его
 * отдает SourceCraft: строка каталога и ограничение частоты привязаны к
 * точному слагу, и вариант с другим регистром создал бы вторую строку
 * каталога в обход ограничения. Нет в полном списке или в списке, упершемся в
 * потолок обхода, – `no`: такой строки нет и в «Моих репозиториях». Нет в
 * прерванном сбоем – `unknown`: обход мог не дойти до него.
 */
export function membershipIn(list: TokenRepoList, org: string, repo: string): TokenMembership {
  if (list.repos.some((r) => r.org === org && r.slug === repo)) return "yes";
  return list.interrupted ? "unknown" : "no";
}
