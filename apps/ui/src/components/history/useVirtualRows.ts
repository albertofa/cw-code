import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { visibleSlots, type SlotLayout } from "./gitGlassLayout.js";

export interface VirtualRows {
  start: number;
  end: number;
  scrollToSlot: (slot: number) => void;
}

export function useVirtualRows(containerRef: RefObject<HTMLElement | null>, layout: SlotLayout, overscan: number, topInset = 0): VirtualRows {
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

  const scrollToSlot = useCallback(
    (index: number) => {
      const element = containerRef.current;
      const slot = layout.slots[index];
      if (!element || !slot) return;
      const slotBottom = slot.top + slot.height;
      if (slot.top < element.scrollTop) element.scrollTop = slot.top;
      else if (slotBottom + topInset > element.scrollTop + element.clientHeight) {
        element.scrollTop = slotBottom + topInset - element.clientHeight;
      }
    },
    [containerRef, layout, topInset]
  );

  const { start, end } = visibleSlots(layout, metrics.top, Math.max(0, metrics.height - topInset), overscan);
  return { start, end, scrollToSlot };
}
