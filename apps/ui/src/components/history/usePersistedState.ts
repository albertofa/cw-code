import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clampWidth } from "./gitGlassLayout.js";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

export function usePersistedChoice<T extends string>(key: string, choices: readonly T[], fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = readStored(key);
    return choices.find((choice) => choice === stored) ?? fallback;
  });
  const update = useCallback(
    (next: T): void => {
      setValue(next);
      writeStored(key, next);
    },
    [key]
  );
  return [value, update];
}

export interface PersistedWidth {
  width: number | null;
  preview: (width: number | null) => void;
  save: (width: number | null) => void;
}

export function usePersistedWidth(key: string, min: number, max: number): PersistedWidth {
  const [width, setWidth] = useState<number | null>(() => {
    const stored = Number(readStored(key));
    return readStored(key) !== null && Number.isFinite(stored) && stored > 0 ? clampWidth(stored, min, max) : null;
  });
  const preview = useCallback((next: number | null): void => setWidth(next === null ? null : clampWidth(next, min, max)), [min, max]);
  const save = useCallback(
    (next: number | null): void => {
      const value = next === null ? null : clampWidth(next, min, max);
      setWidth(value);
      writeStored(key, value === null ? null : String(value));
    },
    [key, min, max]
  );
  return { width, preview, save };
}

export function startWidthDrag(
  event: ReactPointerEvent<HTMLElement>,
  startWidth: number,
  direction: 1 | -1,
  onMove: (width: number) => void,
  onEnd: (width: number) => void
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  const startX = event.clientX;
  let latest = startWidth;
  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent): void => {
    latest = startWidth + (moveEvent.clientX - startX) * direction;
    onMove(latest);
  };
  const stop = (): void => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    if (latest !== startWidth) onEnd(latest);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}
