import { describe, expect, test } from "bun:test";
import type { TopicPatch } from "@cw-code/contracts";
import { TopicStore } from "./TopicStore.js";

interface Entry {
  name: string;
  body: string;
}

type Data = Record<string, Entry>;

function storeWith(initial: Data = {}, startRev = 1) {
  const patches: TopicPatch[] = [];
  const store = new TopicStore<Data>("t", initial, startRev, (patch) => patches.push(patch));
  return { store, patches };
}

describe("TopicStore", () => {
  test("starts one rev before startRev and snapshots the current data", () => {
    const { store } = storeWith({ a: { name: "a", body: "" } }, 6);
    expect(store.rev).toBe(5);
    expect(store.snapshot()).toEqual({ rev: 5, data: { a: { name: "a", body: "" } } });
  });

  test("upsert publishes an upsert op with the next rev", () => {
    const { store, patches } = storeWith();
    store.upsert("a", { name: "a", body: "x" });
    expect(patches).toEqual([{ topic: "t", rev: 1, ops: [{ op: "upsert", key: "a", value: { name: "a", body: "x" } }] }]);
    expect(store.get("a")).toEqual({ name: "a", body: "x" });
    expect(store.rev).toBe(1);
  });

  test("a JSON-equal upsert is a no-op", () => {
    const { store, patches } = storeWith({ a: { name: "a", body: "x" } });
    store.upsert("a", { name: "a", body: "x" });
    expect(patches).toEqual([]);
    expect(store.rev).toBe(0);
  });

  test("remove publishes once and ignores a missing key", () => {
    const { store, patches } = storeWith({ a: { name: "a", body: "x" } });
    store.remove("missing");
    store.remove("a");
    store.remove("a");
    expect(patches).toEqual([{ topic: "t", rev: 1, ops: [{ op: "remove", key: "a" }] }]);
    expect(store.keys()).toEqual([]);
  });

  test("append grows a string field and publishes the appended text", () => {
    const { store, patches } = storeWith({ a: { name: "a", body: "he" } });
    store.append("a", "body", "llo");
    expect(store.get("a")).toEqual({ name: "a", body: "hello" });
    expect(patches).toEqual([{ topic: "t", rev: 1, ops: [{ op: "append", key: "a", field: "body", text: "llo" }] }]);
  });

  test("append rejects a missing entry or a non-string field without publishing", () => {
    const { store, patches } = storeWith({ a: { name: "a", body: "" } });
    expect(() => store.append("missing", "body", "x")).toThrow("missing entry");
    expect(() => store.append("a", "absent", "x")).toThrow("not a string");
    expect(patches).toEqual([]);
  });

  test("replace swaps the whole data in one op", () => {
    const { store, patches } = storeWith({ a: { name: "a", body: "" } });
    store.replace({ b: { name: "b", body: "" } });
    expect(store.keys()).toEqual(["b"]);
    expect(patches).toEqual([{ topic: "t", rev: 1, ops: [{ op: "replace", value: { b: { name: "b", body: "" } } }] }]);
  });

  test("sync diffs top-level keys into one patch of remove and upsert ops", () => {
    const { store, patches } = storeWith({ a: { name: "a", body: "" }, b: { name: "b", body: "" }, c: { name: "c", body: "" } });
    store.sync({ b: { name: "b", body: "" }, c: { name: "c", body: "changed" }, d: { name: "d", body: "" } });
    expect(patches).toEqual([
      {
        topic: "t",
        rev: 1,
        ops: [
          { op: "remove", key: "a" },
          { op: "upsert", key: "c", value: { name: "c", body: "changed" } },
          { op: "upsert", key: "d", value: { name: "d", body: "" } }
        ]
      }
    ]);
  });

  test("sync with identical data publishes nothing", () => {
    const { store, patches } = storeWith({ a: { name: "a", body: "" } });
    store.sync({ a: { name: "a", body: "" } });
    expect(patches).toEqual([]);
    expect(store.rev).toBe(0);
  });

  test("batch emits one patch with one rev, and nothing when no op changed state", () => {
    const { store, patches } = storeWith({ a: { name: "a", body: "" } });
    store.batch(() => {
      store.upsert("b", { name: "b", body: "" });
      store.remove("a");
      store.batch(() => store.upsert("c", { name: "c", body: "" }));
    });
    store.batch(() => store.upsert("b", { name: "b", body: "" }));
    expect(patches).toHaveLength(1);
    expect(patches[0]?.rev).toBe(1);
    expect(patches[0]?.ops.map((op) => op.op)).toEqual(["upsert", "remove", "upsert"]);
    expect(store.rev).toBe(1);
  });

  test("batch publishes the ops applied before a throw", () => {
    const { store, patches } = storeWith();
    expect(() =>
      store.batch(() => {
        store.upsert("a", { name: "a", body: "" });
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(patches).toHaveLength(1);
    store.upsert("b", { name: "b", body: "" });
    expect(patches[1]?.rev).toBe(2);
  });

  test("publishes synchronously inside the mutation call", () => {
    const { store, patches } = storeWith();
    store.upsert("a", { name: "a", body: "" });
    expect(patches).toHaveLength(1);
  });

  test("keys filters by prefix", () => {
    const { store } = storeWith({ "row/1": { name: "1", body: "" }, "row/2": { name: "2", body: "" }, other: { name: "o", body: "" } });
    expect(store.keys("row/")).toEqual(["row/1", "row/2"]);
  });
});
