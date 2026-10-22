/**
 * Text indexing for find-in-conversation. The thread is markdown-rendered into
 * many nested nodes, so matches are resolved against one flattened buffer and
 * mapped back to DOM ranges that may span several text nodes.
 */

export interface TextChunk {
  node: Text;
  /** Offset of this node's first character inside the flattened buffer. */
  start: number;
}

export interface TextIndex {
  text: string;
  chunks: TextChunk[];
}

export interface MatchSpan {
  start: number;
  end: number;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SVG"]);

/** Tags that keep text flowing on the same line; everything else breaks it. */
const INLINE_TAGS = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "CITE",
  "CODE",
  "DEL",
  "EM",
  "I",
  "INS",
  "KBD",
  "LABEL",
  "MARK",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "U",
  "VAR"
]);

export function skipsFind(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  return el.classList.contains("find-skip");
}

/** Flattens the subtree into searchable text, keeping a map back to its text nodes. */
export function buildTextIndex(root: Element): TextIndex {
  const chunks: TextChunk[] = [];
  let text = "";

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      if (value.length === 0) return;
      chunks.push({ node: node as Text, start: text.length });
      text += value;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (skipsFind(el)) return;
    const breaks = !INLINE_TAGS.has(el.tagName);
    if (breaks && !text.endsWith("\n") && text.length > 0) text += "\n";
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child);
    if (breaks && !text.endsWith("\n") && text.length > 0) text += "\n";
  };

  walk(root);
  return { text, chunks };
}

/** Case-insensitive, non-overlapping matches, in document order. */
export function findMatches(text: string, query: string): MatchSpan[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return [];
  const haystack = text.toLowerCase();
  const spans: MatchSpan[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return spans;
    spans.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
}

/** Index of the chunk containing `offset`, or -1 when the index is empty. */
export function chunkAt(chunks: TextChunk[], offset: number): number {
  let low = 0;
  let high = chunks.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const chunk = chunks[mid];
    const end = chunk.start + (chunk.node.nodeValue?.length ?? 0);
    if (offset < chunk.start) high = mid - 1;
    else if (offset >= end) {
      found = mid;
      low = mid + 1;
    } else return mid;
  }
  return found;
}

/** Turns a buffer span into a live DOM range, or null if it fell on separators only. */
export function rangeForSpan(index: TextIndex, span: MatchSpan): Range | null {
  const startIdx = chunkAt(index.chunks, span.start);
  const endIdx = chunkAt(index.chunks, span.end - 1);
  if (startIdx === -1 || endIdx === -1) return null;
  const startChunk = index.chunks[startIdx];
  const endChunk = index.chunks[endIdx];
  const startLen = startChunk.node.nodeValue?.length ?? 0;
  const endLen = endChunk.node.nodeValue?.length ?? 0;
  const range = document.createRange();
  range.setStart(startChunk.node, Math.min(Math.max(span.start - startChunk.start, 0), startLen));
  range.setEnd(endChunk.node, Math.min(Math.max(span.end - endChunk.start, 0), endLen));
  return range;
}

/** Short label for a prompt marker or a find result. */
export function snippet(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
