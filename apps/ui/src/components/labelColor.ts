import type { CSSProperties } from "react";

function channel(hex: string, offset: number): number {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` color. */
function luminance(color: string): number {
  return 0.2126 * channel(color, 1) + 0.7152 * channel(color, 3) + 0.0722 * channel(color, 5);
}

/** Black or white, whichever contrasts more with `color`; at least ~4.6:1 for any color. */
export function labelInk(color: string): "#000000" | "#ffffff" {
  const l = luminance(color);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#000000" : "#ffffff";
}

/**
 * Inline style that paints a label chip with its GitHub color, GitHub-style: solid fill with black or
 * white ink, so it reads on every theme. Labels without a color keep the neutral chip.
 */
export function labelChipStyle(colors: Record<string, string> | undefined, label: string): CSSProperties | undefined {
  const color = colors?.[label];
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  return { "--label-color": color, "--label-ink": labelInk(color) } as CSSProperties;
}
