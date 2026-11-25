import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const STORAGE_KEY = "cw-code:history-split";
const WIDE_MIN_WIDTH = 960;
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const DEFAULTS = { narrow: 0.4, wide: 0.5 };

type Ratios = typeof DEFAULTS;

function clampRatio(value: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

function loadRatios(): Ratios {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { narrow, wide } = parsed as Partial<Ratios>;
      return {
        narrow: typeof narrow === "number" ? clampRatio(narrow) : DEFAULTS.narrow,
        wide: typeof wide === "number" ? clampRatio(wide) : DEFAULTS.wide
      };
    }
  } catch {
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS };
}

function saveRatios(ratios: Ratios): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ratios));
  } catch {
    return;
  }
}

export interface HistorySplit {
  containerRef: RefObject<HTMLDivElement | null>;
  wide: boolean;
  ratio: number;
  startDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  reset: () => void;
}

export function useHistorySplit(): HistorySplit {
  const containerRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [ratios, setRatios] = useState(loadRatios);
  const ratiosRef = useRef(ratios);
  ratiosRef.current = ratios;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setWide(element.clientWidth >= WIDE_MIN_WIDTH);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  });

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const element = containerRef.current;
      if (!element || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const key: keyof Ratios = wide ? "wide" : "narrow";
      const move = (moveEvent: PointerEvent) => {
        const rect = element.getBoundingClientRect();
        const ratio = wide ? (moveEvent.clientX - rect.left) / rect.width : (moveEvent.clientY - rect.top) / rect.height;
        if (Number.isFinite(ratio)) setRatios((current) => ({ ...current, [key]: clampRatio(ratio) }));
      };
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        saveRatios(ratiosRef.current);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    },
    [wide]
  );

  const reset = useCallback(() => {
    const key: keyof Ratios = wide ? "wide" : "narrow";
    setRatios((current) => {
      const next = { ...current, [key]: DEFAULTS[key] };
      saveRatios(next);
      return next;
    });
  }, [wide]);

  return { containerRef, wide, ratio: wide ? ratios.wide : ratios.narrow, startDrag, reset };
}
