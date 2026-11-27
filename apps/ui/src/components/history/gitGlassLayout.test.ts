import { describe, expect, it } from "bun:test";
import { buildSlots, clampWidth, slotAtOffset, visibleSlots } from "./gitGlassLayout.js";

describe("buildSlots", () => {
  it("puts a separator before the first commit of each label", () => {
    const layout = buildSlots(["Today", "Today", "Yesterday", "October 2026"], 30, 20);
    expect(layout.slots.map((slot) => (slot.kind === "separator" ? slot.label : slot.index))).toEqual([
      "Today",
      0,
      1,
      "Yesterday",
      2,
      "October 2026",
      3
    ]);
  });

  it("leaves unlabelled rows, like uncommitted changes, without a separator", () => {
    const layout = buildSlots([null, "Today", "Today"], 30, 20);
    expect(layout.slots.map((slot) => slot.kind)).toEqual(["commit", "separator", "commit", "commit"]);
    expect(layout.slots[1]).toEqual({ kind: "separator", label: "Today", before: 1, top: 30, height: 20 });
  });

  it("stacks offsets and maps each commit to its slot", () => {
    const layout = buildSlots(["Today", "Today", "Yesterday"], 30, 20);
    expect(layout.slots.map((slot) => slot.top)).toEqual([0, 20, 50, 80, 100]);
    expect(layout.slotOfIndex).toEqual([1, 2, 4]);
    expect(layout.total).toBe(130);
  });

  it("handles an empty list", () => {
    expect(buildSlots([], 30, 20)).toEqual({ slots: [], slotOfIndex: [], total: 0 });
  });
});

describe("slotAtOffset", () => {
  const layout = buildSlots(["Today", "Today", "Yesterday"], 30, 20);

  it("finds the slot covering an offset", () => {
    expect(slotAtOffset(layout, 0)).toBe(0);
    expect(slotAtOffset(layout, 19)).toBe(0);
    expect(slotAtOffset(layout, 20)).toBe(1);
    expect(slotAtOffset(layout, 79)).toBe(2);
    expect(slotAtOffset(layout, 80)).toBe(3);
  });

  it("clamps offsets past the ends", () => {
    expect(slotAtOffset(layout, -5)).toBe(0);
    expect(slotAtOffset(layout, 1000)).toBe(4);
    expect(slotAtOffset(buildSlots([], 30, 20), 10)).toBe(-1);
  });
});

describe("visibleSlots", () => {
  const layout = buildSlots(Array.from({ length: 100 }, () => "Today"), 30, 20);

  it("covers the viewport plus overscan", () => {
    expect(visibleSlots(layout, 0, 100, 2)).toEqual({ start: 0, end: 6 });
    expect(visibleSlots(layout, 320, 60, 1)).toEqual({ start: 10, end: 15 });
  });

  it("includes separators sitting on the viewport edges", () => {
    const days = buildSlots(["Today", "Yesterday", "Yesterday", "Last week", "October 2026"], 30, 20);
    expect(days.slots.map((slot) => slot.top)).toEqual([0, 20, 50, 70, 100, 130, 150, 180, 200]);
    expect(visibleSlots(days, 50, 80, 0)).toEqual({ start: 2, end: 6 });
    expect(visibleSlots(days, 51, 79, 0)).toEqual({ start: 2, end: 6 });
    expect(visibleSlots(days, 130, 50, 0)).toEqual({ start: 5, end: 8 });
  });

  it("stays inside the list", () => {
    expect(visibleSlots(layout, 5000, 300, 5)).toEqual({ start: 95, end: 101 });
    expect(visibleSlots(buildSlots([], 30, 20), 0, 300, 5)).toEqual({ start: 0, end: 0 });
  });
});

describe("clampWidth", () => {
  it("keeps widths inside the bounds", () => {
    expect(clampWidth(100, 180, 420)).toBe(180);
    expect(clampWidth(500.4, 180, 420)).toBe(420);
    expect(clampWidth(250.6, 180, 420)).toBe(251);
  });
});
