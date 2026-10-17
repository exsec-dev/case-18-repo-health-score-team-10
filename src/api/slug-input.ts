// Разбор ввода «org/repo или ссылка», общий для сервера и веба. Живет отдельно
// от `me.ts` (тот тянет серверные зависимости и в бандл веба не годится), поэтому
// модуль чистый: без БД, сети и React.

/** Сегмент слага: латиница, цифры, `_ . -`; сегмент из одних точек — обход пути. */
export function slugSegmentOk(seg: string | undefined): seg is string {
  return typeof seg === "string" && seg !== "" && /^[a-z0-9_.-]+$/i.test(seg) && !/^[.]+$/.test(seg);
}

/**
 * Строка ручного ввода → пара слагов. `org/repo` принимается как есть; у
 * http(s)-URL берутся первые два сегмента пути (хвосты вида /tree/main, query
 * и fragment отбрасываются). Домен не проверяется: права все равно выясняются
 * при проверке доступа. Пустые, точечные сегменты и лишние символы → null
 * (маршрут отдает 400 bad_query).
 */
export function parseFavoriteInput(raw: string): { org: string; repo: string } | null {
  const value = raw.trim();
  if (value === "") return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const [org, repo] = url.pathname.split("/").filter((p) => p !== "");
      if (!slugSegmentOk(org) || !slugSegmentOk(repo)) return null;
      return { org, repo };
    } catch {
      return null;
    }
  }
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  if (!slugSegmentOk(parts[0]) || !slugSegmentOk(parts[1])) return null;
  return { org: parts[0]!, repo: parts[1]! };
}

/**
 * Страница репо на SourceCraft (шаблон платформы, колонки в схеме нет) – один
 * литерал для карточки, строки рейтинга и шапки репозитория вне каталога.
 */
export function repoWebUrl(org: string, repo: string): string {
  return `https://sourcecraft.dev/${org}/${repo}`;
}
