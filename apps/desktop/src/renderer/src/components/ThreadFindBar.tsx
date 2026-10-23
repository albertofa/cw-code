import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { ThreadFind } from "./useThreadFind.js";

export function ThreadFindBar({ find }: { find: ThreadFind }) {
  if (!find.open) return null;
  const empty = find.query.trim().length > 0 && find.total === 0;

  return (
    <div className="thread-find" role="search" aria-label="Find in conversation">
      <Search size={13} className="thread-find-ic" aria-hidden="true" />
      <input
        ref={find.inputRef}
        className="thread-find-input"
        type="text"
        value={find.query}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        spellCheck={false}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            find.close();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) find.prev();
            else find.next();
          }
        }}
      />
      <span className={`thread-find-count${empty ? " is-empty" : ""}`} aria-live="polite">
        {find.query.trim().length === 0 ? "" : empty ? "No results" : `${find.position}/${find.total}`}
      </span>
      <button
        type="button"
        className="thread-find-btn"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={find.total === 0}
        onClick={find.prev}
      >
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="thread-find-btn"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={find.total === 0}
        onClick={find.next}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" className="thread-find-btn" title="Close (Esc)" aria-label="Close find" onClick={find.close}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
