import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, History, Plus, Search, Star } from "lucide-react";
import type { DriverName, ModelOption } from "../cw.js";
import { DriverIcon } from "./DriverIcon.js";
import { hasModelDetail, modelDetailRows, pickerSections, type PickerSection } from "./modelMenus.js";
import { formatTokensShort } from "./subagents.js";
import { harnessLabel } from "./toolTabs.js";
import "./modelPicker.css";

const CARD_GAP = 8;

type Entry =
  | { key: string; kind: "custom" }
  | { key: string; kind: "use-custom"; text: string }
  | { key: string; kind: "model"; model: ModelOption };

interface CardPlacement {
  top: number;
  side: "left" | "right";
}

function entryKey(section: PickerSection, model: ModelOption): string {
  return `${section.id}:${model.id}`;
}

function sectionIcon(icon: PickerSection["icon"]): ReactNode {
  return icon === "recent" ? <History size={13} aria-hidden="true" /> : <DriverIcon driver={icon} size={13} />;
}

export function ModelPicker({
  driver,
  models,
  currentId,
  display,
  isSet,
  title,
  error,
  defaultId,
  recents,
  onPick,
  onCustom,
  onUseCustom,
  onDefaultChange
}: {
  driver: DriverName;
  models: ModelOption[];
  currentId: string;
  display: string;
  isSet: boolean;
  title: string;
  error: string | null;
  defaultId: string;
  recents: string[];
  onPick: (id: string) => void;
  onCustom: () => void;
  onUseCustom: (text: string) => void;
  onDefaultChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [card, setCard] = useState<CardPlacement | null>(null);
  const listId = useId();
  const cardId = `${listId}-card`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const text = query.trim();
  const sections = useMemo(() => pickerSections(driver, models, recents, query), [driver, models, recents, query]);
  const noMatch = text !== "" && sections.length === 0;
  const entries = useMemo<Entry[]>(() => {
    if (noMatch) return [{ key: "use-custom", kind: "use-custom", text }];
    const rows = sections.flatMap((section) =>
      section.models.map((model): Entry => ({ key: entryKey(section, model), kind: "model", model }))
    );
    return [{ key: "custom", kind: "custom" }, ...rows];
  }, [noMatch, sections, text]);

  const currentIndex = entries.findIndex((e) => e.kind === "model" && e.model.id === currentId);
  const firstRowIndex = entries.findIndex((e) => e.kind !== "custom");
  const defaultIndex = currentIndex >= 0 ? currentIndex : Math.max(0, firstRowIndex);
  const keyedIndex = entries.findIndex((e) => e.key === activeKey);
  const active = keyedIndex >= 0 ? keyedIndex : defaultIndex;
  const activeEntry: Entry | undefined = entries[active];
  const detailModel = open && activeEntry?.kind === "model" && hasModelDetail(activeEntry.model) ? activeEntry.model : null;
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const indexOfKey = (key: string) => entries.findIndex((e) => e.key === key);

  const placeCard = () => {
    const pop = popRef.current;
    const row = document.getElementById(optionId(active));
    const el = cardRef.current;
    if (!pop || !row || !el) {
      setCard(null);
      return;
    }
    const popRect = pop.getBoundingClientRect();
    const width = el.offsetWidth;
    const side = popRect.right + CARD_GAP + width <= window.innerWidth ? "right" : popRect.left - CARD_GAP - width >= 0 ? "left" : null;
    if (side === null) {
      setCard(null);
      return;
    }
    const top = Math.max(0, Math.min(row.getBoundingClientRect().top - popRect.top, popRect.height - el.offsetHeight));
    setCard((prev) => (prev && prev.top === top && prev.side === side ? prev : { top, side }));
  };

  useLayoutEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    placeCard();
  }, [open, active, entries, detailModel]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    setQuery("");
    setActiveKey(null);
    setCard(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const toggle = () => {
    if (open) close();
    else setOpen(true);
  };

  const activate = (entry: Entry | undefined) => {
    if (!entry) return;
    if (entry.kind === "custom") {
      close(false);
      onCustom();
      return;
    }
    if (entry.kind === "use-custom") {
      close();
      onUseCustom(entry.text);
      return;
    }
    close();
    if (entry.model.id !== currentId) onPick(entry.model.id);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveKey(entries[(active + step + entries.length) % entries.length].key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      activate(activeEntry);
    }
  };

  const onPopKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };

  const optionProps = (entry: Entry, index: number) => ({
    id: optionId(index),
    role: "option" as const,
    "aria-selected": entry.kind === "model" && entry.model.id === currentId,
    "aria-describedby": index === active && detailModel ? cardId : undefined,
    onMouseDown: (e: ReactMouseEvent) => e.preventDefault(),
    onMouseMove: () => {
      if (activeKey !== entry.key) setActiveKey(entry.key);
    },
    onClick: () => activate(entry)
  });

  const harness = harnessLabel(driver);
  const customHint = driver === "opencode" ? "provider/model or alias" : "model ID or alias";

  return (
    <div className="menu">
      <button
        ref={triggerRef}
        type="button"
        className={`menu-btn${isSet ? " is-set" : ""}`}
        aria-label="Model"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="menu-btn-icon" aria-hidden="true">
          <DriverIcon driver={driver} size={15} />
        </span>
        <span className="menu-value">{display}</span>
        <span className="menu-chevron">{open ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => close()} />
          <div ref={popRef} className="mp-pop" onKeyDown={onPopKeyDown}>
            <div className="mp">
              <div className="mp-search">
                <Search size={14} aria-hidden="true" />
                <input
                  autoFocus
                  role="combobox"
                  aria-label="Search models"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-controls={listId}
                  aria-activedescendant={optionId(active)}
                  placeholder="Search models"
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKeyDown}
                />
              </div>
              <div id={listId} className="mp-body" role="listbox" aria-label="Models">
                {noMatch ? (
                  <div className="mp-empty">
                    <span>No models match “{text}”</span>
                    <div {...optionProps(entries[0], 0)} className={`btn mp-use-custom${active === 0 ? " hi" : ""}`}>
                      <Plus size={12} aria-hidden="true" />
                      <span>Use “{text}” as a custom model</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div {...optionProps(entries[0], 0)} className={`mp-act${active === 0 ? " hi" : ""}`}>
                      <Plus size={14} aria-hidden="true" />
                      Custom model…
                      <span className="mp-hint">{customHint}</span>
                    </div>
                    <div className="mp-list">
                      {sections.map((section) => (
                        <div key={section.id} className="mp-grp" role="group" aria-label={section.label}>
                          <div className="mp-gh" aria-hidden="true">
                            {sectionIcon(section.icon)}
                            <span>{section.label}</span>
                            <span className="n">{section.models.length}</span>
                          </div>
                          {section.models.map((model) => {
                            const key = entryKey(section, model);
                            const index = indexOfKey(key);
                            const selected = model.id === currentId;
                            const isDefault = model.id === defaultId;
                            return (
                              <div
                                key={key}
                                {...optionProps(entries[index], index)}
                                className={`mp-row${selected ? " sel" : ""}${index === active ? " hi" : ""}`}
                              >
                                <span className="mp-n" title={model.id}>
                                  {model.label}
                                </span>
                                {model.contextWindow !== undefined && <span className="mp-ctx">{formatTokensShort(model.contextWindow)}</span>}
                                <span className="mp-end">
                                  {selected && <Check className="mp-check" size={14} aria-hidden="true" />}
                                  <button
                                    type="button"
                                    tabIndex={-1}
                                    className={`mp-star${isDefault ? " on" : ""}`}
                                    aria-pressed={isDefault}
                                    aria-label={`${isDefault ? "Clear" : "Set"} ${model.label} as the ${harness} default model`}
                                    title={isDefault ? `Default for ${harness}. Click to clear` : `Set as the ${harness} default`}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onDefaultChange(isDefault ? "" : model.id);
                                    }}
                                  >
                                    <Star size={14} fill={isDefault ? "currentColor" : "none"} aria-hidden="true" />
                                  </button>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      {sections.length === 0 && (
                        <div className={`mp-empty${error ? " mp-error" : ""}`} role={error ? "alert" : undefined}>
                          {error ? `Model list failed: ${error}` : "No models available."}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
              <div className="mp-foot">
                <span>
                  <span className="mp-kbd">↑↓</span>navigate
                </span>
                <span>
                  <span className="mp-kbd">Enter</span>
                  {noMatch ? "use as custom" : "select"}
                </span>
                <span className="mp-foot-end">
                  <span className="mp-kbd">Esc</span>
                </span>
              </div>
            </div>
            {detailModel && (
              <div
                ref={cardRef}
                id={cardId}
                className={`mp-card mp-card-${card?.side ?? "right"}`}
                role="group"
                aria-label="Model details"
                style={{ top: card?.top ?? 0, visibility: card ? "visible" : "hidden" }}
              >
                {modelDetailRows(detailModel, harness).map((row) => (
                  <div key={row.label} className="mp-kv">
                    <span>{row.label}</span>
                    <b className={row.mono ? "mono" : undefined}>{row.value}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
