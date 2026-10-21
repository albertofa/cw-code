const EOL_SAMPLE_BREAKS = 1000;
const INDENT_SAMPLE_LINES = 2000;
const SPACE_UNITS = [2, 4, 8];

export type Eol = "\n" | "\r\n";

export interface IndentStyle {
  unit: string;
  label: string;
}

export function detectEol(text: string): Eol {
  let lf = 0;
  let crlf = 0;
  let index = text.indexOf("\n");
  while (index >= 0 && lf + crlf < EOL_SAMPLE_BREAKS) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf++;
    else lf++;
    index = text.indexOf("\n", index + 1);
  }
  return crlf > lf ? "\r\n" : "\n";
}

function spacesStyle(width: number): IndentStyle {
  return { unit: " ".repeat(width), label: `Spaces: ${width}` };
}

export function detectIndent(text: string): IndentStyle {
  let tabLines = 0;
  let spaceLines = 0;
  let previousWidth = 0;
  const increases = new Map<number, number>();
  let start = 0;
  for (let lineNumber = 0; lineNumber < INDENT_SAMPLE_LINES && start < text.length; lineNumber++) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    let cursor = start;
    while (cursor < end && text.charCodeAt(cursor) === 32) cursor++;
    const width = cursor - start;
    const code = text.charCodeAt(cursor);
    const blank = cursor >= end || code === 13;
    if (!blank) {
      if (code === 9 && width === 0) {
        tabLines++;
      } else if (width > 0) {
        spaceLines++;
      }
      if (code !== 9) {
        const delta = width - previousWidth;
        if (delta > 0) increases.set(delta, (increases.get(delta) ?? 0) + 1);
        previousWidth = width;
      }
    }
    start = end + 1;
  }
  if (tabLines > spaceLines) return { unit: "\t", label: "Tabs" };
  let best = 2;
  let bestCount = 0;
  for (const unit of SPACE_UNITS) {
    const count = increases.get(unit) ?? 0;
    if (count > bestCount) {
      best = unit;
      bestCount = count;
    }
  }
  return spacesStyle(best);
}

export function languageLabelFallback(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "Plain Text";
  return name.slice(dot + 1).toUpperCase();
}
