import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { DriverName, EffortLevel } from "../cw.js";
import { contextWindowLabel, DEFAULT_EFFORT, effortLabel, type EffortOption } from "./modelMenus.js";
import "./modelPicker.css";

interface EffortItem {
  key: string;
  label: string;
  isDefault: boolean;
  chosen: boolean;
  pick: () => void;
}

interface EffortSection {
  id: string;
  header: string;
  items: EffortItem[];
}

export function EffortIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 9h14M7 5.5v6M13 9v5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EffortMenu({
  driver,
  modelLabel,
  options,
  effort,
  oneM,
  onEffort,
  onContext
}: {
  driver: DriverName;
  modelLabel: string;
  options: EffortOption[];
  effort: EffortLevel;
  oneM: boolean | null;
  onEffort: (effort: EffortLevel) => void;
  onContext: (oneM: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const sections: EffortSection[] = [
    {
      id: "reasoning",
      header: driver === "opencode" ? `Variants · ${modelLabel}` : "Reasoning",
      items: options.map((o) => ({
        key: `effort:${o.id}`,
        label: o.label,
        isDefault: o.id === DEFAULT_EFFORT,
        chosen: o.id === effort,
        pick: () => onEffort(o.id)
      }))
    }
  ];
  if (oneM !== null) {
    sections.push({
      id: "context",
      header: "Context window",
      items: [false, true].map((value) => ({
        key: `context:${value ? "1m" : "200k"}`,
        label: contextWindowLabel(value),
        isDefault: !value,
        chosen: value === oneM,
        pick: () => onContext(value)
      }))
    });
  }

  const items = sections.flatMap((section) => section.items);
  const chosenIndex = items.findIndex((item) => item.key === `effort:${effort}`);
  const keyedIndex = items.findIndex((item) => item.key === activeKey);
  const active = keyedIndex >= 0 ? keyedIndex : Math.max(0, chosenIndex);
  const optionId = (key: string) => `${listId}-${key}`;
  const label = `${effortLabel(effort)}${oneM !== null ? ` · ${contextWindowLabel(oneM)}` : ""}`;

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setActiveKey(null);
    triggerRef.current?.focus();
  };

  const choose = (item: EffortItem | undefined) => {
    if (!item) return;
    close();
    if (!item.chosen) item.pick();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
      close();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length > 0) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveKey(items[(active + step + items.length) % items.length].key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      choose(items[active]);
    }
  };

  return (
    <div className="menu">
      <button
        ref={triggerRef}
        type="button"
        className={`menu-btn${effort !== DEFAULT_EFFORT || oneM === true ? " is-set" : ""}`}
        aria-label="Effort"
        title="Effort"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="menu-btn-icon" aria-hidden="true">
          <EffortIcon />
        </span>
        <span className="menu-value">{label}</span>
        <span className="menu-chevron">{open ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div
            ref={menuRef}
            className="em"
            role="listbox"
            aria-label="Effort"
            tabIndex={-1}
            aria-activedescendant={items[active] ? optionId(items[active].key) : undefined}
            onKeyDown={onKeyDown}
          >
            {sections.map((section, sectionIndex) => (
              <div key={section.id} role="group" aria-labelledby={`${listId}-${section.id}`}>
                {sectionIndex > 0 && <div className="em-sep" aria-hidden="true" />}
                <div id={`${listId}-${section.id}`} className="em-h">
                  {section.header}
                </div>
                {section.items.map((item) => (
                  <div
                    key={item.key}
                    id={optionId(item.key)}
                    role="option"
                    aria-selected={item.chosen}
                    className={`em-it${item.chosen ? " on" : ""}${items[active]?.key === item.key ? " hi" : ""}`}
                    onMouseMove={() => {
                      if (activeKey !== item.key) setActiveKey(item.key);
                    }}
                    onClick={() => choose(item)}
                  >
                    <span className="em-l">
                      {item.label}
                      {item.isDefault && <span className="em-def">Default</span>}
                    </span>
                    {item.chosen && <Check className="em-check" size={14} aria-hidden="true" />}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
