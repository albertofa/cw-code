// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { DockableTabId } from "@cw-code/contracts";
import {
  DEFAULT_AUTO,
  PANEL_LAYOUT_KEY,
  PANEL_STATE_KEY,
  clampBottomHeight,
  clampSplitRatio,
  defaultLayout,
  defaultSessionPanel,
  isBottomOpen,
  parseLayout,
  parsePanelState,
  pickSplitTool,
  resolveMainTab,
  resolveRightTop,
  resolveSplitDrop,
  rightOpenTabs,
  sanitizeLayout,
  sanitizeSessionPanel,
  serializeLayout,
  serializePanelState,
  tabsInPanel
} from "./panelLayout.js";
import { selectSessionPanel, usePanelStore } from "./panelStore.js";
import { toolAvailability } from "../components/toolTabs.js";

describe("tabsInPanel", () => {
  it("starts with every tab closed", () => {
    const layout = defaultLayout();
    expect(tabsInPanel(layout.dockByTab, "main")).toEqual([]);
    expect(tabsInPanel(layout.dockByTab, "bottom")).toEqual([]);
    expect(tabsInPanel(layout.dockByTab, "right")).toEqual([]);
  });
});

describe("isBottomOpen", () => {
  it("is open only while a tab is docked to the bottom", () => {
    const layout = defaultLayout();
    expect(isBottomOpen(layout.dockByTab)).toBe(false);
    expect(isBottomOpen({ ...layout.dockByTab, shell: "bottom" })).toBe(true);
  });
});

describe("clampBottomHeight", () => {
  it("clamps to the resizable range and falls back for garbage", () => {
    expect(clampBottomHeight(300)).toBe(300);
    expect(clampBottomHeight(10)).toBe(140);
    expect(clampBottomHeight(9999)).toBe(520);
    expect(clampBottomHeight("tall")).toBe(260);
    expect(clampBottomHeight(Number.NaN)).toBe(260);
  });
});

describe("sanitizeLayout", () => {
  it("falls back to defaults for non-objects", () => {
    expect(sanitizeLayout(null)).toEqual(defaultLayout());
    expect(sanitizeLayout("nope")).toEqual(defaultLayout());
    expect(sanitizeLayout(undefined)).toEqual(defaultLayout());
  });

  it("drops unknown tabs and pins chat first in mainOrder", () => {
    const clean = sanitizeLayout({
      dockByTab: { files: "bottom", bogus: "main", shell: "left" },
      mainOrder: ["files", "chat", "chat", "bogus"],
      activeMain: "files",
      bottomHeight: 200
    });
    expect(clean.dockByTab.files).toBe("bottom");
    expect(clean.dockByTab.shell).toBe("closed");
    expect(clean.mainOrder[0]).toBe("chat");
    expect(clean.mainOrder).not.toContain("bogus");
    expect(clean.bottomHeight).toBe(200);
  });

  it("keeps closed tabs and drops them from mainOrder", () => {
    const clean = sanitizeLayout({
      dockByTab: { files: "closed", diff: "main" },
      mainOrder: ["chat", "files", "diff"],
      activeMain: "files",
      bottomHeight: 200
    });
    expect(clean.dockByTab.files).toBe("closed");
    expect(clean.mainOrder).toEqual(["chat", "diff"]);
    expect(clean.activeMain).toBe("chat");
    expect(clean.bottomHeight).toBe(200);
  });

  it("defaults the overview tab to closed, auto-located right and first in dock order", () => {
    expect(defaultLayout().dockByTab.overview).toBe("closed");
    expect(defaultLayout().autoLocation.overview).toBe("right");
    const clean = sanitizeLayout({ dockByTab: { overview: "right", files: "right" } });
    expect(tabsInPanel(clean.dockByTab, "right")).toEqual(["overview", "files"]);
    expect(sanitizeLayout({ dockByTab: { overview: "elsewhere" } }).dockByTab.overview).toBe("closed");
  });

  it("sanitizes a persisted layout without an overview key to closed with the auto default", () => {
    const clean = sanitizeLayout({
      dockByTab: { files: "right", shell: "bottom" },
      autoLocation: { files: "main" },
      mainOrder: ["chat"]
    });
    expect(clean.dockByTab.overview).toBe("closed");
    expect(clean.autoLocation.overview).toBe(DEFAULT_AUTO.overview);
    expect(clean.autoLocation.files).toBe("main");
  });

  it("keeps a persisted PR tab placement and defaults it to closed", () => {
    expect(defaultLayout().dockByTab.pr).toBe("closed");
    expect(defaultLayout().autoLocation.pr).toBe("right");
    const clean = sanitizeLayout({
      dockByTab: { pr: "main" },
      autoLocation: { pr: "bottom" },
      mainOrder: ["chat", "pr"],
      activeMain: "pr"
    });
    expect(clean.dockByTab.pr).toBe("main");
    expect(clean.autoLocation.pr).toBe("bottom");
    expect(clean.mainOrder).toEqual(["chat", "pr"]);
    expect(clean.activeMain).toBe("pr");
    expect(sanitizeLayout({ dockByTab: { files: "right" } }).dockByTab.pr).toBe("closed");
  });

  it("repairs actives that point outside their panel", () => {
    const clean = sanitizeLayout({
      dockByTab: { files: "right", agents: "right", shell: "right" },
      activeMain: "files",
      activeRight: "shell",
      activeBottom: "shell"
    });
    expect(clean.activeMain).toBe("chat");
    expect(clean.activeRight).toBe("shell");
    expect(clean.activeBottom).toBe("shell");
  });
});

describe("right split sanitizing", () => {
  const docked = { files: "right", agents: "right", shell: "right" } as const;

  it("defaults to no split at an even ratio", () => {
    expect(defaultLayout()).toMatchObject({ rightSplit: null, rightSplitRatio: 0.5 });
    expect(defaultSessionPanel()).toMatchObject({ rightSplit: null, rightSplitRatio: 0.5 });
    expect(sanitizeLayout({})).toMatchObject({ rightSplit: null, rightSplitRatio: 0.5 });
  });

  it("keeps a split tool docked right that differs from the active one", () => {
    const clean = sanitizeLayout({ dockByTab: docked, activeRight: "files", rightSplit: "shell" });
    expect(clean.rightSplit).toBe("shell");
  });

  it("drops an unknown split tab", () => {
    expect(sanitizeLayout({ dockByTab: docked, activeRight: "files", rightSplit: "nope" }).rightSplit).toBeNull();
    expect(sanitizeLayout({ dockByTab: docked, activeRight: "files", rightSplit: 7 }).rightSplit).toBeNull();
  });

  it("drops a split tool that is not docked right", () => {
    const clean = sanitizeLayout({
      dockByTab: { ...docked, shell: "bottom" },
      activeRight: "files",
      rightSplit: "shell"
    });
    expect(clean.rightSplit).toBeNull();
    expect(sanitizeLayout({ dockByTab: docked, activeRight: "files", rightSplit: "diff" }).rightSplit).toBeNull();
  });

  it("drops a split tool equal to the active right tool", () => {
    expect(sanitizeLayout({ dockByTab: docked, activeRight: "shell", rightSplit: "shell" }).rightSplit).toBeNull();
  });

  it("clamps the split ratio to 0.25-0.75 and falls back for garbage", () => {
    expect(clampSplitRatio(0.6)).toBe(0.6);
    expect(clampSplitRatio(0.1)).toBe(0.25);
    expect(clampSplitRatio(0.95)).toBe(0.75);
    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
    expect(clampSplitRatio("wide")).toBe(0.5);
    expect(sanitizeSessionPanel({ rightSplitRatio: 3 }).rightSplitRatio).toBe(0.75);
  });

  it("round-trips a split through a session state", () => {
    const panel = sanitizeSessionPanel({
      dockByTab: docked,
      activeRight: "files",
      rightSplit: "agents",
      rightSplitRatio: 0.4
    });
    const parsed = parsePanelState(serializePanelState({ autoLocation: { ...DEFAULT_AUTO }, sessions: { sess_a: panel } }), null);
    expect(parsed.sessions.sess_a).toMatchObject({ rightSplit: "agents", rightSplitRatio: 0.4, activeRight: "files" });
  });
});

describe("serialize/parse round-trip", () => {
  it("preserves a customized legacy layout and rejects corrupt payloads", () => {
    const layout = defaultLayout();
    layout.dockByTab.files = "main";
    layout.dockByTab.diff = "main";
    layout.mainOrder = ["chat", "files", "diff"];
    layout.activeMain = "diff";
    const parsed = parseLayout(serializeLayout(layout));
    expect(parsed).toEqual({ ...layout, dockByTab: { ...layout.dockByTab } });
    expect(parseLayout("{oops}")).toEqual(defaultLayout());
    expect(parseLayout(null)).toEqual(defaultLayout());
  });

  it("round-trips independent session states and global auto locations", () => {
    const first = {
      ...defaultSessionPanel(),
      dockByTab: { ...defaultSessionPanel().dockByTab, shell: "bottom" as const },
      activeBottom: "shell" as const,
      rightVisible: false
    };
    const second = {
      ...defaultSessionPanel(),
      dockByTab: { ...defaultSessionPanel().dockByTab, files: "right" as const },
      activeRight: "files" as const,
      bottomCollapsed: true
    };
    const state = {
      autoLocation: { ...DEFAULT_AUTO, agents: "main" as const },
      sessions: { sess_a: first, sess_b: second }
    };
    const parsed = parsePanelState(serializePanelState(state), null);
    expect(parsed.sessions).toEqual(state.sessions);
    expect(parsed.autoLocation).toEqual(state.autoLocation);
    expect(parsed.legacySession).toBeNull();
  });

  it("sanitizes persisted sessions before they enter the store", () => {
    const parsed = parsePanelState(
      JSON.stringify({
        autoLocation: { agents: "nowhere" },
        sessions: {
          sess_a: {
            dockByTab: { files: "right", diff: "main", shell: "invalid" },
            mainOrder: ["diff", "chat"],
            activeMain: "diff",
            activeRight: "files",
            rightVisible: "yes",
            bottomCollapsed: true
          }
        }
      }),
      null
    );
    const session = parsed.sessions.sess_a;
    expect(parsed.autoLocation.agents).toBe("right");
    expect(session.dockByTab.shell).toBe("closed");
    expect(session.mainOrder).toEqual(["chat", "diff"]);
    expect(session.activeMain).toBe("diff");
    expect(session.activeRight).toBe("files");
    expect(session.rightVisible).toBe(true);
    expect(session.bottomCollapsed).toBe(true);
  });

  it("keeps a legacy layout unclaimed for the first selected session", () => {
    const legacy = defaultLayout();
    legacy.dockByTab.shell = "bottom";
    legacy.activeBottom = "shell";
    const loaded = parsePanelState(null, serializeLayout(legacy));
    expect(loaded.sessions).toEqual({});
    expect(loaded.legacySession?.dockByTab.shell).toBe("bottom");
    expect(loaded.legacySession?.activeBottom).toBe("shell");
  });
});

describe("usePanelStore routing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePanelStore.setState({
      autoLocation: { ...DEFAULT_AUTO },
      sessions: {},
      legacySession: null,
      draggingTab: null
    });
  });

  it("moveTab docks, activates, and persists for the selected session", () => {
    usePanelStore.getState().moveTab("sess_a", "diff", "main");
    const state = usePanelStore.getState();
    expect(selectSessionPanel(state, "sess_a").dockByTab.diff).toBe("main");
    expect(selectSessionPanel(state, "sess_a").activeMain).toBe("diff");
    expect(selectSessionPanel(state, "sess_a").mainOrder).toContain("diff");
    const stored = window.localStorage.getItem(PANEL_STATE_KEY);
    expect(stored).toContain('"sess_a"');
    expect(stored).toContain('"diff":"main"');
  });

  it("keeps opened tools and panel state independent between sessions", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "shell", "bottom");
    store.setBottomHeight("sess_a", 333);
    store.setRightVisible("sess_a", false);
    store.activateOrOpen("sess_b", "files");

    const state = usePanelStore.getState();
    expect(selectSessionPanel(state, "sess_a").dockByTab.shell).toBe("bottom");
    expect(selectSessionPanel(state, "sess_a").bottomHeight).toBe(333);
    expect(selectSessionPanel(state, "sess_a").rightVisible).toBe(false);
    expect(selectSessionPanel(state, "sess_b").dockByTab.shell).toBe("closed");
    expect(selectSessionPanel(state, "sess_b").dockByTab.files).toBe("main");
    expect(selectSessionPanel(state, "sess_b").rightVisible).toBe(true);
  });

  it("restores independent active tabs, collapse state, and closed tools", () => {
    const store = usePanelStore.getState();
    store.activateOrOpen("sess_a", "shell");
    store.activateOrOpen("sess_b", "files");
    store.setActive("sess_a", "bottom", "shell");
    store.setActive("sess_b", "main", "files");
    store.setBottomCollapsed("sess_a", true);

    const beforeClose = usePanelStore.getState();
    expect(selectSessionPanel(beforeClose, "sess_a").activeBottom).toBe("shell");
    expect(selectSessionPanel(beforeClose, "sess_a").bottomCollapsed).toBe(true);
    expect(selectSessionPanel(beforeClose, "sess_b").activeMain).toBe("files");
    expect(selectSessionPanel(beforeClose, "sess_b").bottomCollapsed).toBe(false);

    store.moveTab("sess_a", "shell", "closed");
    const afterClose = usePanelStore.getState();
    expect(selectSessionPanel(afterClose, "sess_a").dockByTab.shell).toBe("closed");
    expect(selectSessionPanel(afterClose, "sess_b").dockByTab.files).toBe("main");
    expect(selectSessionPanel(afterClose, "sess_b").activeMain).toBe("files");
  });

  it("activateOrOpen routes a rail click to the global auto location", () => {
    usePanelStore.getState().setAutoLocation("agents", "bottom");
    usePanelStore.getState().activateOrOpen("sess_a", "agents");
    const state = selectSessionPanel(usePanelStore.getState(), "sess_a");
    expect(state.dockByTab.agents).toBe("bottom");
    expect(state.activeBottom).toBe("agents");
  });

  it("activateOrOpen focuses open tabs where they are instead of moving them", () => {
    usePanelStore.getState().moveTab("sess_a", "diff", "main");
    usePanelStore.getState().setAutoLocation("diff", "bottom");
    usePanelStore.getState().activateOrOpen("sess_a", "diff");
    const state = usePanelStore.getState();
    expect(selectSessionPanel(state, "sess_a").dockByTab.diff).toBe("main");
    expect(selectSessionPanel(state, "sess_a").activeMain).toBe("diff");
  });

  it("setActive ignores tabs that are not in the panel", () => {
    usePanelStore.getState().setActive("sess_a", "bottom", "diff");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").activeBottom).toBe("shell");
    usePanelStore.getState().setActive("sess_a", "main", "chat");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").activeMain).toBe("chat");
  });

  it("moveTab closes tabs and falls back to chat", () => {
    usePanelStore.getState().moveTab("sess_a", "diff", "main");
    usePanelStore.getState().moveTab("sess_a", "diff", "closed");
    const state = selectSessionPanel(usePanelStore.getState(), "sess_a");
    expect(state.dockByTab.diff).toBe("closed");
    expect(state.activeMain).toBe("chat");
    expect(state.mainOrder).toEqual(["chat"]);
  });

  it("resets only the selected session", () => {
    usePanelStore.getState().moveTab("sess_a", "files", "right");
    usePanelStore.getState().moveTab("sess_a", "shell", "bottom");
    usePanelStore.getState().moveTab("sess_b", "diff", "right");
    usePanelStore.getState().resetLayout("sess_a");
    const first = selectSessionPanel(usePanelStore.getState(), "sess_a");
    const second = selectSessionPanel(usePanelStore.getState(), "sess_b");
    expect(first.dockByTab.files).toBe("closed");
    expect(first.dockByTab.shell).toBe("closed");
    expect(first.activeMain).toBe("chat");
    expect(second.dockByTab.diff).toBe("right");
  });

  it("persists an unclaimed legacy layout when global auto locations change", () => {
    const legacy = {
      ...defaultSessionPanel(),
      dockByTab: { ...defaultSessionPanel().dockByTab, shell: "bottom" as const },
      activeBottom: "shell" as const
    };
    usePanelStore.setState({ legacySession: legacy });
    usePanelStore.getState().setAutoLocation("agents", "main");
    const stored = parsePanelState(window.localStorage.getItem(PANEL_STATE_KEY), null);
    expect(stored.legacySession?.dockByTab.shell).toBe("bottom");
    expect(stored.autoLocation.agents).toBe("main");
  });

  it("claims a legacy layout for only the first initialized session", () => {
    const legacy = {
      ...defaultSessionPanel(),
      dockByTab: { ...defaultSessionPanel().dockByTab, shell: "bottom" as const },
      activeBottom: "shell" as const
    };
    usePanelStore.setState({ legacySession: legacy });
    usePanelStore.getState().initializeSession("sess_a");
    usePanelStore.getState().initializeSession("sess_b");
    const state = usePanelStore.getState();
    expect(selectSessionPanel(state, "sess_a").dockByTab.shell).toBe("bottom");
    expect(selectSessionPanel(state, "sess_b").dockByTab.shell).toBe("closed");
    expect(state.legacySession).toBeNull();
  });
});

describe("usePanelStore right split", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePanelStore.setState({
      autoLocation: { ...DEFAULT_AUTO },
      sessions: {},
      legacySession: null,
      draggingTab: null
    });
  });

  it("setRightSplit docks the tool right, keeps the active one and reveals the panel", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.setRightVisible("sess_a", false);
    store.setRightSplit("sess_a", "shell");
    const panel = selectSessionPanel(usePanelStore.getState(), "sess_a");
    expect(panel).toMatchObject({ activeRight: "diff", rightSplit: "shell", rightVisible: true });
    expect(panel.dockByTab.shell).toBe("right");
  });

  it("setRightSplit(null) clears the split", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "shell");
    store.setRightSplit("sess_a", null);
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").rightSplit).toBeNull();
  });

  it("ignores splitting the tool that is already the active right tool", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "diff");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").rightSplit).toBeNull();
  });

  it("swaps the split with the active tool when the split tool is opened", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "shell");
    store.setActive("sess_a", "right", "shell");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a")).toMatchObject({
      activeRight: "shell",
      rightSplit: "diff"
    });
  });

  it("promotes the split tool when the active right tool is closed", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "files", "right");
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "shell");
    store.moveTab("sess_a", "diff", "closed");
    const panel = selectSessionPanel(usePanelStore.getState(), "sess_a");
    expect(panel).toMatchObject({ activeRight: "shell", rightSplit: null });
    expect(rightOpenTabs(panel.dockByTab, () => true)).toEqual(["files", "shell"]);
  });

  it("placeRightSplit docks a bottom tool into the split, keeps the top tool and reveals the panel", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.moveTab("sess_a", "shell", "bottom");
    store.setRightVisible("sess_a", false);
    const current = selectSessionPanel(usePanelStore.getState(), "sess_a");
    const drop = resolveSplitDrop(current.dockByTab, "diff", null, "shell", () => true);
    expect(drop).toEqual({ ok: true, top: "diff", split: "shell" });
    if (drop.ok) usePanelStore.getState().placeRightSplit("sess_a", drop);
    const panel = selectSessionPanel(usePanelStore.getState(), "sess_a");
    expect(panel).toMatchObject({ activeRight: "diff", rightSplit: "shell", rightVisible: true });
    expect(panel.dockByTab.shell).toBe("right");
  });

  it("placeRightSplit moves the top tool into the split and promotes the next right tool", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "files", "right");
    store.moveTab("sess_a", "diff", "right");
    const current = selectSessionPanel(usePanelStore.getState(), "sess_a");
    const drop = resolveSplitDrop(current.dockByTab, "diff", null, "diff", () => true);
    expect(drop).toEqual({ ok: true, top: "files", split: "diff" });
    if (drop.ok) usePanelStore.getState().placeRightSplit("sess_a", drop);
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a")).toMatchObject({ activeRight: "files", rightSplit: "diff" });
  });

  it("placeRightSplit swaps the top tool with the split tool", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "files", "right");
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "shell");
    const current = selectSessionPanel(usePanelStore.getState(), "sess_a");
    const drop = resolveSplitDrop(current.dockByTab, "diff", "shell", "diff", () => true);
    expect(drop).toEqual({ ok: true, top: "shell", split: "diff" });
    if (drop.ok) usePanelStore.getState().placeRightSplit("sess_a", drop);
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a")).toMatchObject({ activeRight: "shell", rightSplit: "diff" });
  });

  it("clears the split when its tool leaves the right panel", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "shell");
    store.moveTab("sess_a", "shell", "bottom");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").rightSplit).toBeNull();
  });

  it("toggleRightSplit picks the first other right tool, then turns the split off", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "agents", "right");
    store.moveTab("sess_a", "files", "right");
    store.moveTab("sess_a", "diff", "right");
    store.toggleRightSplit("sess_a");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a")).toMatchObject({
      activeRight: "diff",
      rightSplit: "files"
    });
    usePanelStore.getState().toggleRightSplit("sess_a");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").rightSplit).toBeNull();
  });

  it("toggleRightSplit skips unavailable tools and opens the shell when none is left", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "files", "right");
    store.moveTab("sess_a", "codex", "right");
    store.moveTab("sess_a", "diff", "right");
    store.toggleRightSplit("sess_a", (tab) => tab !== "files");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").rightSplit).toBe("codex");

    store.moveTab("sess_b", "diff", "right");
    store.toggleRightSplit("sess_b");
    const panel = selectSessionPanel(usePanelStore.getState(), "sess_b");
    expect(panel).toMatchObject({ activeRight: "diff", rightSplit: "shell" });
    expect(panel.dockByTab.shell).toBe("right");
  });

  it("toggleRightSplit reveals a stored split while the right panel is hidden", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "shell");
    store.setRightVisible("sess_a", false);
    usePanelStore.getState().toggleRightSplit("sess_a");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a")).toMatchObject({
      rightVisible: true,
      activeRight: "diff",
      rightSplit: "shell"
    });
  });

  it("toggleRightSplit shows the panel with a fresh split when hidden and no split is stored", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.moveTab("sess_a", "files", "right");
    store.setRightVisible("sess_a", false);
    usePanelStore.getState().toggleRightSplit("sess_a");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a")).toMatchObject({
      rightVisible: true,
      activeRight: "files",
      rightSplit: "diff"
    });
  });

  it("toggleRightSplit excludes the resolved top tool, not only the stored active one", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "files", "right");
    store.moveTab("sess_a", "diff", "right");
    const notDiff = (tab: DockableTabId) => tab !== "diff";
    store.toggleRightSplit("sess_a", notDiff, "files");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").rightSplit).toBe("shell");
  });

  it("toggleRightSplit replaces a stored split that equals the resolved top tool", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "files", "right");
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "files");
    const notDiff = (tab: DockableTabId) => tab !== "diff";
    usePanelStore.getState().toggleRightSplit("sess_a", notDiff, "files");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").rightSplit).toBe("shell");
  });

  it("setRightSplitRatio clamps and persists", () => {
    const store = usePanelStore.getState();
    store.setRightSplitRatio("sess_a", 0.9);
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a").rightSplitRatio).toBe(0.75);
    expect(window.localStorage.getItem(PANEL_STATE_KEY)).toContain('"rightSplitRatio":0.75');
  });

  it("resetLayout drops the split", () => {
    const store = usePanelStore.getState();
    store.moveTab("sess_a", "diff", "right");
    store.setRightSplit("sess_a", "shell");
    store.resetLayout("sess_a");
    expect(selectSessionPanel(usePanelStore.getState(), "sess_a")).toMatchObject({ rightSplit: null, rightSplitRatio: 0.5 });
  });
});

describe("resolveMainTab", () => {
  it("keeps the active main tab and falls back to chat", () => {
    const layout = defaultLayout();
    layout.dockByTab.files = "main";
    layout.mainOrder = ["chat", "files"];
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "claude", "files", false)).toBe("files");
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "claude", "agents", false)).toBe("chat");
  });

  it("hides harness tabs whose driver is not active", () => {
    const layout = defaultLayout();
    layout.dockByTab.claude = "main";
    layout.mainOrder = ["chat", "files", "claude"];
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "opencode", "claude", false)).toBe("chat");
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "claude", "claude", false)).toBe("claude");
  });

  it("hides the PR tab for sessions without a linked PR", () => {
    const layout = defaultLayout();
    layout.dockByTab.pr = "main";
    layout.mainOrder = ["chat", "pr"];
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "claude", "pr", false)).toBe("chat");
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "claude", "pr", true)).toBe("pr");
  });
});

describe("usePanelStore draggingTab", () => {
  it("tracks the in-flight tab drag without persisting it", () => {
    window.localStorage.clear();
    expect(usePanelStore.getState().draggingTab).toBeNull();
    usePanelStore.getState().setDraggingTab("files");
    expect(usePanelStore.getState().draggingTab).toBe("files");
    expect(window.localStorage.getItem(PANEL_STATE_KEY)).toBeNull();
    usePanelStore.getState().setDraggingTab(null);
    expect(usePanelStore.getState().draggingTab).toBeNull();
  });
});

describe("resolveRightTop", () => {
  const dock = { ...defaultSessionPanel().dockByTab, files: "right" as const, diff: "right" as const, codex: "right" as const };

  it("keeps the stored active tool when it is available", () => {
    expect(resolveRightTop(dock, "diff", () => true, "codex")).toBe("diff");
  });

  it("prefers the driver tool, then the first available right tool", () => {
    const notDiff = (tab: DockableTabId) => tab !== "diff";
    expect(resolveRightTop(dock, "diff", notDiff, "codex")).toBe("codex");
    expect(resolveRightTop(dock, "diff", notDiff, "claude")).toBe("files");
    expect(resolveRightTop(dock, "diff", () => false, "codex")).toBeNull();
  });
});

describe("rightOpenTabs", () => {
  const dock = {
    ...defaultSessionPanel().dockByTab,
    pr: "right" as const,
    shell: "right" as const,
    files: "right" as const,
    preview: "right" as const,
    codex: "right" as const,
    claude: "right" as const,
    agents: "bottom" as const
  };

  it("lists right-docked tools in dock order", () => {
    expect(rightOpenTabs(dock, () => true)).toEqual(["files", "claude", "codex", "shell", "preview", "pr"]);
  });

  it("drops a PR tool without a link, a harness of another driver and a missing preview", () => {
    expect(rightOpenTabs(dock, toolAvailability("codex", false, false))).toEqual(["files", "codex", "shell"]);
    expect(rightOpenTabs(dock, toolAvailability("claude", true, true))).toEqual(["files", "claude", "shell", "preview", "pr"]);
    expect(rightOpenTabs(dock, toolAvailability(undefined, false, false))).toEqual(["files", "shell"]);
  });
});

describe("resolveSplitDrop", () => {
  const dock = { ...defaultSessionPanel().dockByTab, files: "right" as const, diff: "right" as const, shell: "bottom" as const };
  const all = () => true;

  it("keeps the top tool and splits a tool docked elsewhere", () => {
    expect(resolveSplitDrop(dock, "diff", null, "shell", all)).toEqual({ ok: true, top: "diff", split: "shell" });
    expect(resolveSplitDrop(dock, "diff", "files", "shell", all)).toEqual({ ok: true, top: "diff", split: "shell" });
  });

  it("promotes the split tool, else the next available right tool, when the top tool is dropped", () => {
    expect(resolveSplitDrop(dock, "diff", "files", "diff", all)).toEqual({ ok: true, top: "files", split: "diff" });
    expect(resolveSplitDrop(dock, "files", null, "files", all)).toEqual({ ok: true, top: "diff", split: "files" });
  });

  it("rejects dropping the only right tool, the split tool itself, an unavailable tool or a drop without a top tool", () => {
    const solo = { ...defaultSessionPanel().dockByTab, diff: "right" as const };
    expect(resolveSplitDrop(solo, "diff", null, "diff", all)).toEqual({ ok: false, reason: "only-right-tool" });
    expect(resolveSplitDrop(dock, "files", null, "files", (tab) => tab !== "diff")).toEqual({ ok: false, reason: "only-right-tool" });
    expect(resolveSplitDrop(dock, "diff", "files", "files", all)).toEqual({ ok: false, reason: "already-split" });
    expect(resolveSplitDrop(dock, "diff", null, "pr", (tab) => tab !== "pr")).toEqual({ ok: false, reason: "unavailable" });
    expect(resolveSplitDrop(dock, null, null, "shell", all)).toEqual({ ok: false, reason: "no-top-tool" });
  });
});

describe("pickSplitTool", () => {
  const dock = { ...defaultSessionPanel().dockByTab, files: "right" as const, diff: "right" as const, codex: "right" as const };

  it("picks the first available right tool other than the top one", () => {
    expect(pickSplitTool(dock, "files", () => true)).toBe("diff");
    expect(pickSplitTool(dock, "files", (tab) => tab !== "diff")).toBe("codex");
  });

  it("falls back to the shell, or files when the shell is on top", () => {
    expect(pickSplitTool(dock, "files", (tab) => tab === "files")).toBe("shell");
    expect(pickSplitTool({ ...defaultSessionPanel().dockByTab, shell: "right" }, "shell", () => true)).toBe("files");
  });
});
