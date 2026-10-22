import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildTextIndex, findMatches, rangeForSpan } from "./threadFind.js";

const HIGHLIGHT_ALL = "cw-find";
const HIGHLIGHT_ACTIVE = "cw-find-active";
const INDEX_DEBOUNCE_MS = 140;
const MAX_MATCHES = 2000;

interface HighlightLike {
  readonly size?: number;
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}

function registry(): HighlightRegistryLike | undefined {
  return (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
}

function highlightCtor(): HighlightCtor | undefined {
  return (globalThis as { Highlight?: HighlightCtor }).Highlight;
}

function paint(name: string, ranges: Range[]): void {
  const api = registry();
  const Ctor = highlightCtor();
  if (!api || !Ctor) return;
  if (ranges.length === 0) api.delete(name);
  else api.set(name, new Ctor(...ranges));
}

function clearPaint(): void {
  const api = registry();
  if (!api) return;
  api.delete(HIGHLIGHT_ALL);
  api.delete(HIGHLIGHT_ACTIVE);
}

/** Opens any collapsed turn that hides the match, so navigation never lands on nothing. */
function revealRange(range: Range): boolean {
  const start = range.startContainer;
  let el: HTMLElement | null = start instanceof HTMLElement ? start : start.parentElement;
  let expanded = false;
  for (; el; el = el.parentElement) {
    if (!el.hidden || !el.classList.contains("turn-fold")) continue;
    const head = el.closest(".turn-block")?.querySelector<HTMLButtonElement>(".turn-head");
    if (head && !head.disabled) {
      head.click();
      expanded = true;
    }
  }
  return expanded;
}

export interface ThreadFind {
  open: boolean;
  query: string;
  setQuery(value: string): void;
  total: number;
  /** 1-based position of the active match, 0 when there is none. */
  position: number;
  ranges: Range[];
  activeRange: Range | null;
  next(): void;
  prev(): void;
  openFind(): void;
  close(): void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * Find-in-conversation over the rendered thread. Matches are painted with the
 * CSS Custom Highlight API, so the markdown DOM is never rewritten.
 */
export function useThreadFind({
  scrollRef,
  contentRef,
  enabled,
  revision
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  revision: unknown;
}): ThreadFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rangesRef = useRef<Range[]>([]);
  rangesRef.current = ranges;

  // Re-index whenever the query, the thread content, or the open state changes.
  useEffect(() => {
    if (!open || query.trim().length === 0) {
      setRanges([]);
      clearPaint();
      return;
    }
    const timer = window.setTimeout(() => {
      const root = contentRef.current;
      if (!root) return;
      const index = buildTextIndex(root);
      const spans = findMatches(index.text, query).slice(0, MAX_MATCHES);
      const found: Range[] = [];
      for (const span of spans) {
        const range = rangeForSpan(index, span);
        if (range) found.push(range);
      }
      setRanges(found);
      paint(HIGHLIGHT_ALL, found);
      setActive((current) => (found.length === 0 ? 0 : Math.min(current, found.length - 1)));
      if (found.length === 0) paint(HIGHLIGHT_ACTIVE, []);
    }, INDEX_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, revision, contentRef]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => () => clearPaint(), []);

  useEffect(() => {
    if (!enabled && open) {
      setOpen(false);
      clearPaint();
    }
  }, [enabled, open]);

  const activeRange = ranges[active] ?? null;

  // Paint and reveal the active match.
  useEffect(() => {
    if (!activeRange) {
      paint(HIGHLIGHT_ACTIVE, []);
      return;
    }
    paint(HIGHLIGHT_ACTIVE, [activeRange]);
    const scroll = scrollRef.current;
    if (!scroll) return;
    const expanded = revealRange(activeRange);
    const run = () => {
      const rect = activeRange.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0) return;
      const box = scroll.getBoundingClientRect();
      const top = scroll.scrollTop + rect.top - box.top - scroll.clientHeight / 3;
      scroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    };
    if (!expanded) {
      run();
      return;
    }
    const raf = requestAnimationFrame(() => requestAnimationFrame(run));
    return () => cancelAnimationFrame(raf);
  }, [activeRange, scrollRef]);

  const step = useCallback((delta: number) => {
    const count = rangesRef.current.length;
    if (count === 0) return;
    setActive((current) => (current + delta + count) % count);
  }, []);

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  const openFind = useCallback(() => {
    // Start from whatever the user has selected, like a browser's find bar.
    const selection = window.getSelection();
    const selected = selection && !selection.isCollapsed ? selection.toString().trim() : "";
    if (selected.length > 0 && selected.length <= 120 && !selected.includes("\n")) setQuery(selected);
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setRanges([]);
    setActive(0);
    clearPaint();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Terminals and the code editor keep their own find.
      if (target?.closest?.(".pty-wrap, .monaco-editor")) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "f" && !e.shiftKey) {
        e.preventDefault();
        openFind();
        return;
      }
      if (e.key === "F3" || ((e.ctrlKey || e.metaKey) && key === "g")) {
        e.preventDefault();
        if (!open) openFind();
        else if (e.shiftKey) prev();
        else next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, open, openFind, next, prev]);

  return useMemo(
    () => ({
      open,
      query,
      setQuery,
      total: ranges.length,
      position: ranges.length === 0 ? 0 : active + 1,
      ranges,
      activeRange,
      next,
      prev,
      openFind,
      close,
      inputRef
    }),
    [open, query, ranges, active, activeRange, next, prev, openFind, close]
  );
}
