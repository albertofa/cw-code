import type { AppSettings } from "./cw.js";

export type AppearancePrefs = Pick<
  AppSettings,
  | "fontFamilySans"
  | "fontFamilyMono"
  | "fontFamilyPrompt"
  | "fontFamilyTerminal"
  | "fontSizeInterface"
  | "fontSizeCode"
  | "fontSizePrompt"
  | "fontSizeTerminal"
  | "typographyAdvanced"
>;

export const DEFAULT_SANS_STACK = '"Segoe UI", system-ui, sans-serif';
export const DEFAULT_MONO_PRIMARY = '"JetBrains Mono Variable", "JetBrains Mono"';
export const DEFAULT_MONO_REST = '"Cascadia Code", Consolas, monospace';
export const DEFAULT_MONO_STACK = `${DEFAULT_MONO_PRIMARY}, ${DEFAULT_MONO_REST}`;
export const TERMINAL_GLYPH_FALLBACK = '"Symbols Nerd Font Mono", "CaskaydiaCove Nerd Font", "JetBrainsMono Nerd Font"';

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  fontFamilySans: "",
  fontFamilyMono: "",
  fontFamilyPrompt: "",
  fontFamilyTerminal: "",
  fontSizeInterface: 16,
  fontSizeCode: 14,
  fontSizePrompt: 14,
  fontSizeTerminal: 14,
  typographyAdvanced: false
};

export const FONT_SIZE_LIMITS = {
  fontSizeInterface: { min: 12, max: 20 },
  fontSizeCode: { min: 10, max: 18 },
  fontSizePrompt: { min: 12, max: 20 },
  fontSizeTerminal: { min: 8, max: 20 }
} as const;

export function appearanceOf(settings: AppearancePrefs): AppearancePrefs {
  return {
    fontFamilySans: settings.fontFamilySans,
    fontFamilyMono: settings.fontFamilyMono,
    fontFamilyPrompt: settings.fontFamilyPrompt,
    fontFamilyTerminal: settings.fontFamilyTerminal,
    fontSizeInterface: settings.fontSizeInterface,
    fontSizeCode: settings.fontSizeCode,
    fontSizePrompt: settings.fontSizePrompt,
    fontSizeTerminal: settings.fontSizeTerminal,
    typographyAdvanced: settings.typographyAdvanced
  };
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded"
]);

function familyNames(input: string): string[] {
  const tokens = input.match(/"[^"]*"|'[^']*'|[^,]+/g) ?? [];
  return tokens
    .map((token) => token.trim().replace(/^(["'])(.*)\1$/, "$2").trim())
    .filter((name) => name !== "");
}

export function cssFontFamilies(input: string): string | null {
  const names = familyNames(input);
  if (names.length === 0) return null;
  return names
    .map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : `"${name.replace(/["\\]/g, "\\$&")}"`))
    .join(", ");
}

export function fontStack(custom: string, fallback: string): string {
  const list = cssFontFamilies(custom);
  return list ? `${list}, ${fallback}` : fallback;
}

export function resolveTerminalFont(p: AppearancePrefs): { family: string; size: number } {
  const chosen = p.typographyAdvanced && p.fontFamilyTerminal ? p.fontFamilyTerminal : p.fontFamilyMono;
  const custom = cssFontFamilies(chosen);
  const family = custom
    ? `${custom}, ${TERMINAL_GLYPH_FALLBACK}, ${DEFAULT_MONO_STACK}`
    : `${DEFAULT_MONO_PRIMARY}, ${TERMINAL_GLYPH_FALLBACK}, ${DEFAULT_MONO_REST}`;
  return {
    family,
    size: p.typographyAdvanced ? p.fontSizeTerminal : p.fontSizeCode
  };
}

function setOrRemove(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.style.removeProperty(name);
  else root.style.setProperty(name, value);
}

export function applyAppearance(root: HTMLElement, p: AppearancePrefs): void {
  const advanced = p.typographyAdvanced;
  const sans = cssFontFamilies(p.fontFamilySans);
  const mono = cssFontFamilies(p.fontFamilyMono);
  const prompt = advanced ? cssFontFamilies(p.fontFamilyPrompt) : null;
  const terminal = advanced ? cssFontFamilies(p.fontFamilyTerminal) : null;
  root.style.fontSize = `${p.fontSizeInterface}px`;
  setOrRemove(root, "--font-sans", sans && `${sans}, ${DEFAULT_SANS_STACK}`);
  setOrRemove(root, "--font-mono", mono && `${mono}, ${DEFAULT_MONO_STACK}`);
  setOrRemove(root, "--font-prompt", prompt && `${prompt}, var(--sans)`);
  setOrRemove(root, "--font-term", terminal && `${terminal}, var(--mono)`);
  root.style.setProperty("--font-size-code", `${p.fontSizeCode}px`);
  root.style.setProperty("--font-size-prompt", `${advanced ? p.fontSizePrompt : DEFAULT_APPEARANCE.fontSizePrompt}px`);
  root.style.setProperty("--font-size-term", `${advanced ? p.fontSizeTerminal : p.fontSizeCode}px`);
}

const PROBE_TEXT = "mmmmmmmmmmlli";
const PROBE_SIZE = 72;
const PROBE_BASELINES = ["monospace", "serif", "sans-serif"];
const MONOSPACE_PROBE_TEXT = "iMW0@#. ";
const WIDTH_EPSILON = 0.01;

let measureContext: CanvasRenderingContext2D | null | undefined;

function measure(font: string, text: string): number | null {
  if (measureContext === undefined) measureContext = document.createElement("canvas").getContext("2d");
  if (!measureContext) return null;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

function isNameAvailable(name: string): boolean {
  if (GENERIC_FAMILIES.has(name.toLowerCase())) return true;
  const quoted = `"${name.replace(/["\\]/g, "\\$&")}"`;
  return PROBE_BASELINES.some((baseline) => {
    const withFamily = measure(`${PROBE_SIZE}px ${quoted}, ${baseline}`, PROBE_TEXT);
    const withoutFamily = measure(`${PROBE_SIZE}px ${baseline}`, PROBE_TEXT);
    return withFamily !== null && withoutFamily !== null && Math.abs(withFamily - withoutFamily) > WIDTH_EPSILON;
  });
}

export function isFontFamilyAvailable(family: string): boolean {
  const names = familyNames(family);
  return names.length > 0 && names.every(isNameAvailable);
}

export function isMonospaceFamily(family: string): boolean {
  const list = cssFontFamilies(family);
  if (!list) return false;
  const widths = [...MONOSPACE_PROBE_TEXT].map((char) => measure(`16px ${list}, sans-serif`, char));
  const first = widths[0];
  return first !== null && first !== undefined && widths.every((width) => width !== null && Math.abs(width - first) < WIDTH_EPSILON);
}

export interface LocalFontData {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly style: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}
