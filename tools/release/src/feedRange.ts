export interface ByteRange {
  start: number;
  end: number;
}

export type RangeRequest = { kind: "full" } | { kind: "partial"; ranges: ByteRange[] } | { kind: "unsatisfiable" };

export interface MultipartLayout {
  parts: Array<{ prefix: string; range: ByteRange }>;
  epilogue: string;
  contentLength: number;
}

export const MAX_RANGES = 1000;

const RANGE_SPEC = /^(\d*)-(\d*)$/;
const UNIT_PREFIX = /^bytes=/i;

function toOffset(literal: string): number | null {
  if (literal === "") return null;
  const value = Number(literal);
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

export function parseRangeHeader(header: string | undefined, size: number): RangeRequest {
  if (header === undefined || header.trim() === "") return { kind: "full" };
  const value = header.trim();
  if (!UNIT_PREFIX.test(value)) return { kind: "full" };
  const specs = value.replace(UNIT_PREFIX, "").split(",").map((spec) => spec.trim());
  if (specs.length > MAX_RANGES) return { kind: "unsatisfiable" };
  const ranges: ByteRange[] = [];
  for (const spec of specs) {
    const match = RANGE_SPEC.exec(spec);
    if (!match) return { kind: "full" };
    const first = toOffset(match[1]);
    const last = toOffset(match[2]);
    if (Number.isNaN(first) || Number.isNaN(last)) return { kind: "full" };
    if (first === null) {
      if (last === null) return { kind: "full" };
      if (last > 0 && size > 0) ranges.push({ start: Math.max(0, size - last), end: size - 1 });
      continue;
    }
    if (last !== null && last < first) return { kind: "full" };
    if (first >= size) continue;
    ranges.push({ start: first, end: last === null ? size - 1 : Math.min(last, size - 1) });
  }
  return ranges.length === 0 ? { kind: "unsatisfiable" } : { kind: "partial", ranges };
}

export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}

export function multipartLayout(ranges: ByteRange[], size: number, boundary: string, contentType: string): MultipartLayout {
  const parts = ranges.map((range, index) => ({
    prefix: `${index === 0 ? "" : "\r\n"}--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: ${contentRange(range, size)}\r\n\r\n`,
    range
  }));
  const epilogue = `\r\n--${boundary}--\r\n`;
  const contentLength =
    parts.reduce((total, part) => total + Buffer.byteLength(part.prefix) + rangeLength(part.range), 0) + Buffer.byteLength(epilogue);
  return { parts, epilogue, contentLength };
}
