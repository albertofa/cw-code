import { describe, expect, it } from "vitest";
import {
  EMPTY_FILE_TABS,
  MAX_PERSISTED_SESSIONS,
  MAX_TABS_PER_SESSION,
  closeAll,
  closeOthers,
  closeTab,
  closeToRight,
  openTab,
  parseExpanded,
  parseFileTabs,
  pinTab,
  removeTabs,
  renameTabs,
  serializeExpanded,
  serializeFileTabs,
  useFileTabs,
  type FileTabsState
} from "./fileTabs.js";

const state = (paths: string[], active: string | null, previews: string[] = []): FileTabsState => ({
  tabs: paths.map((path) => ({ path, preview: previews.includes(path) })),
  active
});
const paths = (value: FileTabsState): string[] => value.tabs.map((tab) => tab.path);

describe("openTab", () => {
  it("opens a first tab and activates it", () => {
    expect(openTab(EMPTY_FILE_TABS, "a", false)).toEqual(state(["a"], "a"));
    expect(openTab(EMPTY_FILE_TABS, "a", true)).toEqual(state(["a"], "a", ["a"]));
  });

  it("inserts new tabs after the active tab", () => {
    const next = openTab(state(["a", "b", "c"], "a"), "d", false);
    expect(paths(next)).toEqual(["a", "d", "b", "c"]);
    expect(next.active).toBe("d");
  });

  it("replaces the preview tab in place on another preview open", () => {
    const next = openTab(state(["a", "p", "c"], "c", ["p"]), "q", true);
    expect(paths(next)).toEqual(["a", "q", "c"]);
    expect(next.tabs[1].preview).toBe(true);
    expect(next.active).toBe("q");
  });

  it("inserts a preview after the active tab when no preview exists", () => {
    expect(paths(openTab(state(["a", "b"], "a"), "p", true))).toEqual(["a", "p", "b"]);
  });

  it("does not replace a pinned tab with a preview open", () => {
    expect(paths(openTab(state(["a"], "a"), "p", true))).toEqual(["a", "p"]);
  });

  it("activates an already open tab and pins it on a non-preview open", () => {
    const base = state(["a", "p"], "a", ["p"]);
    expect(openTab(base, "p", true)).toEqual({ tabs: base.tabs, active: "p" });
    const pinned = openTab(base, "p", false);
    expect(pinned.tabs[1]).toEqual({ path: "p", preview: false });
    expect(pinned.active).toBe("p");
  });

  it("returns the same state when nothing changes", () => {
    const base = state(["a"], "a");
    expect(openTab(base, "a", false)).toBe(base);
  });
});

describe("pinTab", () => {
  it("pins a preview tab and ignores others", () => {
    const base = state(["a", "p"], "p", ["p"]);
    expect(pinTab(base, "p").tabs[1].preview).toBe(false);
    expect(pinTab(base, "a")).toBe(base);
    expect(pinTab(base, "zzz")).toBe(base);
  });
});

describe("closing", () => {
  it("activates the right neighbour, else the left", () => {
    expect(closeTab(state(["a", "b", "c"], "b"), "b").active).toBe("c");
    expect(closeTab(state(["a", "b", "c"], "c"), "c").active).toBe("b");
    expect(closeTab(state(["a"], "a"), "a")).toEqual(EMPTY_FILE_TABS);
  });

  it("keeps the active tab when closing another one", () => {
    const next = closeTab(state(["a", "b", "c"], "c"), "a");
    expect(paths(next)).toEqual(["b", "c"]);
    expect(next.active).toBe("c");
  });

  it("ignores unknown paths", () => {
    const base = state(["a"], "a");
    expect(closeTab(base, "x")).toBe(base);
    expect(closeOthers(base, "x")).toBe(base);
    expect(closeToRight(base, "x")).toBe(base);
  });

  it("closes others and activates the survivor", () => {
    expect(closeOthers(state(["a", "b", "c"], "a"), "b")).toEqual(state(["b"], "b"));
  });

  it("closes tabs to the right and keeps the active tab when it survives", () => {
    expect(closeToRight(state(["a", "b", "c", "d"], "a"), "b")).toEqual(state(["a", "b"], "a"));
    expect(closeToRight(state(["a", "b", "c", "d"], "d"), "b")).toEqual(state(["a", "b"], "b"));
  });

  it("closes everything", () => {
    expect(closeAll(state(["a", "b"], "a"))).toEqual(EMPTY_FILE_TABS);
    expect(closeAll(EMPTY_FILE_TABS)).toBe(EMPTY_FILE_TABS);
  });
});

describe("renameTabs and removeTabs", () => {
  it("renames a file tab and the active pointer", () => {
    expect(renameTabs(state(["a", "b"], "b", ["b"]), "b", "c")).toEqual(state(["a", "c"], "c", ["c"]));
  });

  it("renames every tab inside a renamed directory", () => {
    const next = renameTabs(state(["src/a.ts", "src/lib/b.ts", "srcx/c.ts", "d.ts"], "src/lib/b.ts"), "src", "lib");
    expect(paths(next)).toEqual(["lib/a.ts", "lib/lib/b.ts", "srcx/c.ts", "d.ts"]);
    expect(next.active).toBe("lib/lib/b.ts");
  });

  it("merges a rename that collides with an open tab", () => {
    const next = renameTabs(state(["a", "b"], "a"), "a", "b");
    expect(paths(next)).toEqual(["b"]);
    expect(next.active).toBe("b");
  });

  it("leaves unrelated state untouched", () => {
    const base = state(["a"], "a");
    expect(renameTabs(base, "x", "y")).toBe(base);
  });

  it("removes a path and its descendants", () => {
    const next = removeTabs(state(["src/a.ts", "src/lib/b.ts", "srcx/c.ts", "d.ts"], "src/lib/b.ts"), "src");
    expect(paths(next)).toEqual(["srcx/c.ts", "d.ts"]);
    expect(next.active).toBe("srcx/c.ts");
  });

  it("removes a single file tab", () => {
    expect(removeTabs(state(["a", "b"], "a"), "a")).toEqual(state(["b"], "b"));
  });
});

describe("persistence", () => {
  it("round-trips tab state", () => {
    const original = { s1: state(["a", "b"], "b", ["b"]) };
    expect(parseFileTabs(serializeFileTabs(original))).toEqual(original);
  });

  it("parses defensively", () => {
    expect(parseFileTabs(null)).toEqual({});
    expect(parseFileTabs("not json")).toEqual({});
    expect(parseFileTabs("[]")).toEqual({});
    expect(parseFileTabs(JSON.stringify({ s1: "x", s2: { tabs: "x" }, s3: { tabs: [] } }))).toEqual({});
    const messy = JSON.stringify({
      s1: { tabs: [{ path: "a" }, { path: 1 }, null, { path: "a", preview: true }, { path: "b", preview: "yes" }], active: "gone" }
    });
    expect(parseFileTabs(messy)).toEqual({ s1: state(["a", "b"], "a") });
  });

  it("normalizes persisted tabs to a single preview tab, preferring the active one", () => {
    const raw = JSON.stringify({
      s1: { tabs: [{ path: "a", preview: true }, { path: "b", preview: true }, { path: "c" }], active: "b" },
      s2: { tabs: [{ path: "a", preview: true }, { path: "b", preview: true }], active: "c" }
    });
    const parsed = parseFileTabs(raw);
    expect(parsed.s1).toEqual(state(["a", "b", "c"], "b", ["b"]));
    expect(parsed.s2).toEqual(state(["a", "b"], "a", ["a"]));
  });

  it("caps tabs per session around the active tab", () => {
    const many = Array.from({ length: 50 }, (_, index) => `f${index}`);
    const parsed = parseFileTabs(serializeFileTabs({ s: state(many, "f45") }));
    expect(parsed.s.tabs).toHaveLength(MAX_TABS_PER_SESSION);
    expect(parsed.s.active).toBe("f45");
    expect(paths(parsed.s)).toContain("f45");
  });

  it("drops the oldest sessions beyond the cap", () => {
    const bySession: Record<string, FileTabsState> = {};
    for (let index = 0; index < MAX_PERSISTED_SESSIONS + 5; index++) bySession[`s${index}`] = state(["a"], "a");
    const parsed = parseFileTabs(serializeFileTabs(bySession));
    expect(Object.keys(parsed)).toHaveLength(MAX_PERSISTED_SESSIONS);
    expect(parsed.s0).toBeUndefined();
    expect(parsed[`s${MAX_PERSISTED_SESSIONS + 4}`]).toBeDefined();
  });

  it("round-trips and sanitizes expanded directories", () => {
    expect(parseExpanded(serializeExpanded({ s: ["a", "a/b"], empty: [] }))).toEqual({ s: ["a", "a/b"] });
    expect(parseExpanded(null)).toEqual({});
    expect(parseExpanded("{")).toEqual({});
    expect(parseExpanded(JSON.stringify({ s: ["a", 1, "", "a"], t: "x" }))).toEqual({ s: ["a"] });
  });
});

describe("useFileTabs store", () => {
  it("runs in node without localStorage and keeps sessions independent", () => {
    useFileTabs.setState({ bySession: {}, expandedBySession: {} });
    const store = () => useFileTabs.getState();
    store().open("s1", "a.ts", true);
    store().open("s1", "b.ts", false);
    store().open("s2", "c.ts", false);
    expect(store().bySession.s1).toEqual(state(["a.ts", "b.ts"], "b.ts", ["a.ts"]));
    expect(store().bySession.s2).toEqual(state(["c.ts"], "c.ts"));
    store().pin("s1", "a.ts");
    store().rename("s1", "a.ts", "z.ts");
    store().close("s1", "b.ts");
    expect(store().bySession.s1).toEqual(state(["z.ts"], "z.ts"));
    store().setExpanded("s1", ["src", "src/lib"]);
    expect(store().expandedBySession.s1).toEqual(["src", "src/lib"]);
    store().closeAll("s1");
    expect(store().bySession.s1).toEqual(EMPTY_FILE_TABS);
  });
});
