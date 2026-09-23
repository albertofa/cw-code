// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO,
  PANEL_LAYOUT_KEY,
  PANEL_STATE_KEY,
  clampBottomHeight,
  defaultLayout,
  defaultSessionPanel,
  isBottomOpen,
  parseLayout,
  parsePanelState,
  resolveMainTab,
  sanitizeLayout,
  serializeLayout,
  serializePanelState,
  tabsInPanel
} from "./panelLayout.js";
import { selectSessionPanel, usePanelStore } from "./panelStore.js";

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

describe("resolveMainTab", () => {
  it("keeps the active main tab and falls back to chat", () => {
    const layout = defaultLayout();
    layout.dockByTab.files = "main";
    layout.mainOrder = ["chat", "files"];
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "claude", "files")).toBe("files");
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "claude", "agents")).toBe("chat");
  });

  it("hides harness tabs whose driver is not active", () => {
    const layout = defaultLayout();
    layout.dockByTab.claude = "main";
    layout.mainOrder = ["chat", "files", "claude"];
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "opencode", "claude")).toBe("chat");
    expect(resolveMainTab(layout.mainOrder, layout.dockByTab, "claude", "claude")).toBe("claude");
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
