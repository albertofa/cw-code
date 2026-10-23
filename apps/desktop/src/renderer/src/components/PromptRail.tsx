import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { snippet } from "./threadFind.js";

export interface PromptMark {
  id: string;
  text: string;
}

interface Measured {
  /** 0..1 position of each prompt inside the scrollable content. */
  prompts: Array<{ id: string; text: string; ratio: number; top: number }>;
  matches: number[];
  activeMatch: number | null;
  viewTop: number;
  viewSize: number;
  scrollable: boolean;
}

const EMPTY: Measured = { prompts: [], matches: [], activeMatch: null, viewTop: 0, viewSize: 1, scrollable: false };
const MAX_MATCH_MARKS = 300;

function contentTop(rect: DOMRect, scroll: HTMLElement, box: DOMRect): number {
  return scroll.scrollTop + rect.top - box.top;
}

/**
 * Right-edge rail with one marker per prompt sent in this conversation, so a
 * turn can be found again without scrolling blindly. Find matches ride along.
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
  const [hover, setHover] = useState<{ index: number; top: number; right: number } | null>(null);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const box = scroll.getBoundingClientRect();
    const height = scroll.scrollHeight;
    if (height <= 0) return;
    const marks: Measured["prompts"] = [];
    for (const prompt of prompts) {
      const el = scroll.querySelector<HTMLElement>(`[data-prompt-id="${CSS.escape(prompt.id)}"]`);
      if (!el) continue;
      const top = contentTop(el.getBoundingClientRect(), scroll, box);
      marks.push({ id: prompt.id, text: prompt.text, ratio: Math.min(1, Math.max(0, top / height)), top });
    }
    const matchRatios: number[] = [];
    let activeMatch: number | null = null;
    for (const range of matches.slice(0, MAX_MATCH_MARKS)) {
      const rect = range.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0) continue;
      const ratio = Math.min(1, Math.max(0, contentTop(rect, scroll, box) / height));
      if (range === activeRange) activeMatch = ratio;
      matchRatios.push(ratio);
    }
    setMeasured({
      prompts: marks,
      matches: matchRatios,
      activeMatch,
      viewTop: scroll.scrollTop / height,
      viewSize: Math.min(1, scroll.clientHeight / height),
      scrollable: height - scroll.clientHeight > 40
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

  return (
    <nav className="prompt-rail" aria-label="Prompts in this conversation">
      <span
        className="prompt-rail-view"
        aria-hidden="true"
        style={{ top: `${measured.viewTop * 100}%`, height: `${measured.viewSize * 100}%` }}
      />
      {measured.matches.map((ratio, i) => (
        <span
          key={`m${i}`}
          className={`prompt-rail-match${ratio === measured.activeMatch ? " is-active" : ""}`}
          aria-hidden="true"
          style={{ top: `${ratio * 100}%` }}
        />
      ))}
      {measured.prompts.map((mark, i) => (
        <button
          key={mark.id}
          type="button"
          className="prompt-rail-mark"
          style={{ top: `${mark.ratio * 100}%` }}
          title={`Prompt ${i + 1}`}
          aria-label={`Prompt ${i + 1}: ${snippet(mark.text, 60)}`}
          onClick={() => jump(mark.top, mark.id)}
          onMouseEnter={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHover({ index: i, top: rect.top + rect.height / 2, right: rect.left - 8 });
          }}
          onMouseLeave={() => setHover(null)}
          onFocus={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHover({ index: i, top: rect.top + rect.height / 2, right: rect.left - 8 });
          }}
          onBlur={() => setHover(null)}
        >
          <span className="prompt-rail-bar" aria-hidden="true" />
        </button>
      ))}
      {hover && measured.prompts[hover.index] && (
        <div
          className="prompt-rail-tip"
          role="tooltip"
          style={{ top: Math.min(Math.max(hover.top, 40), window.innerHeight - 40), right: window.innerWidth - hover.right }}
        >
          <span className="prompt-rail-tip-n">Prompt {hover.index + 1}</span>
          <span className="prompt-rail-tip-text">{snippet(measured.prompts[hover.index].text, 160)}</span>
        </div>
      )}
    </nav>
  );
}
