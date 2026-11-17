import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerApp } from "../app/ServerApp.js";
import type { PreferencesStore } from "../prefs/PreferencesStore.js";
import { Router, type CallContext } from "../transport/Router.js";
import { registerPrefsHandlers } from "./prefs.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };

let calls: unknown[][];
let router: Router;

beforeEach(() => {
  calls = [];
  const preferences = {
    importLegacy: (legacy: unknown) => {
      calls.push(["importLegacy", legacy]);
      return ["recentModels"];
    },
    pushRecentModel: (driver: string, model: string) => calls.push(["pushRecentModel", driver, model]),
    setDraft: (key: string, text: string, attachments: string[], quotes: string[], pastes: string[]) =>
      calls.push(["setDraft", key, text, attachments, quotes, pastes])
  } as unknown as PreferencesStore;
  router = new Router();
  registerPrefsHandlers(router, { requireServices: () => ({ preferences }) } as unknown as ServerApp);
});

const dispatch = (method: string, params: unknown) => router.dispatch(method, params, ctx);

describe("prefs handlers", () => {
  test("importLegacy forwards a valid payload and returns the imported fields", async () => {
    const legacy = { sidebarOrder: { main: ["a"], resolved: [], pinned: [] }, recentModels: { claude: ["opus"] } };
    expect(await dispatch("prefs.importLegacy", legacy)).toEqual({ imported: ["recentModels"] });
    expect(calls).toEqual([["importLegacy", legacy]]);
  });

  test("importLegacy rejects malformed payloads", async () => {
    const results = await Promise.allSettled([
      dispatch("prefs.importLegacy", null),
      dispatch("prefs.importLegacy", { sidebarOrder: { main: "a", resolved: [], pinned: [] } }),
      dispatch("prefs.importLegacy", { recentModels: { claude: [1] } })
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(calls).toEqual([]);
  });

  test("pushRecentModel validates the driver and model", async () => {
    await dispatch("prefs.pushRecentModel", { driver: "codex", model: "gpt-5" });
    const results = await Promise.allSettled([
      dispatch("prefs.pushRecentModel", { driver: "gemini", model: "x" }),
      dispatch("prefs.pushRecentModel", { driver: "codex", model: "x".repeat(201) }),
      dispatch("prefs.pushRecentModel", { driver: "codex" })
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(calls).toEqual([["pushRecentModel", "codex", "gpt-5"]]);
  });

  test("setDraft enforces key, text and attachment limits", async () => {
    await dispatch("prefs.setDraft", { key: "k", text: "t", attachments: ["a"] });
    await dispatch("prefs.setDraft", { key: "k".repeat(200), text: "x".repeat(200_000), attachments: Array(50).fill("a") });
    const results = await Promise.allSettled([
      dispatch("prefs.setDraft", { key: "", text: "t", attachments: [] }),
      dispatch("prefs.setDraft", { key: "k".repeat(201), text: "t", attachments: [] }),
      dispatch("prefs.setDraft", { key: "k", text: "x".repeat(200_001), attachments: [] }),
      dispatch("prefs.setDraft", { key: "k", text: "t", attachments: Array(51).fill("a") }),
      dispatch("prefs.setDraft", { key: "k", text: "t", attachments: [1] }),
      dispatch("prefs.setDraft", { key: "k", text: 5, attachments: [] })
    ]);
    expect(results.map((result) => result.status)).toEqual(Array(6).fill("rejected"));
    expect(calls).toHaveLength(2);
  });

  test("setDraft accepts optional quotes within limits", async () => {
    await dispatch("prefs.setDraft", { key: "k", text: "", attachments: [], quotes: ["a"] });
    await dispatch("prefs.setDraft", { key: "k", text: "t", attachments: [] });
    const results = await Promise.allSettled([
      dispatch("prefs.setDraft", { key: "k", text: "t", attachments: [], quotes: Array(21).fill("q") }),
      dispatch("prefs.setDraft", { key: "k", text: "t", attachments: [], quotes: ["x".repeat(20_001)] }),
      dispatch("prefs.setDraft", { key: "k", text: "t", attachments: [], quotes: [3] })
    ]);
    expect(results.map((result) => result.status)).toEqual(Array(3).fill("rejected"));
    expect(calls).toEqual([
      ["setDraft", "k", "", [], ["a"], []],
      ["setDraft", "k", "t", [], [], []]
    ]);
  });

  test("setDraft accepts optional pastes within limits", async () => {
    await dispatch("prefs.setDraft", { key: "k", text: "", attachments: [], pastes: ["x".repeat(200_000)] });
    const results = await Promise.allSettled([
      dispatch("prefs.setDraft", { key: "k", text: "t", attachments: [], pastes: Array(11).fill("p") }),
      dispatch("prefs.setDraft", { key: "k", text: "t", attachments: [], pastes: ["x".repeat(200_001)] }),
      dispatch("prefs.setDraft", { key: "k", text: "t", attachments: [], pastes: [false] })
    ]);
    expect(results.map((result) => result.status)).toEqual(Array(3).fill("rejected"));
    expect(calls).toEqual([["setDraft", "k", "", [], [], ["x".repeat(200_000)]]]);
  });
});
