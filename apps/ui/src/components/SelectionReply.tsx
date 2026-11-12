import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Reply } from "lucide-react";
import { useReplyQuotesStore } from "../stores/replyQuotesStore.js";
import { requestComposerFocus } from "./composerFocus.js";
import { cleanQuote } from "./replyQuotes.js";
import { useNotifs } from "./Notifications.js";
import { MAX_DRAFT_QUOTES } from "@cw-code/shared/composerDraftLimits";

const QUOTABLE = ".msg-assistant";
const BUTTON_GAP = 8;
const BUTTON_HEIGHT = 30;

interface Pick {
  text: string;
  top: number;
  left: number;
}

function inQuotable(node: Node | null, root: HTMLElement): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const match = el?.closest(QUOTABLE) ?? null;
  return match !== null && root.contains(match);
}

/** First visible line box of the selection, skipping the empty rects a triple-click leaves at the block edges. */
function anchorRect(range: Range): DOMRect {
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 1 && rect.height > 1) return rect;
  }
  return range.getBoundingClientRect();
}

function readPick(root: HTMLElement): Pick | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  // A triple-click ends the range at the start of the next block, often outside the message, so one
  // end inside an assistant message is enough as long as the whole range stays in the thread.
  if (!root.contains(range.commonAncestorContainer)) return null;
  if (!inQuotable(range.startContainer, root) && !inQuotable(range.endContainer, root)) return null;
  const text = cleanQuote(selection.toString());
  if (text === "") return null;
  const rect = anchorRect(range);
  const bounds = root.getBoundingClientRect();
  if (rect.bottom < bounds.top || rect.top > bounds.bottom) return null;
  const above = rect.top - BUTTON_HEIGHT - BUTTON_GAP;
  return {
    text,
    top: above >= bounds.top ? above : rect.bottom + BUTTON_GAP,
    left: Math.min(Math.max(rect.left + rect.width / 2, bounds.left + 48), bounds.right - 48)
  };
}

/** Floating "Reply" button over text selected in assistant messages; it queues the excerpt as a quote in the composer. */
export function SelectionReply({ sessionId, scrollRef }: { sessionId: string; scrollRef: RefObject<HTMLElement | null> }) {
  const [pick, setPick] = useState<Pick | null>(null);

  useEffect(() => {
    let pointerDown = false;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = scrollRef.current;
        setPick(root && !pointerDown ? readPick(root) : null);
      });
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".selection-reply")) return;
      pointerDown = true;
      setPick(null);
    };
    const onUp = () => {
      pointerDown = false;
      update();
    };
    const root = scrollRef.current;
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", update);
    root?.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", update);
      root?.removeEventListener("scroll", update);
    };
  }, [scrollRef, sessionId]);

  if (!pick) return null;
  return createPortal(
    <button
      type="button"
      className="selection-reply"
      style={{ top: pick.top, left: pick.left }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!useReplyQuotesStore.getState().add(sessionId, pick.text)) {
          useNotifs.getState().push({
            kind: "warning",
            title: "Quote not added",
            message: `A message can carry up to ${MAX_DRAFT_QUOTES} quotes. Remove one to add another.`
          });
          return;
        }
        window.getSelection()?.removeAllRanges();
        setPick(null);
        requestComposerFocus();
      }}
    >
      Reply
      <Reply size={14} aria-hidden="true" />
    </button>,
    document.body
  );
}
