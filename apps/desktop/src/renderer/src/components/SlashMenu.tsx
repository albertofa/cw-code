import { useEffect } from "react";

export interface SlashMenuItem {
  key: string;
  label: string;
  description?: string;
  hint?: string;
}

export function slashOptionId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}

export function SlashMenu({
  id,
  label,
  items,
  activeIndex,
  loading,
  error,
  emptyText,
  moreText,
  onHover,
  onPick
}: {
  id: string;
  label: string;
  items: SlashMenuItem[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  emptyText: string;
  moreText?: string;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}) {
  useEffect(() => {
    document.getElementById(slashOptionId(id, activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [id, activeIndex, items.length]);

  return (
    <div
      id={id}
      className="menu-panel slash-menu"
      role="listbox"
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, index) => (
        <div
          key={item.key}
          id={slashOptionId(id, index)}
          className={`menu-row${item.description ? " has-desc" : ""}${index === activeIndex ? " highlighted" : ""}`}
          role="option"
          aria-selected={index === activeIndex}
          title={item.description ?? item.label}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(index)}
        >
          <span className="menu-text">
            <span className="name">{item.label}</span>
            {item.description && <span className="desc">{item.description}</span>}
          </span>
          {item.hint && <span className="menu-hint">{item.hint}</span>}
        </div>
      ))}
      {moreText && <div className="side-empty">{moreText}</div>}
      {loading && <div className="side-empty">Loading commands…</div>}
      {error && (
        <div className="side-empty slash-menu-error" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && items.length === 0 && <div className="side-empty">{emptyText}</div>}
    </div>
  );
}
