import { CornerDownLeft, Search } from "lucide-react";
import type { SearchResult } from "minisearch";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { searchIndex, snippet, type SearchSection } from "./search.js";

type Hit = SearchResult & SearchSection;

/** The Ctrl+K search: sections of every docs page, best match first. */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  // The query the current hits answer: until it matches, the index is still loading.
  const [answered, setAnswered] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
    // Start building the index as soon as search opens, not on the first keystroke.
    void searchIndex();
  }, [open]);

  useEffect(() => {
    let current = true;
    const q = query.trim();
    if (q === "") {
      setHits([]);
      return;
    }
    void searchIndex().then((mini) => {
      if (!current) return;
      setHits(mini.search(q).slice(0, 8) as Hit[]);
      setAnswered(q);
      setActive(0);
    });
    return () => {
      current = false;
    };
  }, [query]);

  if (!open) return null;

  const go = (hit: Hit | undefined) => {
    if (hit === undefined) return;
    onClose();
    void navigate(`/docs/${hit.slug}${hit.anchor ? `#${hit.anchor}` : ""}`);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Search the docs"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} className="text-muted" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") go(hits[active]);
            }}
            placeholder="Search the docs"
            aria-label="Search the docs"
            className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
          />
          <kbd className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted">
            Esc
          </kbd>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto p-2" role="listbox">
          {query.trim() !== "" && answered !== query.trim() && hits.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-muted">Searching…</li>
          )}
          {query.trim() !== "" && answered === query.trim() && hits.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-muted">
              Nothing found for "{query.trim()}".
            </li>
          )}
          {hits.map((hit, i) => (
            <li key={hit.id} role="option" aria-selected={i === active}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => go(hit)}
                className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left ${
                  i === active ? "bg-surface" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className="text-muted">{hit.page}</span>
                    {hit.anchor && <span> › {hit.heading}</span>}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                    {snippet(hit.text, hit.terms)}
                  </p>
                </div>
                {i === active && <CornerDownLeft size={14} className="mt-1 shrink-0 text-muted" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Opens search with Ctrl+K / Cmd+K, or "/" when not typing somewhere. */
export function useSearchShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}
