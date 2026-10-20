import { PROJECT_HUES } from "../../../shared/themes.js";

export interface ProjectIdentity {
  monogram: string;
  color: string;
}

const PALETTE = PROJECT_HUES.map((hue) => `var(--project-${hue})`);

const FALLBACK_MONOGRAM = "PR";
const FALLBACK_COLOR_SEED = "project";

function normalizeName(name: string): string {
  return name.normalize("NFKC").trim();
}

function deriveMonogram(name: string): string {
  const words = normalizeName(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return FALLBACK_MONOGRAM;

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

function deriveColor(name: string): string {
  const seed = normalizeName(name).toLocaleLowerCase("en-US") || FALLBACK_COLOR_SEED;
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PALETTE.length;
  }
  return PALETTE[index] ?? PALETTE[0];
}

export function deriveProjectIdentity(name: string): ProjectIdentity {
  return { monogram: deriveMonogram(name), color: deriveColor(name) };
}
