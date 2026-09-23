// ratingReturn.ts — возврат к своей выдаче рейтинга (Ступень 4 В4.9, В-10).
//
// «Назад» с карточки терял прокрутку таблицы, а крошка «Рейтинг» вела на «/» и
// сбрасывала фильтр, сортировку и страницу. Здесь — адрес последней выдачи и
// прокрутка по ней. Хранилище сессии бывает недоступно (приватный режим,
// запрет сайта) — каждое обращение в try/catch, без него все работает как раньше.

const LAST_KEY = "rh:lastRating";
const SCROLL_KEY = "rh:ratingScroll:";

/** Адрес последней выдачи рейтинга для крошки карточки; нет — «/». */
export function lastRatingHref(): string {
  try {
    const v = sessionStorage.getItem(LAST_KEY);
    // ревью кода R5: только внутренний адрес рейтинга — не «javascript:», не «//чужой»
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
