import { useState, type ReactNode } from "react";

export interface MenuOption {
  id: string;
  label: string;
  hint?: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export function MenuSelect({
  label,
  title,
  value,
  display,
  options,
  onPick,
  isSet,
  searchable,
  searchPlaceholder
}: {
  label: string;
  title?: string;
  value: string;
  display: string;
  options: MenuOption[];
  onPick: (id: string) => void;
  isSet?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const toggle = () => {
    setQuery("");
    setOpen((o) => !o);
  };

  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q))
    : options;

  const pickFirst = () => {
    const first = shown.find((option) => !option.disabled);
    close();
    if (first && first.id !== value) onPick(first.id);
  };

  return (
    <div className="menu">
      <button
        className={`menu-btn${isSet ? " is-set" : ""}`}
        aria-label={label}
        title={title ?? label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="menu-value">{display}</span>
        <span className="menu-chevron">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div
            className="menu-panel"
            role="listbox"
            aria-label={label}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "Enter" && searchable && (e.target as HTMLElement).tagName !== "INPUT" && shown.length > 0) {
                pickFirst();
              }
            }}
          >
            {searchable && (
              <div className="menu-search">
                <input
                  className="field"
                  autoFocus
                  placeholder={searchPlaceholder ?? "Filter…"}
                  aria-label="Filter options"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      if (shown.length > 0) pickFirst();
                    }
                  }}
                />
              </div>
            )}
            {shown.map((o) => (
              <div
                key={o.id}
                className={`menu-row${o.id === value ? " active" : ""}${o.description ? " has-desc" : ""}${o.disabled ? " disabled" : ""}`}
                role="option"
                aria-selected={o.id === value}
                title={o.hint ?? o.label}
                onClick={() => {
                  if (o.disabled) return;
                  close();
                  if (o.id !== value) onPick(o.id);
                }}
              >
                {o.icon && <span className="menu-icon">{o.icon}</span>}
                <span className="menu-text">
                  <span className="name">{o.label}</span>
                  {o.description && <span className="desc">{o.description}</span>}
                </span>
                <span className="menu-check" aria-hidden>
                  {o.id === value ? "✓" : ""}
                </span>
              </div>
            ))}
            {shown.length === 0 && <div className="side-empty">No matches.</div>}
          </div>
        </>
      )}
    </div>
  );
}
