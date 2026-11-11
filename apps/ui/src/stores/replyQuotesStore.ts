import { create } from "zustand";
import { MAX_DRAFT_QUOTES, MAX_QUOTE_LENGTH } from "@cw-code/shared/draftQuotes";

export interface ReplyQuote {
  id: number;
  text: string;
}

const NO_QUOTES: ReplyQuote[] = [];
let nextId = 1;

/** Keeps a quote within what the server stores with the draft, so a long excerpt never breaks draft saves. */
export function fitQuote(text: string): string {
  return text.length <= MAX_QUOTE_LENGTH ? text : `${text.slice(0, MAX_QUOTE_LENGTH - 1).trimEnd()}…`;
}

interface ReplyQuotesState {
  bySession: Record<string, ReplyQuote[]>;
  /** False when the session already holds the maximum number of quotes. */
  add(sessionId: string, text: string): boolean;
  remove(sessionId: string, id: number): void;
  clear(sessionId: string): void;
  /** Restores the quotes saved with a session's draft. */
  replace(sessionId: string, texts: readonly string[]): void;
}

/** Excerpts the user picked from the thread to reply to, per session, until the next send. */
export const useReplyQuotesStore = create<ReplyQuotesState>((set, get) => ({
  bySession: {},
  add: (sessionId, raw) => {
    const current = get().bySession[sessionId] ?? NO_QUOTES;
    const text = fitQuote(raw);
    if (text === "" || current.some((quote) => quote.text === text)) return true;
    if (current.length >= MAX_DRAFT_QUOTES) return false;
    set({ bySession: { ...get().bySession, [sessionId]: [...current, { id: nextId++, text }] } });
    return true;
  },
  remove: (sessionId, id) => {
    const current = get().bySession[sessionId];
    if (!current) return;
    set({ bySession: { ...get().bySession, [sessionId]: current.filter((quote) => quote.id !== id) } });
  },
  replace: (sessionId, texts) => {
    const next = { ...get().bySession };
    const unique = [...new Set(texts.map(fitQuote).filter((text) => text !== ""))].slice(0, MAX_DRAFT_QUOTES);
    if (unique.length === 0) delete next[sessionId];
    else next[sessionId] = unique.map((text) => ({ id: nextId++, text }));
    set({ bySession: next });
  },
  clear: (sessionId) => {
    if (!get().bySession[sessionId]) return;
    const next = { ...get().bySession };
    delete next[sessionId];
    set({ bySession: next });
  }
}));

export function selectReplyQuotes(state: ReplyQuotesState, sessionId: string): ReplyQuote[] {
  return state.bySession[sessionId] ?? NO_QUOTES;
}
