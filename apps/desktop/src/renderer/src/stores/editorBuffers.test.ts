import { beforeEach, describe, expect, it } from "vitest";
import { bufferKey, useEditorBuffers } from "./editorBuffers.js";

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
    expect(store().buffers).toEqual({});
  });
});
