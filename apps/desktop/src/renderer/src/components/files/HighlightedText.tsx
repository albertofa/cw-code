import type { ReactNode } from "react";

export function HighlightedRanges({ text, ranges }: { text: string; ranges: ReadonlyArray<readonly [number, number]> }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (from < cursor || to <= from) continue;
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(<mark key={from}>{text.slice(from, to)}</mark>);
    cursor = to;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function HighlightedPositions({ text, positions, offset = 0 }: { text: string; positions: readonly number[]; offset?: number }) {
  const marked = new Set(positions.map((position) => position - offset).filter((position) => position >= 0 && position < text.length));
  if (marked.size === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(runMarked ? <mark key={key}>{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush(i);
      runMarked = isMarked;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}
