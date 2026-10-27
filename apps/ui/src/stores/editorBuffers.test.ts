import { beforeEach, describe, expect, it } from "bun:test";
import { bufferKey, buffersForPaths, isDirtyBuffer, useEditorBuffers } from "./editorBuffers.js";

const store = () => useEditorBuffers.getState();

describe("editorBuffers", () => {
  beforeEach(() => {
    useEditorBuffers.setState({ buffers: {} });
  });

  it("starts clean and becomes dirty only when content differs from the saved text", () => {
    const key = store().register("sess_a", "src/a.ts", "one");
    expect(key).toBe(bufferKey("sess_a", "src/a.ts"));
    expect(store().dirty()).toEqual([]);
    store().update(key, "two");
    expect(store().dirty()).toEqual([{ key, sessionId: "sess_a", path: "src/a.ts", content: "two" }]);
    store().update(key, "one");
    expect(store().dirty()).toEqual([]);
  });

  it("tracks dirty files across sessions independently", () => {
    const a = store().register("sess_a", "x.ts", "a");
    const b = store().register("sess_b", "x.ts", "b");
    store().update(a, "a2");
    store().update(b, "b2");
    expect(store().dirty().map((buffer) => buffer.sessionId).sort()).toEqual(["sess_a", "sess_b"]);
    store().markSaved(a, "a2");
    expect(store().dirty().map((buffer) => buffer.key)).toEqual([b]);
  });

  it("discard restores the saved text", () => {
    const key = store().register("sess_a", "x.ts", "saved");
    store().update(key, "edited");
    store().discard(key);
    expect(store().buffers[key].content).toBe("saved");
    expect(store().dirty()).toEqual([]);
  });

  it("keeps a shared buffer and its edits after every editor unregisters", () => {
    const key = store().register("sess_a", "x.ts", "v1");
    store().update(key, "edited");
    expect(store().register("sess_a", "x.ts", "v1-reloaded")).toBe(key);
    expect(store().buffers[key]).toMatchObject({ saved: "v1", content: "edited", refs: 2 });
    store().unregister(key);
    expect(store().dirty()).toHaveLength(1);
    store().unregister(key);
    expect(store().buffers[key]).toMatchObject({ content: "edited", refs: 0 });
    expect(store().dirty()).toHaveLength(1);
  });

  it("keeps a dirty buffer after switching to another file and shows its edits on reopen", () => {
    const a = store().register("sess_a", "a.ts", "a-saved");
    store().update(a, "a-edited");
    const b = store().register("sess_a", "b.ts", "b-saved");
    store().unregister(a);
    expect(store().dirty()).toEqual([{ key: a, sessionId: "sess_a", path: "a.ts", content: "a-edited" }]);
    store().unregister(b);
    expect(store().buffers[b]).toBeUndefined();
    expect(store().register("sess_a", "a.ts", "a-from-disk")).toBe(a);
    expect(store().buffers[a]).toMatchObject({ saved: "a-saved", content: "a-edited", refs: 1 });
  });

  it("releases a retained dirty buffer once it is saved or discarded", () => {
    const saved = store().register("sess_a", "saved.ts", "v1");
    store().update(saved, "v2");
    store().unregister(saved);
    store().markSaved(saved, "v2");
    expect(store().buffers[saved]).toBeUndefined();
    const discarded = store().register("sess_a", "discarded.ts", "v1");
    store().update(discarded, "v2");
    store().unregister(discarded);
    store().discard(discarded);
    expect(store().buffers[discarded]).toBeUndefined();
    expect(store().dirty()).toEqual([]);
  });

  it("releases a clean buffer when its last editor unregisters", () => {
    const key = store().register("sess_a", "x.ts", "v1");
    store().unregister(key);
    expect(store().buffers[key]).toBeUndefined();
  });

  it("refreshes a clean buffer from disk when the file is opened again", () => {
    const key = store().register("sess_a", "x.ts", "v1");
    store().register("sess_a", "x.ts", "v2");
    expect(store().buffers[key]).toMatchObject({ saved: "v2", content: "v2", refs: 2 });
  });

  it("ignores updates for unknown keys", () => {
    store().update("missing", "x");
    store().markSaved("missing", "x");
    store().discard("missing");
    store().unregister("missing");
    expect(store().reloadClean("missing", "x")).toBe(false);
    expect(store().markMissing("missing")).toBe(false);
    expect(store().buffers).toEqual({});
  });

  it("reloads and marks missing only clean buffers, never unsaved edits", () => {
    const clean = store().register("sess_a", "clean.ts", "v1");
    const dirty = store().register("sess_a", "dirty.ts", "v1");
    store().update(dirty, "edited");
    expect(store().reloadClean(clean, "v0")).toBe(true);
    expect(store().reloadClean(dirty, "v0")).toBe(false);
    expect(store().buffers[clean]).toMatchObject({ saved: "v0", content: "v0", refs: 1 });
    expect(store().buffers[dirty]).toMatchObject({ saved: "v1", content: "edited" });
    expect(store().markMissing(clean)).toBe(true);
    expect(store().markMissing(dirty)).toBe(false);
    expect(store().buffers[clean].missing).toBe(true);
    expect(store().buffers[dirty].missing).toBeUndefined();
    store().register("sess_a", "clean.ts", "back");
    expect(store().buffers[clean]).toMatchObject({ saved: "back", content: "back", refs: 2 });
    expect(store().buffers[clean].missing).toBeUndefined();
  });

  it("applies register metadata and keeps the old mtime while edits are unsaved", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10, readOnly: false });
    expect(store().buffers[key]).toMatchObject({ saved: "v1", mtimeMs: 10, readOnly: false });
    store().update(key, "edited");
    store().register("sess_a", "x.ts", "v2", { mtimeMs: 20, readOnly: true });
    expect(store().buffers[key]).toMatchObject({ saved: "v1", content: "edited", mtimeMs: 10, readOnly: true, refs: 2 });
    const clean = store().register("sess_a", "y.ts", "v1", { mtimeMs: 10 });
    store().register("sess_a", "y.ts", "v2", { mtimeMs: 20 });
    expect(store().buffers[clean]).toMatchObject({ saved: "v2", content: "v2", mtimeMs: 20 });
  });

  it("markSaved records the new mtime and clears conflict and missing", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().update(key, "v2");
    store().applyExternal(key, "disk", 15);
    store().markSaved(key, "v2", 30);
    expect(store().buffers[key]).toMatchObject({ saved: "v2", content: "v2", mtimeMs: 30 });
    expect(store().buffers[key].conflict).toBeFalsy();
    store().markMissing(key);
    expect(store().buffers[key].missing).toBe(true);
    store().markSaved(key, "v2");
    expect(store().buffers[key].missing).toBeUndefined();
    expect(store().buffers[key].mtimeMs).toBe(30);
  });

  it("applyExternal only refreshes the mtime when the disk content equals the saved text", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().update(key, "edited");
    expect(store().applyExternal(key, "v1", 20)).toBe("unchanged");
    expect(store().buffers[key]).toMatchObject({ saved: "v1", content: "edited", mtimeMs: 20 });
    expect(store().buffers[key].conflict).toBeFalsy();
  });

  it("applyExternal reloads a clean buffer and clears missing", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().markMissing(key);
    expect(store().applyExternal(key, "v2", 20)).toBe("reloaded");
    expect(store().buffers[key]).toMatchObject({ saved: "v2", content: "v2", mtimeMs: 20 });
    expect(store().buffers[key].missing).toBeUndefined();
  });

  it("applyExternal flags a conflict on a dirty buffer without touching the edits", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().update(key, "mine");
    expect(store().applyExternal(key, "theirs", 20)).toBe("conflict");
    expect(store().buffers[key]).toMatchObject({
      saved: "v1",
      content: "mine",
      mtimeMs: 10,
      conflict: { content: "theirs", mtimeMs: 20 }
    });
    expect(store().applyExternal("missing", "x", 1)).toBe("unchanged");
  });

  it("applyExternal treats a dirty buffer that already matches the disk as reloaded", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().update(key, "same");
    expect(store().applyExternal(key, "same", 20)).toBe("reloaded");
    expect(store().dirty()).toEqual([]);
  });

  it("resolveConflict reload adopts the disk content", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().update(key, "mine");
    store().applyExternal(key, "theirs", 20);
    store().resolveConflict(key, "reload");
    expect(store().buffers[key]).toMatchObject({ saved: "theirs", content: "theirs", mtimeMs: 20 });
    expect(store().buffers[key].conflict).toBeFalsy();
  });

  it("resolveConflict keepMine stays dirty against the new disk state", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().update(key, "mine");
    store().applyExternal(key, "theirs", 20);
    store().resolveConflict(key, "keepMine");
    expect(store().buffers[key]).toMatchObject({ saved: "theirs", content: "mine", mtimeMs: 20 });
    expect(store().buffers[key].conflict).toBeFalsy();
    expect(store().dirty()).toHaveLength(1);
    store().resolveConflict(key, "reload");
    expect(store().buffers[key].content).toBe("mine");
    store().resolveConflict("missing", "reload");
  });

  it("re-keys the buffers of a renamed file or directory within one session", () => {
    const file = store().register("sess_a", "src/a.ts", "a");
    const nested = store().register("sess_a", "src/lib/b.ts", "b");
    const sibling = store().register("sess_a", "srcx/c.ts", "c");
    const other = store().register("sess_b", "src/a.ts", "z");
    store().update(nested, "b2");
    store().renamePath("sess_a", "src", "app");
    const { buffers } = store();
    expect(buffers[file]).toBeUndefined();
    expect(buffers[nested]).toBeUndefined();
    expect(buffers[bufferKey("sess_a", "app/a.ts")]).toMatchObject({ path: "app/a.ts", saved: "a", refs: 1 });
    expect(buffers[bufferKey("sess_a", "app/lib/b.ts")]).toMatchObject({ path: "app/lib/b.ts", content: "b2", saved: "b" });
    expect(buffers[sibling]).toBeDefined();
    expect(buffers[other]).toMatchObject({ path: "src/a.ts" });
    expect(store().dirty().map((buffer) => buffer.path)).toEqual(["app/lib/b.ts"]);
  });

  it("renamePath is a no-op when nothing matches", () => {
    store().register("sess_a", "a.ts", "a");
    const before = store().buffers;
    expect(store().renamePath("sess_a", "nope", "other")).toBe(true);
    expect(store().buffers).toBe(before);
  });

  it("renamePath refuses and changes nothing when a target buffer already exists", () => {
    const moving = store().register("sess_a", "src/a.ts", "moving");
    store().register("sess_a", "src/b.ts", "other");
    const target = store().register("sess_a", "dst/a.ts", "target");
    store().update(target, "dirty target");
    const before = store().buffers;
    expect(store().renamePath("sess_a", "src", "dst")).toBe(false);
    expect(store().buffers).toBe(before);
    expect(store().buffers[moving]).toBeDefined();
    expect(store().buffers[target].content).toBe("dirty target");
  });

  it("renamePath keeps the refs of each moved buffer", () => {
    const key = store().register("sess_a", "a.ts", "a");
    store().register("sess_a", "a.ts", "a");
    expect(store().renamePath("sess_a", "a.ts", "b.ts")).toBe(true);
    expect(store().buffers[bufferKey("sess_a", "b.ts")]).toMatchObject({ refs: 2, path: "b.ts" });
    expect(store().buffers[key]).toBeUndefined();
  });

  it("renamePath allows a case-only rename of the same buffer", () => {
    store().register("sess_a", "readme.md", "a");
    expect(store().renamePath("sess_a", "readme.md", "README.md")).toBe(true);
    expect(store().buffers[bufferKey("sess_a", "README.md")]).toMatchObject({ path: "README.md" });
  });

  it("reloadClean keeps mtime, readOnly and refs, clears missing and conflict, and applies a new mtime", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10, readOnly: true });
    store().markMissing(key);
    expect(store().reloadClean(key, "v2")).toBe(true);
    expect(store().buffers[key]).toMatchObject({ saved: "v2", content: "v2", mtimeMs: 10, readOnly: true, refs: 1 });
    expect(store().buffers[key].missing).toBeUndefined();
    store().reloadClean(key, "v3", 40);
    expect(store().buffers[key]).toMatchObject({ saved: "v3", mtimeMs: 40, readOnly: true });
  });

  it("discard adopts the conflicting disk content and clears the conflict", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().update(key, "mine");
    store().applyExternal(key, "theirs", 20);
    store().discard(key);
    expect(store().buffers[key]).toMatchObject({ saved: "theirs", content: "theirs", mtimeMs: 20 });
    expect(store().buffers[key].conflict).toBeFalsy();
    expect(store().dirty()).toEqual([]);
  });

  it("keeps the conflict when edits return to the saved text", () => {
    const key = store().register("sess_a", "x.ts", "v1", { mtimeMs: 10 });
    store().update(key, "mine");
    store().applyExternal(key, "theirs", 20);
    store().update(key, "v1");
    expect(store().buffers[key].conflict).toEqual({ content: "theirs", mtimeMs: 20 });
  });

  it("finds buffers for the given sessions and paths", () => {
    const a = store().register("sess_a", "src/a.ts", "a");
    store().register("sess_a", "src/other.ts", "o");
    const b = store().register("sess_b", "src/a.ts", "b");
    store().register("sess_c", "src/a.ts", "c");
    const found = buffersForPaths(store().buffers, ["sess_a", "sess_b"], ["src/a.ts"]).map((match) => match.key).sort();
    expect(found).toEqual([a, b].sort());
    expect(isDirtyBuffer(store().buffers[a])).toBe(false);
    store().update(a, "edited");
    expect(isDirtyBuffer(store().buffers[a])).toBe(true);
  });
});

describe("applyExternal ordering", () => {
  it("ignores a read older than the buffer's last known disk state", () => {
    const store = useEditorBuffers.getState();
    const key = store.register("order", "a.ts", "v2", { mtimeMs: 200 });
    expect(useEditorBuffers.getState().applyExternal(key, "v1", 100)).toBe("unchanged");
    expect(useEditorBuffers.getState().buffers[key]).toMatchObject({ saved: "v2", content: "v2", mtimeMs: 200 });
    expect(useEditorBuffers.getState().applyExternal(key, "v3", 300)).toBe("reloaded");
    expect(useEditorBuffers.getState().buffers[key]).toMatchObject({ saved: "v3", mtimeMs: 300 });
  });

  it("updates read-only without touching content", () => {
    const store = useEditorBuffers.getState();
    const key = store.register("order", "b.ts", "x");
    useEditorBuffers.getState().setReadOnly(key, true);
    expect(useEditorBuffers.getState().buffers[key]).toMatchObject({ readOnly: true, content: "x" });
  });
});
