import { create } from "zustand";

export interface EditorBuffer {
  sessionId: string;
  path: string;
  saved: string;
  content: string;
  refs: number;
}

export interface DirtyBuffer {
  key: string;
  sessionId: string;
  path: string;
  content: string;
}

interface EditorBuffersState {
  buffers: Record<string, EditorBuffer>;
  register(sessionId: string, path: string, saved: string): string;
  update(key: string, content: string): void;
  markSaved(key: string, saved: string): void;
  discard(key: string): void;
  unregister(key: string): void;
  dirty(): DirtyBuffer[];
}

export function bufferKey(sessionId: string, path: string): string {
  return `${sessionId}\n${path}`;
}

function withBuffer(
  buffers: Record<string, EditorBuffer>,
  key: string,
  patch: (buffer: EditorBuffer) => EditorBuffer
): Record<string, EditorBuffer> {
  const current = buffers[key];
  if (!current) return buffers;
  const next = patch(current);
  if (next.refs <= 0 && next.content === next.saved) {
    const remaining = { ...buffers };
    delete remaining[key];
    return remaining;
  }
  return next === current ? buffers : { ...buffers, [key]: next };
}

export const useEditorBuffers = create<EditorBuffersState>((set, get) => ({
  buffers: {},
  register(sessionId, path, saved) {
    const key = bufferKey(sessionId, path);
    const existing = get().buffers[key];
    const next: EditorBuffer = !existing
      ? { sessionId, path, saved, content: saved, refs: 1 }
      : existing.content === existing.saved
        ? { ...existing, saved, content: saved, refs: existing.refs + 1 }
        : { ...existing, refs: existing.refs + 1 };
    set({ buffers: { ...get().buffers, [key]: next } });
    return key;
  },
  update(key, content) {
    set({ buffers: withBuffer(get().buffers, key, (buffer) => (buffer.content === content ? buffer : { ...buffer, content })) });
  },
  markSaved(key, saved) {
    set({ buffers: withBuffer(get().buffers, key, (buffer) => ({ ...buffer, saved })) });
  },
  discard(key) {
    set({ buffers: withBuffer(get().buffers, key, (buffer) => (buffer.content === buffer.saved ? buffer : { ...buffer, content: buffer.saved })) });
  },
  unregister(key) {
    set({ buffers: withBuffer(get().buffers, key, (buffer) => (buffer.refs > 0 ? { ...buffer, refs: buffer.refs - 1 } : buffer)) });
  },
  dirty() {
    return Object.entries(get().buffers)
      .filter(([, buffer]) => buffer.content !== buffer.saved)
      .map(([key, buffer]) => ({ key, sessionId: buffer.sessionId, path: buffer.path, content: buffer.content }));
  }
}));
