// slug-input.ts — разбор ввода «org/repo или ссылка» одной копией для сервера
// и веба. В5.3 круг 4 (TASK.md §2 «выбор по продуктовому отчету»): модуль
// вынесен из `me.ts`, который тянет серверные зависимости и в бандл веба не
// годится; `me.ts` реэкспортирует функцию, серверные вызовы не менялись.
// Модуль чистый: без БД, сети и React.

/** Сегмент слага: латиница, цифры, `_ . -`; сегмент из одних точек — обход пути. */
export function slugSegmentOk(seg: string | undefined): seg is string {
  return typeof seg === "string" && seg !== "" && /^[a-z0-9_.-]+$/i.test(seg) && !/^[.]+$/.test(seg);
}

/**
 * Ф2.20: строка ручного ввода → пара слагов. `org/repo` принимается как есть;
 * http(s)-URL — ПЕРВЫЕ ДВА сегмента пути (хвосты вида /tree/main, query и
 * fragment отбрасываются); домен НЕ валидируется — избранное может указывать
 * куда угодно, права резолвятся при проверке. Пустые/точечные сегменты и
 * мусорный charset → null (маршрут отдаёт 400 bad_query). Парсер общий:
 * им пользуются PUT /api/me/favorites, path-роут звезды и поле сравнения.
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
