export interface ProjectIdentity {
  monogram: string;
  color: string;
}

const PALETTE = [
  "#99a1af",
  "#ff6467",
  "#ff8904",
  "#ffb900",
  "#fdc700",
  "#9ae600",
  "#05df72",
  "#00d492",
  "#00d5be",
  "#00d3f2",
  "#00bcff",
  "#51a2ff",
  "#7c86ff",
  "#a684ff",
  "#c27aff",
  "#ed6aff",
  "#fb64b6",
  "#ff637e",
] as const;

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
