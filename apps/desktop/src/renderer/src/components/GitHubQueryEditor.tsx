import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { GitHubKind } from "../cw.js";
import { GitHubAvatar } from "./GitHubAvatar.js";
import { NamedIcon, valueIconName } from "./GitHubIcon.js";
import { qualifiersFor, queryProblems, tokenize } from "@cw-code/shared/githubQueryDsl";
import { applyAutocomplete, autocomplete, type AutocompleteItem, type SuggestionSource } from "./githubAutocomplete.js";
import { KIND_NOUNS, retargetQuery } from "./githubViewModel.js";

const AC_WIDTH_FALLBACK = 320;
const AC_EDGE_MARGIN = 8;
const AC_CARET_OFFSET = 8;
const AC_TOP_GAP = 4;
const NAVIGATION_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

let measureContext: CanvasRenderingContext2D | null = null;

function textWidth(input: HTMLInputElement, text: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return 0;
  measureContext.font = getComputedStyle(input).font;
  return measureContext.measureText(text).width;
}

function QueryHighlight({ kind, query }: { kind: GitHubKind; query: string }) {
  const defs = qualifiersFor(kind);
  return (
    <>
      {tokenize(query).map((token) => {
        if (token.kind === "space") return <Fragment key={token.start}>{token.text}</Fragment>;
        if (token.kind === "text") return <span key={token.start}>{token.text}</span>;
        const def = defs.find((candidate) => candidate.key === token.key);
        const keyBad = !def;
        const valueBad = !keyBad && queryProblems(kind, token.text).length > 0;
        const local = !!def?.local || (token.key === "is" && (token.value ?? "").toLowerCase() === "unread");
        const isMe = (token.value ?? "").toLowerCase() === "@me";
        const className = ["q-tok", local ? "q-local" : "", keyBad ? "q-bad" : ""].filter(Boolean).join(" ");
        return (
          <span key={token.start} className={className}>
            {token.neg && <span className="q-neg">-</span>}
            <span className="q-key">{token.rawKey}:</span>
            <span className={`q-val${valueBad ? " q-bad" : ""}`}>{isMe ? <span className="q-me">{token.rawValue}</span> : token.rawValue}</span>
          </span>
        );
      })}
    </>
  );
}

function SuggestionLead({ item }: { item: AutocompleteItem }) {
  if (item.avatarLogin) return <GitHubAvatar login={item.avatarLogin} small />;
  if (item.labelColor) return <span className="hub-dot" style={{ background: item.labelColor }} />;
  const icon = valueIconName(item.key, item.value ?? "");
  return icon ? <NamedIcon name={icon} size={14} /> : <span className="hub-ac-lead-spacer" />;
}

function Suggestion({ item, id, active, onPick }: { item: AutocompleteItem; id: string; active: boolean; onPick: () => void }) {
  const className = `hub-ac-item${active ? " active" : ""}`;
  const optionProps = { id, role: "option", "aria-selected": active, tabIndex: -1 } as const;
  if (item.kind === "key") {
    return (
      <button type="button" className={className} onClick={onPick} {...optionProps}>
        <span className="k">{item.label}</span>
        {item.local && <span className="hub-ac-tag">cw</span>}
        <span className="hub-ac-desc">{item.description}</span>
      </button>
    );
  }
  if (item.kind === "exclude") {
    return (
      <button type="button" className={className} onClick={onPick} {...optionProps}>
        <NamedIcon name="CircleMinus" size={14} />
        <span className="lbl">{item.label}</span>
      </button>
    );
  }
  return (
    <button type="button" className={className} onClick={onPick} {...optionProps}>
      <SuggestionLead item={item} />
      <span className="lbl">{item.label}</span>
      {item.local && <span className="hub-ac-tag">cw</span>}
      {item.description && <span className="hub-ac-desc">{item.description}</span>}
    </button>
  );
}

export function GitHubQueryEditor({
  kind,
  query,
  source,
  inputRef,
  onChange
}: {
  kind: GitHubKind;
  query: string;
  source: SuggestionSource;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (query: string) => void;
}) {
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [caret, setCaret] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const result = useMemo(() => (open ? autocomplete(kind, query, caret, source) : null), [open, kind, query, caret, source]);
  const items = result?.items ?? [];
  const visible = result !== null && (items.length > 0 || !!result.empty);
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));

  const syncScroll = () => {
    const input = inputRef.current;
    const highlight = highlightRef.current;
    if (input && highlight) highlight.style.transform = `translateX(${-input.scrollLeft}px)`;
  };

  const syncCaret = () => {
    const input = inputRef.current;
    if (input) setCaret(input.selectionStart ?? input.value.length);
  };

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && pendingCaret.current !== null) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    syncScroll();
  });

  const tokenStart = result?.tokenStart ?? 0;
  const reposition = useCallback(() => {
    const input = inputRef.current;
    const wrap = wrapRef.current;
    if (!input || !wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const barRect = wrap.closest(".hub-search")?.getBoundingClientRect() ?? wrapRect;
    const width = panelRef.current?.offsetWidth ?? AC_WIDTH_FALLBACK;
    const x = wrapRect.left + textWidth(input, query.slice(0, tokenStart)) - input.scrollLeft - AC_CARET_OFFSET;
    const left = Math.max(AC_EDGE_MARGIN, Math.min(x, window.innerWidth - width - AC_EDGE_MARGIN));
    const top = barRect.bottom + AC_TOP_GAP;
    setPosition((previous) => (previous && previous.left === left && previous.top === top ? previous : { left, top }));
  }, [inputRef, query, tokenStart]);

  useLayoutEffect(() => {
    if (visible) reposition();
  }, [visible, reposition, items.length]);

  useEffect(() => {
    if (!visible) return;
    window.addEventListener("resize", reposition);
    const panel = panelRef.current;
    const observer = panel && typeof ResizeObserver !== "undefined" ? new ResizeObserver(reposition) : null;
    if (panel) observer?.observe(panel);
    return () => {
      window.removeEventListener("resize", reposition);
      observer?.disconnect();
    };
  }, [visible, reposition]);

  useEffect(() => {
    if (visible) panelRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [visible, activeIndex, items.length]);

  const accept = (index: number) => {
    const item = items[index];
    if (!item || !result) return;
    const applied = applyAutocomplete(query, result, item, kind);
    const nextQuery = applied.switchKind ? retargetQuery(applied.query, applied.switchKind) : applied.query;
    const nextCaret = applied.switchKind ? nextQuery.length : applied.caret;
    pendingCaret.current = nextCaret;
    setCaret(nextCaret);
    setActive(0);
    setOpen(applied.reopen);
    onChange(nextQuery);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (visible) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      setOpen(false);
      event.currentTarget.blur();
      return;
    }
    const tokenIsEmpty = result !== null && result.tokenStart === result.tokenEnd;
    if (visible && items.length > 0 && !(event.key === "Tab" && tokenIsEmpty)) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((activeIndex + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((activeIndex - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        accept(activeIndex);
        return;
      }
    }
    if (event.key === "Enter") {
      setOpen(false);
      event.currentTarget.blur();
      return;
    }
    requestAnimationFrame(syncScroll);
  };

  return (
    <div className="hub-q-wrap" ref={wrapRef} onClick={() => inputRef.current?.focus()}>
      <div className="hub-q-hl" ref={highlightRef} aria-hidden="true">
        <QueryHighlight kind={kind} query={query} />
      </div>
      <input
        ref={inputRef}
        className="hub-q-input"
        value={query}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-label="Search query"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={visible}
        aria-activedescendant={visible && items.length > 0 ? optionId(activeIndex) : undefined}
        placeholder={`Search ${KIND_NOUNS[kind]} — try author:@me or repo:`}
        onChange={(event) => {
          setActive(0);
          setOpen(true);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          onChange(event.target.value);
        }}
        onFocus={() => {
          syncCaret();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onClick={() => {
          syncScroll();
          syncCaret();
          setOpen(true);
        }}
        onScroll={syncScroll}
        onKeyUp={(event) => {
          if (!NAVIGATION_KEYS.has(event.key)) return;
          syncScroll();
          syncCaret();
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {visible &&
        result &&
        createPortal(
          <div
            ref={panelRef}
            id={listId}
            role="listbox"
            aria-label="Query suggestions"
            className="hub-ac"
            style={position ?? { left: 0, top: 0, visibility: "hidden" }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {result.heading && <div className="hub-ac-head">{result.heading}</div>}
            {items.map((item, index) => (
              <Suggestion
                key={`${item.kind}:${item.neg ? "-" : ""}${item.key}:${item.value ?? ""}`}
                item={item}
                id={optionId(index)}
                active={index === activeIndex}
                onPick={() => accept(index)}
              />
            ))}
            {items.length === 0 && result.empty && <div className={`hub-ac-empty${result.invalid ? " bad" : ""}`}>{result.empty}</div>}
            <div className="hub-ac-foot">
              <span>
                <kbd>↑↓</kbd> navigate
              </span>
              <span>
                <kbd>Tab</kbd> complete
              </span>
              <span>
                <kbd>Esc</kbd> close
              </span>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
