import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Check, CheckCircle2, ChevronDown, Search } from "lucide-react";
import { cssFontFamilies, isFontFamilyAvailable, isMonospaceFamily } from "../appearanceFonts.js";
import "./appearance.css";

type FontAccess = { status: "unknown" } | { status: "granted"; families: string[] } | { status: "denied" };

const accessListeners = new Set<() => void>();
let fontAccess: FontAccess = window.queryLocalFonts ? { status: "unknown" } : { status: "denied" };
let accessRequest: Promise<void> | null = null;
const monospaceByFamily = new Map<string, boolean>();

function setFontAccess(next: FontAccess): void {
  fontAccess = next;
  accessListeners.forEach((listener) => listener());
}

function subscribeFontAccess(listener: () => void): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

function requestFontAccess(): Promise<void> {
  if (fontAccess.status !== "unknown") return Promise.resolve();
  if (accessRequest) return accessRequest;
  const query = window.queryLocalFonts;
  if (!query) {
    setFontAccess({ status: "denied" });
    return Promise.resolve();
  }
  accessRequest = query
    .call(window)
    .then((fonts) => {
      const families = [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b));
      setFontAccess(families.length === 0 ? { status: "denied" } : { status: "granted", families });
    })
    .catch((err: unknown) => {
      console.warn("[fonts] local font access failed", err);
      setFontAccess({ status: "denied" });
    })
    .finally(() => {
      accessRequest = null;
    });
  return accessRequest;
}

function isMonospaceCached(family: string): boolean {
  let cached = monospaceByFamily.get(family);
  if (cached === undefined) {
    cached = isMonospaceFamily(family);
    monospaceByFamily.set(family, cached);
  }
  return cached;
}

function faceStyle(family: string): { fontFamily: string } | undefined {
  const list = cssFontFamilies(family);
  return list ? { fontFamily: list } : undefined;
}

type TypedFontState = "empty" | "valid" | "missing" | "not-monospace";

function typedFontState(text: string, requireMonospace: boolean): TypedFontState {
  const name = text.trim();
  if (name === "") return "empty";
  if (!isFontFamilyAvailable(name)) return "missing";
  if (requireMonospace && !isMonospaceFamily(name)) return "not-monospace";
  return "valid";
}

const TYPED_FONT_ERRORS: Partial<Record<TypedFontState, string>> = {
  missing: "Not installed on this device",
  "not-monospace": "Not a fixed-width font"
};

function buildCandidates(families: string[], requireMonospace: boolean, value: string): string[] {
  const listed = requireMonospace ? families.filter(isMonospaceCached) : families;
  return value !== "" && !listed.includes(value) ? [value, ...listed] : listed;
}

export function FontFamilyPicker({
  value,
  defaultLabel,
  requireMonospace = false,
  onChange
}: {
  value: string;
  defaultLabel: string;
  requireMonospace?: boolean;
  onChange: (value: string) => void;
}) {
  const access = useSyncExternalStore(subscribeFontAccess, () => fontAccess);
  const defaultFace = requireMonospace ? "var(--mono)" : "var(--sans)";

  if (access.status === "denied") {
    return <TypedFontInput value={value} defaultLabel={defaultLabel} requireMonospace={requireMonospace} onChange={onChange} />;
  }

  return (
    <FontListPicker
      value={value}
      defaultLabel={defaultLabel}
      defaultFace={defaultFace}
      requireMonospace={requireMonospace}
      families={access.status === "granted" ? access.families : []}
      onChange={onChange}
    />
  );
}

function FontListPicker({
  value,
  defaultLabel,
  defaultFace,
  requireMonospace,
  families,
  onChange
}: {
  value: string;
  defaultLabel: string;
  defaultFace: string;
  requireMonospace: boolean;
  families: string[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionIdPrefix = useId();
  const listboxId = `${optionIdPrefix}-listbox`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const candidates = useMemo(() => buildCandidates(families, requireMonospace, value), [families, requireMonospace, value]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term === "" ? candidates : candidates.filter((family) => family.toLowerCase().includes(term));
  }, [candidates, query]);

  const showDefault = query.trim() === "" || defaultLabel.toLowerCase().includes(query.trim().toLowerCase());
  const entries = useMemo(() => (showDefault ? ["", ...visible] : visible), [showDefault, visible]);
  const active = Math.min(highlight, entries.length - 1);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(".fp-it.hi")?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openPicker = () => {
    if (open) {
      setOpen(false);
      return;
    }
    void requestFontAccess().then(() => {
      if (fontAccess.status === "granted") {
        const current = buildCandidates(fontAccess.families, requireMonospace, value);
        setQuery("");
        setHighlight(Math.max(0, ["", ...current].indexOf(value)));
        setOpen(true);
      }
    });
  };

  const closeAndRestoreFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (family: string) => {
    onChange(family);
    closeAndRestoreFocus();
  };

  const onPopoverKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (entries.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + delta + entries.length) % entries.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(entries[active]);
    }
  };

  const optionProps = (index: number, family: string) => ({
    id: `${optionIdPrefix}-${index}`,
    role: "option" as const,
    tabIndex: -1,
    "aria-selected": family === value,
    className: `fp-it${family === value ? " on" : ""}${index === active ? " hi" : ""}`,
    onClick: () => choose(family),
    onMouseEnter: () => setHighlight(index)
  });
  const familyOffset = showDefault ? 1 : 0;

  return (
    <span ref={rootRef} className={`fpick${open ? " open" : ""}`}>
      <button ref={triggerRef} type="button" className="fp-trig" aria-haspopup="listbox" aria-expanded={open} onFocus={() => void requestFontAccess()} onClick={openPicker}>
        <span className="fp-v" style={value === "" ? { fontFamily: defaultFace } : faceStyle(value)}>
          {value === "" ? defaultLabel : value}
        </span>
        {value === "" && <span className="fp-def">default</span>}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <span className="fp-pop" onKeyDown={onPopoverKeyDown}>
          <span className="fp-search">
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-autocomplete="list"
              value={query}
              placeholder={requireMonospace ? "Search monospace fonts" : "Search fonts"}
              aria-label="Search fonts"
              aria-activedescendant={entries.length > 0 ? `${optionIdPrefix}-${active}` : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
            />
          </span>
          <span ref={listRef} id={listboxId} className="fp-list" role="listbox">
            {showDefault && (
              <span {...optionProps(0, "")}>
                <span style={{ fontFamily: defaultFace }}>{defaultLabel}</span>
                <span className="fp-def">default</span>
                {value === "" && <Check size={13} aria-hidden="true" />}
              </span>
            )}
            {visible.map((family, index) => (
              <span key={family} {...optionProps(index + familyOffset, family)}>
                <span style={faceStyle(family)}>{family}</span>
                {family === value && <Check size={13} aria-hidden="true" />}
              </span>
            ))}
            {visible.length === 0 && !showDefault && <span className="fp-foot">No fonts match</span>}
          </span>
          <span className="fp-foot">{requireMonospace ? "Only fixed-width fonts are listed" : "Installed on this device"}</span>
        </span>
      )}
    </span>
  );
}

function TypedFontInput({
  value,
  defaultLabel,
  requireMonospace,
  onChange
}: {
  value: string;
  defaultLabel: string;
  requireMonospace: boolean;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const state = typedFontState(text, requireMonospace);
  const error = TYPED_FONT_ERRORS[state];

  useEffect(() => {
    setText((current) => (current.trim() === value ? current : value));
  }, [value]);

  const edit = (next: string) => {
    setText(next);
    const nextState = typedFontState(next, requireMonospace);
    if (nextState === "empty" || nextState === "valid") onChange(next.trim());
  };

  return (
    <span className="fpick-typed">
      <input
        className={`field${error ? " bad" : ""}`}
        value={text}
        placeholder={defaultLabel}
        aria-label="Font family"
        aria-invalid={error !== undefined}
        spellCheck={false}
        onChange={(event) => edit(event.target.value)}
      />
      {error && <span className="fp-note fp-note-bad">{error}</span>}
      {state === "valid" && (
        <span className="fp-note fp-note-ok">
          <CheckCircle2 size={13} aria-hidden="true" />
          Installed
        </span>
      )}
    </span>
  );
}
