import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const STORAGE_KEY = "cw-code:history-side-height";
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
const MIN_GRAPH_HEIGHT = 120;

function clampHeight(value: number, max = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.max(MIN_HEIGHT, Math.min(max, value)));
}

function loadHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampHeight(stored) : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function saveHeight(height: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(height));
  } catch {
    return;
  }
}

export function useHistorySide(): {
  height: number;
  startDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  reset: () => void;
} {
  const [height, setHeight] = useState(loadHeight);
  const heightRef = useRef(height);
  heightRef.current = height;

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const container = handle.parentElement;
    if (!container) return;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const next = rect.bottom - moveEvent.clientY;
      if (Number.isFinite(next)) setHeight(clampHeight(next, rect.height - MIN_GRAPH_HEIGHT));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      saveHeight(heightRef.current);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }, []);

  const reset = useCallback(() => {
    setHeight(DEFAULT_HEIGHT);
    saveHeight(DEFAULT_HEIGHT);
  }, []);

  return { height, startDrag, reset };
}
