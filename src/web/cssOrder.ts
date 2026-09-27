// cssOrder.ts — наши стили (theme.css, layout.css) в документе ПОСЛЕ CSS компонентов uikit.
//
// Bun кладет CSS в разном порядке в dev и в production. Импорт наших файлов после App
// выравнивает production-бандл, но в dev-сервере наши файлы оказываются ПЕРВЫМИ, и правила
// компонентов выигрывают при равной специфичности. Порядок импортов не может быть верным
// в обоих режимах сразу, поэтому страховка — в рантайме: если после наших ссылок (маркер
// `.rh-css-order`) стоят чужие, в конец <head> добавляется КОПИЯ ссылки на тот же файл.
// Исходные ссылки не трогаем: dev-рантайм Bun отключает (`disabled`) вставленные им
// таблицы, если их переместить. Копия следит за `href` оригинала (горячая замена CSS
// в dev меняет его). В production наши правила уже последние — ничего не делается.

/** Маркер наших файлов: правило с этим селектором есть в theme.css и layout.css. */
export const CSS_ORDER_MARKER = ".rh-css-order";

/** Атрибут копии: по нему копия не считается ни «нашей», ни «чужой». */
const COPY_ATTR = "data-rh-css-copy";

/**
 * Каким ссылкам нужна копия в конце: нашим, после которых стоит хотя бы одна чужая.
 * Порядок наших между собой сохраняется (theme.css раньше layout.css).
 */
export function stylesToMove(ours: readonly boolean[]): number[] {
  const lastForeign = ours.lastIndexOf(false);
  const out: number[] = [];
  for (let i = 0; i < lastForeign; i++) if (ours[i]) out.push(i);
  return out;
}

function isOurs(link: HTMLLinkElement): boolean {
  try {
    return [...(link.sheet?.cssRules ?? [])].some((r) => (r as CSSStyleRule).selectorText === CSS_ORDER_MARKER);
  } catch {
    return false;
  }
}

let done = false;

/** Добавляет в конец <head> копии наших таблиц, стоящих перед чужими; ждет загрузки всех. */
export function ourStylesLast(): void {
  if (done) return;
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter((l) => !l.hasAttribute(COPY_ATTR));
  const pending = links.filter((l) => l.sheet === null);
  if (pending.length > 0) {
    // решаем один раз, когда загружено все: иначе «последняя чужая» еще неизвестна
    for (const l of pending) l.addEventListener("load", ourStylesLast, { once: true });
    return;
  }
  done = true;
  for (const i of stylesToMove(links.map(isOurs))) {
    const original = links[i]!;
    const copy = document.createElement("link");
    copy.rel = "stylesheet";
    copy.href = original.href;
    copy.setAttribute(COPY_ATTR, "");
    document.head.append(copy);
    // горячая замена CSS в dev меняет href оригинала — копия идет следом
    new MutationObserver(() => {
      if (copy.href !== original.href) copy.href = original.href;
    }).observe(original, { attributes: true, attributeFilter: ["href"] });
  }
}
