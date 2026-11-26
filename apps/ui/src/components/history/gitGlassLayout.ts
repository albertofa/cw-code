export const NARROW_WIDTH = 900;
export const ROW_HEIGHT = 32;
export const SEPARATOR_HEIGHT = 26;

export type Slot =
  | { kind: "commit"; index: number; top: number; height: number }
  | { kind: "separator"; label: string; before: number; top: number; height: number };

export interface SlotLayout {
  slots: Slot[];
  slotOfIndex: number[];
  total: number;
}

export interface SlotRange {
  start: number;
  end: number;
}

export function buildSlots(labels: readonly (string | null)[], rowHeight: number, separatorHeight: number): SlotLayout {
  const slots: Slot[] = [];
  const slotOfIndex: number[] = [];
  let top = 0;
  let previous: string | null = null;
  labels.forEach((label, index) => {
    if (label !== null && label !== previous) {
      slots.push({ kind: "separator", label, before: index, top, height: separatorHeight });
      top += separatorHeight;
      previous = label;
    }
    slotOfIndex.push(slots.length);
    slots.push({ kind: "commit", index, top, height: rowHeight });
    top += rowHeight;
  });
  return { slots, slotOfIndex, total: top };
}

export function slotAtOffset(layout: SlotLayout, offset: number): number {
  const { slots } = layout;
  if (slots.length === 0) return -1;
  let low = 0;
  let high = slots.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((slots[mid]?.top ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function visibleSlots(layout: SlotLayout, scrollTop: number, viewport: number, overscan: number): SlotRange {
  const count = layout.slots.length;
  if (count === 0) return { start: 0, end: 0 };
  const first = slotAtOffset(layout, Math.max(0, scrollTop));
  const last = slotAtOffset(layout, Math.max(0, scrollTop + viewport));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + 1 + overscan);
  return { start, end: Math.max(start, end) };
}

export function clampWidth(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}
