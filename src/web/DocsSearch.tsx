// Поиск по документации – в строке пути раздела /docs, как в документации SourceCraft.
// Ищет в браузере по уже загруженным страницам (/api/docs отдает все сразу): заголовок
// страницы, заголовки разделов и текст раздела. Русские окончания срезаются грубой
// основой слова, чтобы «оценки» находило «оценка».
import { Magnifier } from "@gravity-ui/icons";
import { Icon, Popup, TextInput } from "@gravity-ui/uikit";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DocPage } from "../docs/model";
import { buildSearchIndex, queryTerms, searchDocs, type SearchHit } from "../docs/search";

/** Подсветка основ запроса во фрагменте. */
function highlight(text: string, terms: string[]): ReactNode[] {
  if (terms.length === 0) return [text];
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

export function DocsSearch({ pages, onOpen }: { pages: DocPage[]; onOpen: (slug: string, anchor: string | null) => void }) {
  const index = useMemo(() => buildSearchIndex(pages), [pages]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => searchDocs(index, query), [index, query]);
  const terms = useMemo(() => queryTerms(query), [query]);

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
        placeholder="Поиск по документации"
        hasClear
        startContent={<Icon data={Magnifier} size={16} className="rh-docs-search__lens" />}
        controlProps={{ "aria-label": "Поиск по документации", "aria-expanded": open && query !== "", role: "combobox" }}
        onUpdate={(v) => {
          setQuery(v);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <Popup open={open && query.trim().length >= 2} anchorElement={anchor.current} placement="bottom-end" onOpenChange={(next) => !next && setOpen(false)}>
        <div className="rh-docs-search__results" role="listbox" aria-label="Результаты поиска">
          {hits.length === 0 ? (
            <div className="rh-docs-search__empty">Ничего не найдено</div>
          ) : (
            hits.map((h, i) => (
              <button
                type="button"
                key={`${h.entry.slug}#${h.entry.anchor ?? ""}`}
                role="option"
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
              </button>
            ))
          )}
        </div>
      </Popup>
    </div>
  );
}
