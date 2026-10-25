import type { AppTopicData } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { peekTopic } from "../server/topics.js";

export interface ComposerDraft {
  text: string;
  attachments: string[];
}

const SAVE_DEBOUNCE_MS = 500;

interface Unsent {
  draft: ComposerDraft;
  timer: ReturnType<typeof setTimeout> | null;
  sent: boolean;
}

const unsent = new Map<string, Unsent>();
const baseline = new Map<string, ComposerDraft>();

function isEmpty(draft: ComposerDraft): boolean {
  return !draft.text.trim() && draft.attachments.length === 0;
}

function sameDraft(a: ComposerDraft | undefined, b: ComposerDraft): boolean {
  if (!a) return isEmpty(b);
  return a.text === b.text && a.attachments.length === b.attachments.length && a.attachments.every((item, index) => item === b.attachments[index]);
}

function copy(draft: ComposerDraft): ComposerDraft {
  return { text: draft.text, attachments: [...draft.attachments] };
}

function storedDraft(key: string): ComposerDraft | null {
  const entry = peekTopic<Partial<AppTopicData>>(APP_TOPIC)?.data[`draft/${key}`];
  return entry ? { text: entry.text, attachments: entry.attachments } : null;
}

function remember(key: string, draft: ComposerDraft): void {
  if (isEmpty(draft)) baseline.delete(key);
  else baseline.set(key, copy(draft));
}

export function loadComposerDraft(key: string): ComposerDraft | null {
  const pending = unsent.get(key);
  const draft = pending ? pending.draft : storedDraft(key);
  if (!draft) {
    baseline.delete(key);
    return null;
  }
  remember(key, draft);
  return copy(draft);
}

function cancelTimer(entry: Unsent): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
}

export function flushComposerDraft(key: string): void {
  const entry = unsent.get(key);
  if (!entry || entry.sent) return;
  cancelTimer(entry);
  entry.sent = true;
  remember(key, entry.draft);
  window.cw.setComposerDraft(key, entry.draft.text, entry.draft.attachments).then(
    () => {
      if (unsent.get(key) === entry) unsent.delete(key);
    },
    (err: unknown) => {
      baseline.delete(key);
      console.warn("[cw-code] could not save the composer draft", err);
    }
  );
}

export function saveComposerDraft(key: string, text: string, attachments: readonly string[]): void {
  const draft = { text, attachments: [...attachments] };
  const previous = unsent.get(key);
  if (previous && !previous.sent) {
    cancelTimer(previous);
    unsent.delete(key);
  }
  if (sameDraft(baseline.get(key), draft)) return;
  const entry: Unsent = { draft, timer: null, sent: false };
  entry.timer = setTimeout(() => flushComposerDraft(key), SAVE_DEBOUNCE_MS);
  unsent.set(key, entry);
}

export function clearComposerDraft(key: string): void {
  saveComposerDraft(key, "", []);
  flushComposerDraft(key);
}
