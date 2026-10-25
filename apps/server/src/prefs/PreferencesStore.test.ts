import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceTimersByTimeAsync } from "../../tests/testing.js";
import { MAX_DRAFTS, PreferencesStore, type PreferencesChange } from "./PreferencesStore.js";

let dir: string;
let file: string;
let warnings: string[];
let clock: number;

function open(): PreferencesStore {
  return new PreferencesStore(file, { warn: (message) => warnings.push(message), now: () => clock });
}

function stored(): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-prefs-test-"));
  file = join(dir, "preferences.json");
  warnings = [];
  clock = 1_000;
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("PreferencesStore", () => {
  test("starts empty without creating the file", () => {
    const store = open();
    expect(store.sidebarOrder()).toBeNull();
    expect(store.recentModels()).toEqual({ claude: [], opencode: [], codex: [] });
    expect(store.drafts()).toEqual({});
    expect(store.legacyImported()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  test("round trips every field through the file", () => {
    const store = open();
    store.setSidebarOrder({ main: ["a", "b"], resolved: ["c"], pinned: ["a"] });
    store.pushRecentModel("codex", "gpt-5");
    store.setDraft("session:1", "hello", ["/tmp/a.png"]);
    store.importLegacy({});
    store.dispose();
    expect(stored().version).toBe(1);

    const reopened = open();
    expect(reopened.sidebarOrder()).toEqual({ main: ["a", "b"], resolved: ["c"], pinned: ["a"] });
    expect(reopened.recentModels().codex).toEqual(["gpt-5"]);
    expect(reopened.drafts()).toEqual({ "session:1": { text: "hello", attachments: ["/tmp/a.png"], updatedAt: 1_000 } });
    expect(reopened.legacyImported()).toBe(true);
  });

  test("returned values are copies", () => {
    const store = open();
    store.setSidebarOrder({ main: ["a"], resolved: [], pinned: [] });
    store.sidebarOrder()?.main.push("x");
    store.recentModels().claude.push("x");
    expect(store.sidebarOrder()?.main).toEqual(["a"]);
    expect(store.recentModels().claude).toEqual([]);
  });

  describe("recent models", () => {
    test("keeps the three most recent, newest first, without duplicates", () => {
      const store = open();
      for (const model of ["m1", "m2", "m3", "m2", "m4"]) store.pushRecentModel("opencode", model);
      expect(store.recentModels().opencode).toEqual(["m4", "m2", "m3"]);
    });

    test("strips the claude context suffix only for claude", () => {
      const store = open();
      store.pushRecentModel("claude", "opus[1m]");
      store.pushRecentModel("claude", "OPUS[1M]");
      store.pushRecentModel("claude", "opus");
      store.pushRecentModel("codex", "model[1m]");
      expect(store.recentModels().claude).toEqual(["opus", "OPUS"]);
      expect(store.recentModels().codex).toEqual(["model[1m]"]);
    });

    test("ignores empty ids and re-pushing the newest id", () => {
      const store = open();
      const changes: PreferencesChange[] = [];
      store.onChanged((change) => changes.push(change));
      store.pushRecentModel("claude", "");
      store.pushRecentModel("claude", "[1m]");
      store.pushRecentModel("claude", "opus");
      store.pushRecentModel("claude", "opus[1m]");
      expect(changes).toEqual([{ kind: "recentModels", driver: "claude" }]);
    });
  });

  describe("drafts", () => {
    test("stamps updatedAt and replaces an existing draft", () => {
      const store = open();
      store.setDraft("k", "one", []);
      clock = 2_000;
      store.setDraft("k", "two", ["a"]);
      expect(store.drafts()).toEqual({ k: { text: "two", attachments: ["a"], updatedAt: 2_000 } });
    });

    test("an empty draft deletes its entry and tells listeners", () => {
      const store = open();
      const changes: PreferencesChange[] = [];
      store.setDraft("k", "text", []);
      store.onChanged((change) => changes.push(change));
      store.setDraft("k", "   ", []);
      store.setDraft("k", "", []);
      expect(store.drafts()).toEqual({});
      expect(changes).toEqual([{ kind: "draft", key: "k", draft: null }]);
    });

    test("a draft with only attachments is kept", () => {
      const store = open();
      store.setDraft("k", "", ["a"]);
      expect(Object.keys(store.drafts())).toEqual(["k"]);
    });

    test("caps at 50 drafts, dropping the oldest by updatedAt", () => {
      const store = open();
      const changes: PreferencesChange[] = [];
      for (let index = 0; index < MAX_DRAFTS; index += 1) {
        clock = 1_000 + index;
        store.setDraft(`k${index}`, "x", []);
      }
      clock = 1_000 + MAX_DRAFTS;
      store.setDraft("k0", "touched", []);
      store.onChanged((change) => changes.push(change));
      clock += 1;
      store.setDraft("fresh", "x", []);
      const keys = Object.keys(store.drafts());
      expect(keys).toHaveLength(MAX_DRAFTS);
      expect(keys).not.toContain("k1");
      expect(keys).toContain("k0");
      expect(keys).toContain("fresh");
      expect(changes).toContainEqual({ kind: "draft", key: "k1", draft: null });
    });

    test("does not rewrite an unchanged draft", () => {
      const store = open();
      const changes: PreferencesChange[] = [];
      store.setDraft("k", "x", ["a"]);
      store.onChanged((change) => changes.push(change));
      clock = 5_000;
      store.setDraft("k", "x", ["a"]);
      expect(changes).toEqual([]);
      expect(store.drafts().k?.updatedAt).toBe(1_000);
    });
  });

  describe("legacy import", () => {
    test("fills empty fields and reports what it imported", () => {
      const store = open();
      const imported = store.importLegacy({
        sidebarOrder: { main: ["a"], resolved: [], pinned: [] },
        recentModels: { claude: ["opus[1m]", "sonnet"] }
      });
      expect(imported).toEqual(["sidebarOrder", "recentModels"]);
      expect(store.sidebarOrder()).toEqual({ main: ["a"], resolved: [], pinned: [] });
      expect(store.recentModels().claude).toEqual(["opus", "sonnet"]);
      expect(store.legacyImported()).toBe(true);
    });

    test("does not overwrite a stored sidebar order and puts server models first", () => {
      const store = open();
      store.setSidebarOrder({ main: ["server"], resolved: [], pinned: [] });
      store.pushRecentModel("codex", "s1");
      store.pushRecentModel("codex", "s2");
      const imported = store.importLegacy({
        sidebarOrder: { main: ["legacy"], resolved: [], pinned: [] },
        recentModels: { codex: ["s2", "l1", "l2"] }
      });
      expect(imported).toEqual(["recentModels"]);
      expect(store.sidebarOrder()?.main).toEqual(["server"]);
      expect(store.recentModels().codex).toEqual(["s2", "s1", "l1"]);
    });

    test("reports nothing but still marks the import done when there is nothing to merge", () => {
      const store = open();
      expect(store.importLegacy({})).toEqual([]);
      expect(store.legacyImported()).toBe(true);
    });
  });

  describe("corrupt files", () => {
    test.each([
      ["invalid json", "{not json"],
      ["a non-object", "[1,2]"],
      ["an unknown version", JSON.stringify({ version: 2, recentModels: {} })]
    ])("quarantines %s and starts empty", (_label, content) => {
      writeFileSync(file, content);
      clock = 4_242;
      const store = open();
      expect(store.recentModels()).toEqual({ claude: [], opencode: [], codex: [] });
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(dir)).toEqual(["preferences.json.corrupt-4242"]);
      expect(readFileSync(join(dir, "preferences.json.corrupt-4242"), "utf8")).toBe(content);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("preferences.json.corrupt-4242");
      store.pushRecentModel("claude", "opus");
      expect(stored().recentModels).toMatchObject({ claude: ["opus"] });
    });

    test("drops malformed entries inside a valid file", () => {
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          sidebarOrder: "nope",
          recentModels: { claude: ["a", 3, "a[1m]", ""], codex: "x" },
          drafts: { good: { text: "t", attachments: ["a", 1], updatedAt: 5 }, bad: { text: 1 }, empty: { text: "", attachments: [], updatedAt: 1 } },
          legacyImported: "yes"
        })
      );
      const store = open();
      expect(store.sidebarOrder()).toBeNull();
      expect(store.recentModels()).toEqual({ claude: ["a"], opencode: [], codex: [] });
      expect(store.drafts()).toEqual({ good: { text: "t", attachments: ["a"], updatedAt: 5 } });
      expect(store.legacyImported()).toBe(false);
      expect(warnings).toEqual([]);
    });
  });

  describe("draft write coalescing", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    test("many draft edits within a second produce one write after the timer", async () => {
      const store = open();
      store.setDraft("k", "a", []);
      store.setDraft("k", "ab", []);
      store.setDraft("k", "abc", []);
      expect(existsSync(file)).toBe(false);
      await advanceTimersByTimeAsync(999);
      expect(existsSync(file)).toBe(false);
      await advanceTimersByTimeAsync(1);
      expect((stored().drafts as Record<string, { text: string }>).k?.text).toBe("abc");
    });

    test("a later burst schedules its own write", async () => {
      const store = open();
      store.setDraft("k", "a", []);
      await advanceTimersByTimeAsync(1_000);
      store.setDraft("k", "b", []);
      expect((stored().drafts as Record<string, { text: string }>).k?.text).toBe("a");
      await advanceTimersByTimeAsync(1_000);
      expect((stored().drafts as Record<string, { text: string }>).k?.text).toBe("b");
    });

    test("flush and dispose write pending drafts immediately", () => {
      const store = open();
      store.setDraft("k", "a", []);
      store.dispose();
      expect((stored().drafts as Record<string, { text: string }>).k?.text).toBe("a");
    });

    test("a non-draft write also persists pending drafts and cancels the timer", async () => {
      const store = open();
      store.setDraft("k", "a", []);
      store.pushRecentModel("claude", "opus");
      expect((stored().drafts as Record<string, { text: string }>).k?.text).toBe("a");
      writeFileSync(file, "sentinel");
      await advanceTimersByTimeAsync(5_000);
      expect(readFileSync(file, "utf8")).toBe("sentinel");
    });

    test("deleting a draft is persisted by the timer", async () => {
      const store = open();
      store.setDraft("k", "a", []);
      store.flush();
      store.setDraft("k", "", []);
      await advanceTimersByTimeAsync(1_000);
      expect(stored().drafts).toEqual({});
    });
  });
});
