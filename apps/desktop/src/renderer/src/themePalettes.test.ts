import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME_PALETTES } from "../../shared/themes.js";

const CSS = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(/i;
const ROOT_SELECTOR = ":root {";
const LIGHT_SELECTOR = ':root[data-theme="light"] {';

interface Block {
  start: number;
  end: number;
  tokens: Record<string, string>;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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
  return Object.fromEntries(Object.entries(tokens).filter(([, value]) => COLOR_LITERAL.test(value)));
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
    const outside = [CSS.slice(0, root.start), CSS.slice(root.end, light.start), CSS.slice(light.end)].join("\n");
    const literals = outside.split(/\r?\n/).filter((line) => COLOR_LITERAL.test(line));
    expect(literals).toEqual([]);
  });
});
