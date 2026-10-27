import { create } from "zustand";
import { rebasePath } from "../files/treeModel.js";

export interface EditorBuffer {
  sessionId: string;
  path: string;
  saved: string;
  content: string;
  refs: number;
  missing?: boolean;
  mtimeMs?: number;
  readOnly?: boolean;
  conflict?: ExternalConflict | null;
}

export interface ExternalConflict {
  content: string;
  mtimeMs: number;
}

export interface BufferMeta {
  mtimeMs?: number;
  readOnly?: boolean;
}

export type ExternalChangeResult = "unchanged" | "reloaded" | "conflict";
export type ConflictChoice = "reload" | "keepMine";

export interface DirtyBuffer {
  key: string;
  sessionId: string;
  path: string;
  content: string;
}

export interface MatchedBuffer {
  key: string;
  buffer: EditorBuffer;
}

interface EditorBuffersState {
  buffers: Record<string, EditorBuffer>;
  register(sessionId: string, path: string, saved: string, meta?: BufferMeta): string;
  update(key: string, content: string): void;
  markSaved(key: string, saved: string, mtimeMs?: number): void;
  discard(key: string): void;
  unregister(key: string): void;
  reloadClean(key: string, saved: string, mtimeMs?: number): boolean;
  markMissing(key: string): boolean;
  applyExternal(key: string, content: string, mtimeMs: number): ExternalChangeResult;
  resolveConflict(key: string, choice: ConflictChoice): void;
  renamePath(sessionId: string, from: string, to: string): boolean;
  setReadOnly(key: string, readOnly: boolean): void;
  dirty(): DirtyBuffer[];
}

export function bufferKey(sessionId: string, path: string): string {
  return `${sessionId}\n${path}`;
}

export function isDirtyBuffer(buffer: EditorBuffer): boolean {
  return buffer.content !== buffer.saved;
}

export function buffersForPaths(
  buffers: Record<string, EditorBuffer>,
  sessionIds: readonly string[],
  paths: readonly string[]
): MatchedBuffer[] {
  const sessions = new Set(sessionIds);
  const wanted = new Set(paths);
  return Object.entries(buffers)
    .filter(([, buffer]) => sessions.has(buffer.sessionId) && wanted.has(buffer.path))
    .map(([key, buffer]) => ({ key, buffer }));
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
  register(sessionId, path, saved, meta) {
    const key = bufferKey(sessionId, path);
    const existing = get().buffers[key];
    const next: EditorBuffer = !existing
      ? { sessionId, path, saved, content: saved, refs: 1, ...meta }
      : existing.content === existing.saved
        ? { sessionId, path, saved, content: saved, refs: existing.refs + 1, ...meta }
        : { ...existing, refs: existing.refs + 1, ...(meta?.readOnly === undefined ? {} : { readOnly: meta.readOnly }) };
    set({ buffers: { ...get().buffers, [key]: next } });
    return key;
  },
  update(key, content) {
    set({ buffers: withBuffer(get().buffers, key, (buffer) => (buffer.content === content ? buffer : { ...buffer, content })) });
  },
  markSaved(key, saved, mtimeMs) {
    set({
      buffers: withBuffer(get().buffers, key, (buffer) => ({
        ...buffer,
        saved,
        mtimeMs: mtimeMs ?? buffer.mtimeMs,
        conflict: null,
        missing: undefined
      }))
    });
  },
  discard(key) {
    set({
      buffers: withBuffer(get().buffers, key, (buffer) => {
        const { conflict } = buffer;
        if (conflict) return { ...buffer, saved: conflict.content, content: conflict.content, mtimeMs: conflict.mtimeMs, conflict: null };
        return buffer.content === buffer.saved ? buffer : { ...buffer, content: buffer.saved };
      })
    });
  },
  unregister(key) {
    set({ buffers: withBuffer(get().buffers, key, (buffer) => (buffer.refs > 0 ? { ...buffer, refs: buffer.refs - 1 } : buffer)) });
  },
  reloadClean(key, saved, mtimeMs) {
    const current = get().buffers[key];
    if (!current || isDirtyBuffer(current)) return false;
    const next: EditorBuffer = {
      ...current,
      saved,
      content: saved,
      mtimeMs: mtimeMs ?? current.mtimeMs,
      conflict: null,
      missing: undefined
    };
    set({ buffers: { ...get().buffers, [key]: next } });
    return true;
  },
  markMissing(key) {
    const current = get().buffers[key];
    if (!current || isDirtyBuffer(current)) return false;
    set({ buffers: { ...get().buffers, [key]: { ...current, missing: true } } });
    return true;
  },
  applyExternal(key, content, mtimeMs) {
    const current = get().buffers[key];
    if (!current) return "unchanged";
    const newest = Math.max(current.mtimeMs ?? -Infinity, current.conflict?.mtimeMs ?? -Infinity);
    if (mtimeMs < newest) return "unchanged";
    if (content === current.saved) {
      set({ buffers: withBuffer(get().buffers, key, (buffer) => ({ ...buffer, mtimeMs, conflict: null, missing: undefined })) });
      return "unchanged";
    }
    if (!isDirtyBuffer(current) || current.content === content) {
      set({
        buffers: withBuffer(get().buffers, key, (buffer) => ({
          ...buffer,
          saved: content,
          content,
          mtimeMs,
          conflict: null,
          missing: undefined
        }))
      });
      return "reloaded";
    }
    set({ buffers: withBuffer(get().buffers, key, (buffer) => ({ ...buffer, conflict: { content, mtimeMs } })) });
    return "conflict";
  },
  setReadOnly(key, readOnly) {
    set({ buffers: withBuffer(get().buffers, key, (buffer) => (buffer.readOnly === readOnly ? buffer : { ...buffer, readOnly })) });
  },
  resolveConflict(key, choice) {
    set({
      buffers: withBuffer(get().buffers, key, (buffer) => {
        const { conflict } = buffer;
        if (!conflict) return buffer;
        const resolved = { ...buffer, saved: conflict.content, mtimeMs: conflict.mtimeMs, conflict: null };
        return choice === "reload" ? { ...resolved, content: conflict.content } : resolved;
      })
    });
  },
  renamePath(sessionId, from, to) {
    const current = get().buffers;
    const moved: Array<{ sourceKey: string; targetKey: string; buffer: EditorBuffer }> = [];
    for (const [sourceKey, buffer] of Object.entries(current)) {
      const path = buffer.sessionId === sessionId ? rebasePath(buffer.path, from, to) : null;
      if (path !== null) moved.push({ sourceKey, targetKey: bufferKey(sessionId, path), buffer: { ...buffer, path } });
    }
    if (moved.length === 0) return true;
    const sourceKeys = new Set(moved.map((entry) => entry.sourceKey));
    if (moved.some((entry) => current[entry.targetKey] && !sourceKeys.has(entry.targetKey))) return false;
    const buffers = Object.fromEntries(Object.entries(current).filter(([key]) => !sourceKeys.has(key)));
    for (const entry of moved) buffers[entry.targetKey] = entry.buffer;
    set({ buffers });
    return true;
  },
  dirty() {
    return Object.entries(get().buffers)
      .filter(([, buffer]) => isDirtyBuffer(buffer))
      .map(([key, buffer]) => ({ key, sessionId: buffer.sessionId, path: buffer.path, content: buffer.content }));
  }
}));
