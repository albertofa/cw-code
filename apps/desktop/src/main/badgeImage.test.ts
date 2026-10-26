import { describe, expect, it } from "bun:test";
import { badgeLabel, renderBadge } from "./badgeImage.js";

const SIZE = 32;
const FILL = [0x4f, 0xb4, 0xe8, 0xff];
const TEXT = [0x10, 0x1b, 0x20, 0xff];

function pixel(buffer: Buffer, x: number, y: number): number[] {
  const offset = (y * SIZE + x) * 4;
  return [...buffer.subarray(offset, offset + 4)];
}

function countPixels(buffer: Buffer, color: number[]): number {
  let count = 0;
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    if (pixel(buffer, i % SIZE, Math.floor(i / SIZE)).join() === color.join()) count += 1;
  }
  return count;
}

describe("badgeLabel", () => {
  it("shows the count up to nine and 9+ above", () => {
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("9+");
    expect(badgeLabel(250)).toBe("9+");
  });
});

describe("renderBadge", () => {
  it("returns a BGRA buffer of size squared times four bytes", () => {
    expect(renderBadge("3").length).toBe(SIZE * SIZE * 4);
    expect(renderBadge("3", 16).length).toBe(16 * 16 * 4);
  });

  it("fills the center of the circle with the badge color", () => {
    expect(pixel(renderBadge(""), 16, 16)).toEqual(FILL);
  });

  it("fills the circle beside the digit and leaves the corners transparent", () => {
    const badge = renderBadge("1");
    expect(pixel(badge, 4, 16)).toEqual(FILL);
    expect(pixel(badge, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("draws the digit in the dark color", () => {
    expect(countPixels(renderBadge("1"), TEXT)).toBeGreaterThan(0);
  });

  it("renders 9+ differently from 9", () => {
    expect(renderBadge("9+").equals(renderBadge("9"))).toBe(false);
  });

  it("renders every digit differently", () => {
    const rendered = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => renderBadge(digit).toString("base64")));
    expect(rendered.size).toBe(9);
  });
});
