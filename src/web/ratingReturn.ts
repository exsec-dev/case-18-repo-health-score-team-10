// ratingReturn.ts — возврат с карточки к своей выдаче рейтинга: адрес последней
// выдачи (крошка «Рейтинг» не сбрасывает фильтр, сортировку и страницу) и
// прокрутка по ней. sessionStorage бывает недоступен (приватный режим, запрет
// сайта) — тогда крошка ведет на «/», а прокрутка не восстанавливается.

const LAST_KEY = "rh:lastRating";
const SCROLL_KEY = "rh:ratingScroll:";

/** Адрес последней выдачи рейтинга для крошки карточки; нет — «/». */
export function lastRatingHref(): string {
  try {
    const v = sessionStorage.getItem(LAST_KEY);
    // только внутренний адрес рейтинга — не «javascript:», не «//чужой»
    return v !== null && (v === "/" || v.startsWith("/?")) ? v : "/";
  } catch {
    return "/";
  }
}

export function rememberRatingHref(search: string): void {
  try {
    sessionStorage.setItem(LAST_KEY, search ? `/?${search}` : "/");
  } catch {
    /* хранилище недоступно — крошка ведет на «/» */
  }
}

export function saveRatingScroll(search: string, top: number): void {
  try {
    sessionStorage.setItem(SCROLL_KEY + search, String(Math.round(top)));
  } catch {
    /* без хранилища прокрутка не восстанавливается */
  }
}

export function loadRatingScroll(search: string): number {
  try {
    return Number(sessionStorage.getItem(SCROLL_KEY + search) ?? 0) || 0;
  } catch {
    return 0;
  }
}
