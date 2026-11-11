import { create } from "zustand";

export interface ReplyQuote {
  id: number;
  text: string;
}

const NO_QUOTES: ReplyQuote[] = [];
let nextId = 1;

interface ReplyQuotesState {
  bySession: Record<string, ReplyQuote[]>;
  add(sessionId: string, text: string): void;
  remove(sessionId: string, id: number): void;
  clear(sessionId: string): void;
  /** Restores the quotes saved with a session's draft. */
  replace(sessionId: string, texts: readonly string[]): void;
}

/** Excerpts the user picked from the thread to reply to, per session, until the next send. */
export const useReplyQuotesStore = create<ReplyQuotesState>((set, get) => ({
  bySession: {},
  add: (sessionId, text) => {
    const current = get().bySession[sessionId] ?? NO_QUOTES;
    if (text === "" || current.some((quote) => quote.text === text)) return;
    set({ bySession: { ...get().bySession, [sessionId]: [...current, { id: nextId++, text }] } });
  },
  remove: (sessionId, id) => {
    const current = get().bySession[sessionId];
    if (!current) return;
    set({ bySession: { ...get().bySession, [sessionId]: current.filter((quote) => quote.id !== id) } });
  },
  replace: (sessionId, texts) => {
    const next = { ...get().bySession };
    const unique = [...new Set(texts.filter((text) => text !== ""))];
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
