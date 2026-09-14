import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

export interface MenuOption {
  id: string;
  label: string;
  hint?: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  separator?: boolean;
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
  searchPlaceholder,
  icon,
  direction = "up"
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
  icon?: ReactNode;
  direction?: "up" | "down";
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
    ? options.filter((o) => o.separator || o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q))
    : options;

  const rows: MenuOption[] = [];
  for (const o of shown) {
    if (o.separator) {
      if (rows.length > 0 && !rows[rows.length - 1].separator) rows.push(o);
    } else {
      rows.push(o);
    }
  }
  if (rows.length > 0 && rows[rows.length - 1].separator) rows.pop();

  const pickFirst = () => {
    const first = rows.find((option) => !option.disabled && !option.separator);
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
        {icon && (
          <span className="menu-btn-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="menu-value">{display}</span>
        <span className="menu-chevron">{open ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div
            className={`menu-panel${direction === "down" ? " menu-panel-down" : ""}`}
            role="listbox"
            aria-label={label}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "Enter" && searchable && (e.target as HTMLElement).tagName !== "INPUT" && rows.length > 0) {
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
                      if (rows.length > 0) pickFirst();
                    }
                  }}
                />
              </div>
            )}
            {rows.map((o) =>
              o.separator ? (
                <div key={o.id} className="menu-sep" aria-hidden="true">
                  <span>{o.label}</span>
                </div>
              ) : (
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
                    {o.id === value ? <Check aria-hidden="true" size={14} /> : null}
                  </span>
                </div>
              )
            )}
            {rows.length === 0 && <div className="side-empty">No matches.</div>}
          </div>
        </>
      )}
    </div>
  );
}
