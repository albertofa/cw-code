import type { CSSProperties } from "react";

type Rgb = readonly [number, number, number];

/**
 * The lightest dark surface a label chip sits on: `--raised` of the default dark theme, the background of a
 * hovered inbox row. Text that clears the contrast target here also clears it on the darker `--bg-deep`,
 * `--card` and `--overlay` (hover card); only lighter custom-theme surfaces are approximate.
 */
const DARK_SURFACE: Rgb = [0x26, 0x2a, 0x36];
/** Opacity of the label color in a dark-theme chip's background, as GitHub draws it. */
const DARK_TINT_ALPHA = 0.18;
/** GitHub lightens dark-theme label text by how far its perceived lightness falls below this. */
const DARK_LIGHTNESS_THRESHOLD = 0.6;
const MIN_CONTRAST = 4.5;

function parseHex(color: string): Rgb {
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)) as unknown as Rgb;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function linear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Black or white, whichever contrasts more with `color`; at least ~4.6:1 for any color. */
export function labelInk(color: string): "#000000" | "#ffffff" {
  const l = luminance(parseHex(color));
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#000000" : "#ffffff";
}

/** The dark-theme chip background: `color` at the tint opacity over the dark surface. */
export function labelDarkSurface(color: string): string {
  const rgb = parseHex(color);
  return toHex(rgb.map((v, i) => v * DARK_TINT_ALPHA + DARK_SURFACE[i]! * (1 - DARK_TINT_ALPHA)) as unknown as Rgb);
}

/**
 * Text color of a dark-theme chip, GitHub-style: the label's own hue, lightened by how far its perceived
 * lightness falls below 0.6, then lightened further until it reads at 4.5:1 on the tinted surface.
 */
export function labelDarkText(color: string): string {
  const rgb = parseHex(color);
  const perceived = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
  const [h, s, l] = toHsl(rgb);
  const surface = parseHex(labelDarkSurface(color));
  let lightness = Math.min(1, l + Math.max(0, DARK_LIGHTNESS_THRESHOLD - perceived));
  let text = toHex(fromHsl(h, s, lightness));
  while (contrast(parseHex(text), surface) < MIN_CONTRAST && lightness < 1) {
    lightness = Math.min(1, lightness + 0.02);
    text = toHex(fromHsl(h, s, lightness));
  }
  return text;
}

/**
 * Inline style that paints a label chip with its GitHub color the way GitHub does: a translucent tint
 * with lightened text on dark themes (`--label-text`), a solid fill with black or white ink on light
 * themes (`--label-ink`). Labels without a color keep the neutral chip.
 */
export function labelChipStyle(colors: Record<string, string> | undefined, label: string): CSSProperties | undefined {
  const color = colors?.[label];
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  return { "--label-color": color, "--label-ink": labelInk(color), "--label-text": labelDarkText(color) } as CSSProperties;
}
