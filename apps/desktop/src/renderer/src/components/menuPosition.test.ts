import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "./menuPosition.js";

const viewport = { viewportWidth: 1200, viewportHeight: 800, margin: 8 };

describe("clampMenuPosition", () => {
  it("keeps the menu where it was opened when it fits", () => {
    const { left, top } = clampMenuPosition({ x: 300, y: 200, width: 180, height: 220, ...viewport });
    expect(left).toBe(300);
    expect(top).toBe(200);
  });

  it("flips above the pointer when the menu would overflow the bottom", () => {
    const { top } = clampMenuPosition({ x: 300, y: 700, width: 180, height: 220, ...viewport });
    expect(top).toBe(480);
    expect(top + 220).toBeLessThanOrEqual(viewport.viewportHeight - viewport.margin);
  });

  it("clamps to the right edge", () => {
    const { left } = clampMenuPosition({ x: 1150, y: 100, width: 180, height: 120, ...viewport });
    expect(left).toBe(1012);
  });

  it("clamps to the left edge for negative anchors", () => {
    const { left } = clampMenuPosition({ x: -40, y: 100, width: 180, height: 120, ...viewport });
    expect(left).toBe(8);
  });

  it("caps the height and uses the roomier side when the menu fits nowhere", () => {
    const placement = clampMenuPosition({ x: 300, y: 600, width: 180, height: 900, ...viewport });
    expect(placement.top).toBe(8);
    expect(placement.maxHeight).toBe(592);
  });

  it("never exceeds the viewport height", () => {
    const placement = clampMenuPosition({ x: 10, y: 10, width: 180, height: 2000, ...viewport });
    expect(placement.maxHeight).toBeLessThanOrEqual(viewport.viewportHeight - viewport.margin * 2);
  });
});
