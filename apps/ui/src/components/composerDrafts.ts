import { ServerCallError } from "@cw-code/client";
import type { AppTopicData } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { peekTopic } from "../server/topics.js";
import { ipcErrorMessage } from "./ipcError.js";
import { useNotifs } from "./Notifications.js";

export interface ComposerDraft {
  text: string;
  attachments: string[];
  quotes: string[];
  pastes: string[];
}

const SAVE_DEBOUNCE_MS = 500;
const RETRY_DELAY_MS = 2_000;
const MAX_SAVE_ATTEMPTS = 3;
const SAVE_FAILED_NOTIF_ID = "composer-draft-save-failed";

interface Unsent {
  draft: ComposerDraft;
  timer: ReturnType<typeof setTimeout> | null;
  sent: boolean;
  attempts: number;
}

const unsent = new Map<string, Unsent>();
const baseline = new Map<string, ComposerDraft>();

function isEmpty(draft: ComposerDraft): boolean {
  return !draft.text.trim() && draft.attachments.length === 0 && draft.quotes.length === 0 && draft.pastes.length === 0;
}

function sameDraft(a: ComposerDraft | undefined, b: ComposerDraft): boolean {
  if (!a) return isEmpty(b);
  return a.text === b.text && sameList(a.attachments, b.attachments) && sameList(a.quotes, b.quotes) && sameList(a.pastes, b.pastes);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function copy(draft: ComposerDraft): ComposerDraft {
  return { text: draft.text, attachments: [...draft.attachments], quotes: [...draft.quotes], pastes: [...draft.pastes] };
}

function storedDraft(key: string): ComposerDraft | null {
  const entry = peekTopic<Partial<AppTopicData>>(APP_TOPIC)?.data[`draft/${key}`];
  return entry ? { text: entry.text, attachments: entry.attachments, quotes: entry.quotes ?? [], pastes: entry.pastes ?? [] } : null;
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
  entry.attempts += 1;
  remember(key, entry.draft);
  window.cw.setComposerDraft(key, entry.draft.text, entry.draft.attachments, entry.draft.quotes, entry.draft.pastes).then(
    () => {
      if (unsent.get(key) === entry) unsent.delete(key);
    },
    (err: unknown) => handleSaveFailure(key, entry, err)
  );
}

function isTransient(err: unknown): boolean {
  return err instanceof ServerCallError && (err.code === "disconnected" || err.code === "connect-failed");
}

function handleSaveFailure(key: string, entry: Unsent, err: unknown): void {
  if (unsent.get(key) !== entry) return;
  baseline.delete(key);
  if (isTransient(err)) {
    entry.sent = false;
    if (entry.attempts < MAX_SAVE_ATTEMPTS) {
      entry.timer = setTimeout(() => flushComposerDraft(key), RETRY_DELAY_MS);
      return;
    }
    entry.attempts = 0;
    console.warn("[cw-code] could not save the composer draft; retrying after the server reconnects", err);
    useNotifs.getState().push({
      id: SAVE_FAILED_NOTIF_ID,
      kind: "warning",
      title: "Draft not saved yet",
      message: "It will be saved when the cw-code server reconnects."
    });
    return;
  }
  unsent.delete(key);
  console.warn("[cw-code] could not save the composer draft", err);
  useNotifs.getState().push({
    id: SAVE_FAILED_NOTIF_ID,
    kind: "warning",
    title: "Draft not saved",
    message: ipcErrorMessage(err)
  });
}

export function flushAllComposerDrafts(): void {
  for (const key of [...unsent.keys()]) flushComposerDraft(key);
}

export function saveComposerDraft(
  key: string,
  text: string,
  attachments: readonly string[],
  quotes: readonly string[] = [],
  pastes: readonly string[] = []
): void {
  const draft = { text, attachments: [...attachments], quotes: [...quotes], pastes: [...pastes] };
  const previous = unsent.get(key);
  if (previous && !previous.sent) {
    cancelTimer(previous);
    unsent.delete(key);
  }
  if (sameDraft(baseline.get(key), draft)) return;
  const entry: Unsent = { draft, timer: null, sent: false, attempts: 0 };
  entry.timer = setTimeout(() => flushComposerDraft(key), SAVE_DEBOUNCE_MS);
  unsent.set(key, entry);
}

export function clearComposerDraft(key: string): void {
  saveComposerDraft(key, "", []);
  flushComposerDraft(key);
}
