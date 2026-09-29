import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
      setFontAccess({ status: "granted", families });
    })
    .catch(() => setFontAccess({ status: "denied" }))
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
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const candidates = useMemo(() => {
    const listed = requireMonospace ? families.filter(isMonospaceCached) : families;
    return value !== "" && !listed.includes(value) ? [value, ...listed] : listed;
  }, [families, requireMonospace, value]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term === "" ? candidates : candidates.filter((family) => family.toLowerCase().includes(term));
  }, [candidates, query]);

  const openPicker = () => {
    if (open) {
      setOpen(false);
      return;
    }
    void requestFontAccess().then(() => {
      if (fontAccess.status === "granted") {
        setQuery("");
        setOpen(true);
      }
    });
  };

  const choose = (family: string) => {
    onChange(family);
    setOpen(false);
  };

  const showDefault = query.trim() === "" || defaultLabel.toLowerCase().includes(query.trim().toLowerCase());

  return (
    <span ref={rootRef} className={`fpick${open ? " open" : ""}`}>
      <button type="button" className="fp-trig" aria-haspopup="listbox" aria-expanded={open} onFocus={() => void requestFontAccess()} onClick={openPicker}>
        <span className="fp-v" style={value === "" ? { fontFamily: defaultFace } : faceStyle(value)}>
          {value === "" ? defaultLabel : value}
        </span>
        {value === "" && <span className="fp-def">default</span>}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <span
          className="fp-pop"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <span className="fp-search">
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              placeholder={requireMonospace ? "Search monospace fonts" : "Search fonts"}
              aria-label="Search fonts"
              onChange={(event) => setQuery(event.target.value)}
            />
          </span>
          <span className="fp-list" role="listbox">
            {showDefault && (
              <span className={`fp-it${value === "" ? " on" : ""}`} role="option" aria-selected={value === ""} onClick={() => choose("")}>
                <span style={{ fontFamily: defaultFace }}>{defaultLabel}</span>
                <span className="fp-def">default</span>
                {value === "" && <Check size={13} aria-hidden="true" />}
              </span>
            )}
            {visible.map((family) => (
              <span key={family} className={`fp-it${family === value ? " on" : ""}`} role="option" aria-selected={family === value} onClick={() => choose(family)}>
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
          Installed · applied
        </span>
      )}
    </span>
  );
}
