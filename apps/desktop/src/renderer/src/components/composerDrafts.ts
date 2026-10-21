export interface ComposerDraft {
  text: string;
  attachments: string[];
}

/** Drafts are kept per composer key for this run of the app; the oldest are dropped beyond this many. */
export const MAX_COMPOSER_DRAFTS = 50;

const drafts = new Map<string, ComposerDraft>();

export function loadComposerDraft(key: string): ComposerDraft | null {
  const saved = drafts.get(key);
  return saved ? { text: saved.text, attachments: [...saved.attachments] } : null;
}

/** An empty draft clears the entry instead of storing nothing. */
export function saveComposerDraft(key: string, text: string, attachments: readonly string[]): void {
  drafts.delete(key);
  if (!text.trim() && attachments.length === 0) return;
  drafts.set(key, { text, attachments: [...attachments] });
  while (drafts.size > MAX_COMPOSER_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

export function clearComposerDraft(key: string): void {
  drafts.delete(key);
}

export function resetComposerDraftsForTests(): void {
  drafts.clear();
}
