import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

export interface ResizableWidthOptions {
  storageKey: string;
  min: number;
  max: number;
  grow: "left" | "right";
}

export interface ResizableWidth {
  width: number | null;
  setWidth(width: number | null): void;
  onResizeStart(e: ReactMouseEvent<HTMLElement>, currentWidth: number): void;
  onResizeKey(e: ReactKeyboardEvent<HTMLElement>, currentWidth: number): void;
}

const KEY_STEP = 16;

export function clampWidth(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function loadWidth(storageKey: string, min: number, max: number): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const n = raw == null ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(n) ? clampWidth(n, min, max) : null;
  } catch {
    return null;
  }
}

function storeWidth(storageKey: string, width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, String(width));
  } catch (err) {
    console.warn(`[layout] could not persist ${storageKey}`, err);
  }
}

export function useResizableWidth({ storageKey, min, max, grow }: ResizableWidthOptions): ResizableWidth {
  const [width, setWidthState] = useState(() => loadWidth(storageKey, min, max));
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const setWidth = (next: number | null) => {
    const value = next === null ? null : clampWidth(next, min, max);
    setWidthState(value);
    storeWidth(storageKey, value);
  };

  const onResizeStart = (e: ReactMouseEvent<HTMLElement>, currentWidth: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const sign = grow === "right" ? 1 : -1;
    const onMove = (ev: MouseEvent) => setWidth(currentWidth + sign * (ev.clientX - startX));
    const stop = () => {
      stopRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.body.classList.remove("resizing");
    };
    stopRef.current = stop;
    document.body.classList.add("resizing");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  const onResizeKey = (e: ReactKeyboardEvent<HTMLElement>, currentWidth: number) => {
    const growKey = grow === "right" ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = grow === "right" ? "ArrowLeft" : "ArrowRight";
    if (e.key === growKey) setWidth(currentWidth + KEY_STEP);
    else if (e.key === shrinkKey) setWidth(currentWidth - KEY_STEP);
    else if (e.key === "Home" || e.key === "Enter") setWidth(null);
    else return;
    e.preventDefault();
  };

  return { width, setWidth, onResizeStart, onResizeKey };
}
