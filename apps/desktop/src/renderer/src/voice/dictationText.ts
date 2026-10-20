/** Places dictated text into the draft at the caret (or over the selection), keeping words apart. */
export function insertDictation(
  draft: string,
  text: string,
  selectionStart: number,
  selectionEnd: number
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, draft.length));
  const end = Math.max(start, Math.min(selectionEnd, draft.length));
  const clean = text.trim();
  if (!clean) return { value: draft, caret: end };
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailing = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const inserted = `${leading}${clean}${trailing}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
