import { useEffect, useRef, type RefObject } from "react";
import { visibleLayerOpen } from "./openLayer.js";

const FOCUS_EVENT = "cw:focus-composer";
const NO_REFOCUS = "aside.right, .bottom-panel, .pty-wrap, .main-tool-body, [contenteditable], input, textarea, select, button, a, [tabindex]";
const PASSIVE_FOCUS = "button, a, summary, [role=\"button\"]";
const KEEPS_KEYS = "aside.right, .question-panel, .bottom-panel, .pty-wrap, .main-tool-body, [role=\"menu\"], [role=\"listbox\"], [role=\"tablist\"], [role=\"tree\"], [role=\"grid\"]";

export function requestComposerFocus(): void {
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

function focusIsFree(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement;
}

/** Focus sits on a clicked button or link, where a typed character would otherwise be lost. */
function focusIsPassive(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.matches(PASSIVE_FOCUS) && active.closest(".app-body") !== null && active.closest(KEEPS_KEYS) === null;
}

function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

function afterLayout(run: () => void): () => void {
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(run);
  });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
}

/**
 * Keeps the visible composer focused: on mount, session switch and when it becomes visible
 * (leaving settings, closing a main tool), on explicit requests, when the input is re-enabled,
 * when the window regains focus, after clicks on non-interactive areas and when the user starts
 * typing with nothing focused. It never takes focus away from another input, an open menu or
 * dialog, or an active text selection.
 */
export function useComposerAutoFocus(ref: RefObject<HTMLTextAreaElement | null>, visible: boolean, disabled: boolean, resetKey: string): void {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const focusNow = (onlyIfFree: boolean): boolean => {
      const el = ref.current;
      if (!el || !visibleRef.current || el.disabled || !document.hasFocus()) return false;
      if (el.getClientRects().length === 0 || visibleLayerOpen()) return false;
      if (onlyIfFree && (!focusIsFree() || hasTextSelection())) return false;
      if (document.activeElement === el) return true;
      try {
        el.focus({ preventScroll: true });
      } catch {
        return false;
      }
      return document.activeElement === el;
    };

    const cancels = new Set<() => void>();
    const schedule = (onlyIfFree: boolean) => {
      const cancel = afterLayout(() => {
        cancels.delete(cancel);
        focusNow(onlyIfFree);
      });
      cancels.add(cancel);
    };

    const onRequest = () => schedule(false);
    const onWindowFocus = () => schedule(true);
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !target.closest(".app-body") || target.closest(NO_REFOCUS)) return;
      schedule(true);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.key.length !== 1 || e.key === " ") return;
      if (!focusIsFree() && !focusIsPassive()) return;
      focusNow(false);
    };

    window.addEventListener(FOCUS_EVENT, onRequest);
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(FOCUS_EVENT, onRequest);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown);
      for (const cancel of cancels) cancel();
    };
  }, [ref]);

  useEffect(() => {
    if (!visible) return;
    return afterLayout(() => {
      const el = ref.current;
      if (!el || el.disabled || visibleLayerOpen()) return;
      try {
        el.focus({ preventScroll: true });
      } catch {
      }
    });
  }, [ref, resetKey, visible]);

  const wasDisabled = useRef(disabled);
  useEffect(() => {
    const reenabled = wasDisabled.current && !disabled;
    wasDisabled.current = disabled;
    if (!reenabled || !visible) return;
    return afterLayout(() => {
      const el = ref.current;
      if (!el || el.disabled || !focusIsFree() || visibleLayerOpen()) return;
      try {
        el.focus({ preventScroll: true });
      } catch {
      }
    });
  }, [ref, disabled, visible]);
}
