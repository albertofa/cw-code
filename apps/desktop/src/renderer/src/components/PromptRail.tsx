import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { snippet } from "./threadFind.js";

export interface PromptMark {
  id: string;
  text: string;
}

interface Mark {
  id: string;
  text: string;
  /** Offset of the prompt inside the scrollable content, for jumping. */
  top: number;
  /** True while the prompt sits inside the visible scroll window. */
  visible: boolean;
  /** True when a find hit falls inside this prompt's turn. */
  match: boolean;
  /** True when the active find hit falls inside this prompt's turn. */
  activeMatch: boolean;
}

interface Measured {
  prompts: Mark[];
  scrollable: boolean;
}

const EMPTY: Measured = { prompts: [], scrollable: false };
const MAX_MATCH_MARKS = 300;
/** Vertical gap between ticks; keeps a long conversation compact. */
const MARK_SPACING = 10;

function contentTop(rect: DOMRect, scroll: HTMLElement, box: DOMRect): number {
  return scroll.scrollTop + rect.top - box.top;
}

/**
 * Left-edge rail with one compact marker per prompt sent in this conversation,
 * so a turn can be found again without scrolling blindly. The markers stay
 * evenly stacked instead of spreading like a scrollbar; find hits recolour the
 * marker of the turn they belong to.
 */
export function PromptRail({
  scrollRef,
  prompts,
  matches,
  activeRange,
  revision
}: {
  scrollRef: RefObject<HTMLElement | null>;
  prompts: PromptMark[];
  matches: Range[];
  activeRange: Range | null;
  revision: unknown;
}) {
  const [measured, setMeasured] = useState<Measured>(EMPTY);
  const [hover, setHover] = useState<{ index: number; top: number; left: number } | null>(null);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const box = scroll.getBoundingClientRect();
    const viewTop = scroll.scrollTop;
    const viewBottom = viewTop + scroll.clientHeight;
    const marks: Mark[] = [];
    const tops: number[] = [];
    for (const prompt of prompts) {
      const el = scroll.querySelector<HTMLElement>(`[data-prompt-id="${CSS.escape(prompt.id)}"]`);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const top = contentTop(rect, scroll, box);
      tops.push(top);
      marks.push({
        id: prompt.id,
        text: prompt.text,
        top,
        visible: top + rect.height > viewTop && top < viewBottom,
        match: false,
        activeMatch: false
      });
    }
    const matched = new Set<number>();
    let activeMatch: number | null = null;
    for (const range of matches.slice(0, MAX_MATCH_MARKS)) {
      const rect = range.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0) continue;
      const top = contentTop(rect, scroll, box);
      // The tick above a hit is the prompt that opened its turn.
      let owner = 0;
      for (let i = 0; i < tops.length; i += 1) {
        if (tops[i] <= top) owner = i;
        else break;
      }
      matched.add(owner);
      if (range === activeRange) activeMatch = owner;
    }
    for (let i = 0; i < marks.length; i += 1) {
      marks[i].match = matched.has(i);
      marks[i].activeMatch = activeMatch === i;
    }
    setMeasured({
      prompts: marks,
      scrollable: scroll.scrollHeight - scroll.clientHeight > 40
    });
  }, [scrollRef, prompts, matches, activeRange]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    schedule();
    const inner = scroll.firstElementChild;
    const ro = new ResizeObserver(schedule);
    ro.observe(scroll);
    if (inner instanceof HTMLElement) ro.observe(inner);
    scroll.addEventListener("scroll", schedule, { passive: true });
    return () => {
      ro.disconnect();
      scroll.removeEventListener("scroll", schedule);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [scrollRef, schedule, revision]);

  const jump = (top: number, id: string) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTo({ top: Math.max(0, top - 24), behavior: "smooth" });
    const el = scroll.querySelector<HTMLElement>(`[data-prompt-id="${CSS.escape(id)}"] .msg-user`);
    if (!el) return;
    el.classList.remove("is-pinpoint");
    void el.offsetWidth;
    el.classList.add("is-pinpoint");
    window.setTimeout(() => el.classList.remove("is-pinpoint"), 1400);
  };

  if (measured.prompts.length < 2 || !measured.scrollable) return null;

  const count = measured.prompts.length;
  const stackHeight = (count - 1) * MARK_SPACING;

  return (
    <nav className="prompt-rail" aria-label="Prompts in this conversation">
      <div className="prompt-rail-list" style={{ height: `min(${stackHeight}px, 100%)` }}>
        {measured.prompts.map((mark, i) => (
          <button
            key={mark.id}
            type="button"
            className={`prompt-rail-mark${mark.visible ? " is-visible" : ""}${
              mark.match ? " has-match" : ""
            }${mark.activeMatch ? " is-active-match" : ""}`}
            style={{ top: `${(i / (count - 1)) * 100}%` }}
            title={`Prompt ${i + 1}`}
            aria-label={`Prompt ${i + 1}: ${snippet(mark.text, 60)}`}
            onClick={() => jump(mark.top, mark.id)}
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHover({ index: i, top: rect.top + rect.height / 2, left: rect.right + 8 });
            }}
            onMouseLeave={() => setHover(null)}
            onFocus={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHover({ index: i, top: rect.top + rect.height / 2, left: rect.right + 8 });
            }}
            onBlur={() => setHover(null)}
          >
            <span className="prompt-rail-bar" aria-hidden="true" />
          </button>
        ))}
      </div>
      {hover && measured.prompts[hover.index] && (
        <div
          className="prompt-rail-tip"
          role="tooltip"
          style={{
            top: Math.min(Math.max(hover.top, 40), window.innerHeight - 40),
            left: Math.max(8, Math.min(hover.left, window.innerWidth - 328))
          }}
        >
          <span className="prompt-rail-tip-n">Prompt {hover.index + 1}</span>
          <span className="prompt-rail-tip-text">{snippet(measured.prompts[hover.index].text, 160)}</span>
        </div>
      )}
    </nav>
  );
}
