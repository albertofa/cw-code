import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface VirtualRows {
  start: number;
  end: number;
  scrollToIndex: (index: number) => void;
}

export function useVirtualRows(
  containerRef: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  overscan: number,
  topInset = 0,
): VirtualRows {
  const [metrics, setMetrics] = useState({ top: 0, height: 0 });
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const element = containerRef.current;
      if (!element) return;
      const top = element.scrollTop;
      const height = element.clientHeight;
      setMetrics((previous) => (previous.top === top && previous.height === height ? previous : { top, height }));
    });
  }, [containerRef]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [containerRef, measure]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const element = containerRef.current;
      if (!element) return;
      const rowTop = index * rowHeight;
      const rowBottom = rowTop + rowHeight;
      if (rowTop < element.scrollTop) element.scrollTop = rowTop;
      else if (rowBottom + topInset > element.scrollTop + element.clientHeight) {
        element.scrollTop = rowBottom + topInset - element.clientHeight;
      }
    },
    [containerRef, rowHeight, topInset],
  );

  const first = Math.floor(metrics.top / rowHeight);
  const last = Math.ceil((metrics.top + metrics.height - topInset) / rowHeight);
  const start = Math.max(0, Math.min(count, first - overscan));
  const end = Math.max(start, Math.min(count, last + overscan));
  return { start, end, scrollToIndex };
}
