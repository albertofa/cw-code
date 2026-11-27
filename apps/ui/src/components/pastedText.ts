/**
 * Large pastes become cards above the composer instead of filling the textarea: the composer
 * stays readable and per-keystroke work (autosize, mention highlight, draft save) stays small.
 */
export const PASTE_COLLAPSE_CHARS = 2_000;
export const PASTE_COLLAPSE_LINES = 30;
const PREVIEW_CHARS = 320;

export function shouldCollapsePaste(text: string): boolean {
  if (text.trim() === "") return false;
  if (text.length >= PASTE_COLLAPSE_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines >= PASTE_COLLAPSE_LINES) return true;
  }
  return false;
}

/** The message as sent: what the user typed, then each pasted block, separated by a blank line. */
export function withPastes(typed: string, pastes: readonly string[]): string {
  return [typed, ...pastes.filter((paste) => paste.trim() !== "")].filter((part) => part !== "").join("\n\n");
}

export function pastePreview(text: string): string {
  return text.length <= PREVIEW_CHARS ? text : text.slice(0, PREVIEW_CHARS);
}

export function pasteSizeLabel(text: string): string {
  const lines = text.split("\n").length;
  const chars = text.length >= 1000 ? `${(text.length / 1000).toFixed(text.length >= 10_000 ? 0 : 1)}k chars` : `${text.length} chars`;
  return `${chars} · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** Puts a pasted block back into the draft at the caret, on its own line, and returns the new caret. */
export function insertPaste(draft: string, caret: number | null, text: string): { text: string; caret: number } {
  const at = caret === null ? draft.length : Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before !== "" && !before.endsWith("\n") ? "\n" : "";
  const trail = after !== "" && !after.startsWith("\n") ? "\n" : "";
  const head = `${before}${lead}${text}`;
  return { text: `${head}${trail}${after}`, caret: head.length };
}
