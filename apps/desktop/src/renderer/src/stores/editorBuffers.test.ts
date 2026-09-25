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

  it("keeps a shared buffer and its edits until the last editor unregisters", () => {
    const key = store().register("sess_a", "x.ts", "v1");
    store().update(key, "edited");
    expect(store().register("sess_a", "x.ts", "v1-reloaded")).toBe(key);
    expect(store().buffers[key]).toMatchObject({ saved: "v1", content: "edited", refs: 2 });
    store().unregister(key);
    expect(store().dirty()).toHaveLength(1);
    store().unregister(key);
    expect(store().buffers[key]).toBeUndefined();
    expect(store().dirty()).toEqual([]);
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
