const FILL_BGR = [0x4f, 0xb4, 0xe8] as const;
const TEXT_BGR = [0x10, 0x1b, 0x20] as const;
const MAX_DIGIT = 9;
const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;
const GLYPH_GAP = 1;
const TEXT_FILL_RATIO = 0.7;
const COVERAGE_SAMPLES = 4;

const GLYPHS: Record<string, readonly string[]> = {
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"]
};

export function badgeLabel(count: number): string {
  return count > MAX_DIGIT ? `${MAX_DIGIT}+` : String(count);
}

interface TextLayout {
  glyphs: readonly (readonly string[])[];
  scale: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

function layoutText(label: string, size: number): TextLayout {
  const glyphs = [...label].flatMap((char) => (GLYPHS[char] ? [GLYPHS[char]] : []));
  const columns = Math.max(0, glyphs.length * (GLYPH_WIDTH + GLYPH_GAP) - GLYPH_GAP);
  const scale = Math.max(1, Math.floor((size * TEXT_FILL_RATIO) / Math.max(columns, GLYPH_HEIGHT)));
  const width = columns * scale;
  const height = GLYPH_HEIGHT * scale;
  return { glyphs, scale, left: Math.round((size - width) / 2), top: Math.round((size - height) / 2), width, height };
}

function isTextPixel(layout: TextLayout, x: number, y: number): boolean {
  if (x < layout.left || y < layout.top || x >= layout.left + layout.width || y >= layout.top + layout.height) return false;
  const column = Math.floor((x - layout.left) / layout.scale);
  const row = Math.floor((y - layout.top) / layout.scale);
  const stride = GLYPH_WIDTH + GLYPH_GAP;
  const glyphColumn = column % stride;
  if (glyphColumn >= GLYPH_WIDTH) return false;
  return layout.glyphs[Math.floor(column / stride)]?.[row]?.[glyphColumn] === "1";
}

function circleCoverage(x: number, y: number, size: number): number {
  const radius = size / 2;
  let inside = 0;
  for (let sy = 0; sy < COVERAGE_SAMPLES; sy += 1) {
    for (let sx = 0; sx < COVERAGE_SAMPLES; sx += 1) {
      const dx = x + (sx + 0.5) / COVERAGE_SAMPLES - radius;
      const dy = y + (sy + 0.5) / COVERAGE_SAMPLES - radius;
      if (dx * dx + dy * dy <= radius * radius) inside += 1;
    }
  }
  return inside / (COVERAGE_SAMPLES * COVERAGE_SAMPLES);
}

export function renderBadge(label: string, size = 32): Buffer {
  const buffer = Buffer.alloc(size * size * 4);
  const layout = layoutText(label, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = circleCoverage(x, y, size);
      if (coverage === 0) continue;
      const color = isTextPixel(layout, x, y) ? TEXT_BGR : FILL_BGR;
      const offset = (y * size + x) * 4;
      buffer[offset] = Math.round(color[0] * coverage);
      buffer[offset + 1] = Math.round(color[1] * coverage);
      buffer[offset + 2] = Math.round(color[2] * coverage);
      buffer[offset + 3] = Math.round(255 * coverage);
    }
  }
  return buffer;
}
