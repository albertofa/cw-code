import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME_PALETTES } from "../../shared/themes.js";

const NAMED_COLORS = [
  "aqua",
  "beige",
  "black",
  "blue",
  "brown",
  "crimson",
  "cyan",
  "fuchsia",
  "gold",
  "gray",
  "green",
  "grey",
  "indigo",
  "ivory",
  "lime",
  "magenta",
  "maroon",
  "navy",
  "olive",
  "orange",
  "pink",
  "purple",
  "red",
  "salmon",
  "silver",
  "teal",
  "tomato",
  "violet",
  "white",
  "yellow"
];
const COLOR_FUNCTION_LITERAL = /#[0-9a-f]{3,8}\b|(?<![\w-])(?:rgba?|hsla?|oklch)\(/i;
const NAMED_COLOR_LITERAL = new RegExp(`(?<![\\w-])(?:${NAMED_COLORS.join("|")})(?![\\w-])`, "i");
const MASK_PROPERTY = /^(?:-webkit-)?mask(?:-image)?$/;
const ALLOWED_COLOR_MIX_ANCHOR = /color-mix\(in srgb, var\(--[\w-]+\) [\d.]+%, (?:black|white)\)/g;
const DECLARATION = /([\w-]+)\s*:\s*((?:"[^"]*"|'[^']*'|[^;{}"'])+);/g;
const ROOT_SELECTOR = ":root {";
const LIGHT_SELECTOR = ':root[data-theme="light"] {';
const SCANNED_STYLESHEETS = [
  "./components/appearance.css",
  "./components/prInbox.css",
  "./components/modelPicker.css",
  "./components/toolRail.css"
];

function readStylesheet(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const CSS = readStylesheet("./theme.css");

interface Block {
  start: number;
  end: number;
  tokens: Record<string, string>;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hasColorLiteral(property: string, value: string): boolean {
  if (COLOR_FUNCTION_LITERAL.test(value)) {
    return true;
  }
  return !MASK_PROPERTY.test(property) && NAMED_COLOR_LITERAL.test(value.replace(ALLOWED_COLOR_MIX_ANCHOR, ""));
}

function colorLiteralDeclarations(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(DECLARATION)]
    .map(([, property, value]) => [property, normalize(value)])
    .filter(([property, value]) => hasColorLiteral(property, value))
    .map(([property, value]) => `${property}: ${value}`);
}

function readBlock(selector: string): Block {
  const start = CSS.indexOf(selector);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const end = CSS.indexOf("}", start);
  const body = CSS.slice(start + selector.length, end);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = normalize(match[2]);
  }
  return { start, end, tokens };
}

function colorTokens(tokens: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).filter(([token, value]) => hasColorLiteral(`--${token}`, value)));
}

function normalizedPalette(palette: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(palette).map(([token, value]) => [token, normalize(value)]));
}

describe("theme.css palettes", () => {
  it("declares exactly the dark palette as the :root color tokens", () => {
    expect(colorTokens(readBlock(ROOT_SELECTOR).tokens)).toEqual(normalizedPalette(THEME_PALETTES.dark));
  });

  it("declares exactly the light palette in the light block", () => {
    expect(readBlock(LIGHT_SELECTOR).tokens).toEqual(normalizedPalette(THEME_PALETTES.light));
  });

  it("keeps every palette in sync on token names", () => {
    expect(Object.keys(THEME_PALETTES.light).sort()).toEqual(Object.keys(THEME_PALETTES.dark).sort());
  });

  it("has no color literals outside the palette blocks", () => {
    const root = readBlock(ROOT_SELECTOR);
    const light = readBlock(LIGHT_SELECTOR);
    const outside = [CSS.slice(0, root.start), CSS.slice(root.end + 1, light.start), CSS.slice(light.end + 1)].join("\n");
    expect(colorLiteralDeclarations(outside)).toEqual([]);
  });

  it("has no color literals in the component stylesheets", () => {
    for (const path of SCANNED_STYLESHEETS) {
      expect(colorLiteralDeclarations(readStylesheet(path)), path).toEqual([]);
    }
  });

  it("flags hex, functional and named colors but not the allowlisted uses", () => {
    expect(
      colorLiteralDeclarations(
        [
          "a { color: #fff; }",
          "b { color: hsl(0 0% 0%); }",
          "c { color: oklch(0.5 0.1 200); }",
          "d { border: 1px solid white; }",
          "e { background: color-mix(in srgb, var(--violet) 50%, red); }",
          "f { color: transparent; background: currentColor; fill: inherit; white-space: nowrap; }",
          "g { background: color-mix(in srgb, var(--violet) 88%, white); }",
          "h { mask-image: linear-gradient(to right, transparent, black 8px); }",
          "i { mask: url(\"data:image/svg+xml,%3Csvg stroke='black'%3E\") center / contain; }"
        ].join("\n")
      )
    ).toEqual([
      "color: #fff",
      "color: hsl(0 0% 0%)",
      "color: oklch(0.5 0.1 200)",
      "border: 1px solid white",
      "background: color-mix(in srgb, var(--violet) 50%, red)"
    ]);
  });
});
