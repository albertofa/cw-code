import { describe, expect, it } from "bun:test";
import { labelChipStyle, labelDarkSurface, labelDarkText, labelInk } from "./labelColor.js";

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("labelInk", () => {
  it("picks dark ink on light labels and light ink on dark labels", () => {
    expect(labelInk("#ffffff")).toBe("#000000");
    expect(labelInk("#e4e669")).toBe("#000000");
    expect(labelInk("#000000")).toBe("#ffffff");
    expect(labelInk("#430568")).toBe("#ffffff");
  });

  it("keeps at least 4.5:1 contrast across the color range", () => {
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          expect(contrast(color, labelInk(color))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

function colorRange(): string[] {
  const colors: string[] = [];
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 17) {
      for (let b = 0; b <= 255; b += 17) colors.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    }
  }
  return colors;
}

describe("labelDarkText", () => {
  it("keeps bright labels as they are and lightens dark ones, GitHub-style", () => {
    expect(labelDarkText("#00ff00")).toBe("#00ff00");
    expect(labelDarkText("#ffffff")).toBe("#ffffff");
    const dark = labelDarkText("#430568");
    expect(dark).not.toBe("#430568");
    expect(parseInt(dark.slice(1, 3), 16)).toBeGreaterThan(0x43);
  });

  it("keeps at least 4.5:1 contrast on the tinted dark surface across the color range", () => {
    for (const color of colorRange()) {
      expect(contrast(labelDarkText(color), labelDarkSurface(color))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("labelChipStyle", () => {
  it("sets color, ink and dark text for a known label and nothing otherwise", () => {
    expect(labelChipStyle({ bug: "#430568" }, "bug")).toEqual({
      "--label-color": "#430568",
      "--label-ink": "#ffffff",
      "--label-text": labelDarkText("#430568"),
    } as never);
    expect(labelChipStyle({ bug: "#d73a4a" }, "p1")).toBeUndefined();
    expect(labelChipStyle(undefined, "bug")).toBeUndefined();
    expect(labelChipStyle({ bug: "red" }, "bug")).toBeUndefined();
  });
});
