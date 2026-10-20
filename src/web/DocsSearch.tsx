// Поиск по документации – в строке пути раздела /docs, как в документации SourceCraft.
// Ищет в браузере по уже загруженным страницам (/api/docs отдает все сразу): заголовок
// страницы, заголовки разделов и текст раздела. Русские окончания срезаются грубой
// основой слова, чтобы «оценки» находило «оценка».
import { Magnifier } from "@gravity-ui/icons";
import { Icon, Popup, TextInput } from "@gravity-ui/uikit";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DocPage } from "../docs/model";
import { useMediaQuery } from "./prefs";
import { buildSearchIndex, queryTerms, searchDocs, type SearchHit } from "../docs/search";

/** Подсветка основ запроса во фрагменте. */
function highlight(text: string, terms: string[]): ReactNode[] {
  if (terms.length === 0) return [text];
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

export function DocsSearch({ pages, onOpen }: { pages: DocPage[]; onOpen: (slug: string, anchor: string | null) => void }) {
  const phone = useMediaQuery("(max-width: 767px)");
  const index = useMemo(() => buildSearchIndex(pages), [pages]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const listId = useId();
  const hitId = (i: number): string => `${listId}-hit-${i}`;
  const hits = useMemo(() => searchDocs(index, query), [index, query]);
  const terms = useMemo(() => queryTerms(query), [query]);
  const shown = open && query.trim().length >= 2;

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQuery("");
    onOpen(hit.entry.slug, hit.entry.anchor);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      go(hits[active]!);
    } else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={anchor} className="rh-docs-search">
      <TextInput
        size="m"
        value={query}
        // на телефоне поле узкое — «Поиск по документ» обрезался; имя поля — в aria-label
        placeholder={phone ? "Поиск" : "Поиск по документации"}
        hasClear
        startContent={<Icon data={Magnifier} size={16} className="rh-docs-search__lens" />}
        // стандартный combobox: фокус остается в поле, подсвеченный пункт — через aria-activedescendant
        controlProps={{
          "aria-label": "Поиск по документации",
          "aria-expanded": shown,
          role: "combobox",
          "aria-controls": listId,
          "aria-autocomplete": "list",
          "aria-activedescendant": shown && hits[active] ? hitId(active) : undefined,
        }}
        onUpdate={(v) => {
          setQuery(v);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {/* число результатов — для скринридера */}
      <span className="rh-sr-only" aria-live="polite">
        {shown ? (hits.length === 0 ? "Ничего не найдено" : `Найдено: ${hits.length}`) : ""}
      </span>
      <Popup open={shown} anchorElement={anchor.current} placement="bottom-end" onOpenChange={(next) => !next && setOpen(false)}>
        <div className="rh-docs-search__results" role="listbox" id={listId} aria-label="Результаты поиска">
          {hits.length === 0 ? (
            <div className="rh-docs-search__empty">Ничего не найдено</div>
          ) : (
            hits.map((h, i) => (
              // пункт — option, а не кнопка: кнопка внутри listbox — лишняя фокусируемая роль
              <div
                key={`${h.entry.slug}#${h.entry.anchor ?? ""}`}
                id={hitId(i)}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className={i === active ? "rh-docs-search__hit rh-docs-search__hit_active" : "rh-docs-search__hit"}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(h)}
              >
                <span className="rh-docs-search__title">
                  {highlight(h.entry.page, terms)}
                  {h.entry.section && <span className="rh-docs-search__section"> › {highlight(h.entry.section, terms)}</span>}
                </span>
                {h.snippet && <span className="rh-docs-search__snippet">{highlight(h.snippet, terms)}</span>}
              </div>
            ))
          )}
        </div>
      </Popup>
    </div>
  );
}
