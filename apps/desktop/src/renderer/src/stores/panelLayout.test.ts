// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_LAYOUT_KEY,
  clampBottomHeight,
  defaultLayout,
  isBottomOpen,
  parseLayout,
  resolveMainTab,
  sanitizeLayout,
  serializeLayout,
  tabsInPanel
} from "./panelLayout.js";
import { usePanelStore } from "./panelStore.js";

describe("tabsInPanel", () => {
  it("returns tabs docked to the panel in canonical order", () => {
    const layout = defaultLayout();
    expect(tabsInPanel(layout.dockByTab, "main")).toEqual(["files"]);
    expect(tabsInPanel(layout.dockByTab, "bottom")).toEqual(["shell"]);
    expect(tabsInPanel(layout.dockByTab, "right")).toEqual(["agents", "diff", "claude", "opencode", "codex", "preview"]);
  });
});

describe("isBottomOpen", () => {
  it("is open only while a tab is docked to the bottom", () => {
    const layout = defaultLayout();
    expect(isBottomOpen(layout.dockByTab)).toBe(true);
    expect(isBottomOpen({ ...layout.dockByTab, shell: "right" })).toBe(false);
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
    expect(clean.dockByTab.shell).toBe("bottom");
    expect(clean.mainOrder[0]).toBe("chat");
    expect(clean.mainOrder).not.toContain("bogus");
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
  it("preserves a customized layout and rejects corrupt payloads", () => {
    const layout = defaultLayout();
    layout.dockByTab.diff = "main";
    layout.mainOrder = ["chat", "files", "diff"];
    layout.activeMain = "diff";
    const parsed = parseLayout(serializeLayout(layout));
    expect(parsed).toEqual({ ...layout, dockByTab: { ...layout.dockByTab } });
    expect(parseLayout("{oops")).toEqual(defaultLayout());
    expect(parseLayout(null)).toEqual(defaultLayout());
  });
});

describe("usePanelStore routing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePanelStore.getState().resetLayout();
    window.localStorage.clear();
  });

  it("moveTab docks, activates, and persists", () => {
    usePanelStore.getState().moveTab("diff", "main");
    const state = usePanelStore.getState();
    expect(state.dockByTab.diff).toBe("main");
    expect(state.activeMain).toBe("diff");
    expect(state.mainOrder).toContain("diff");
    const stored = window.localStorage.getItem(PANEL_LAYOUT_KEY);
    expect(stored).toContain('"diff":"main"');
  });

  it("activateOrOpen routes a rail click to the auto location", () => {
    usePanelStore.getState().setAutoLocation("agents", "bottom");
    usePanelStore.getState().activateOrOpen("agents");
    const state = usePanelStore.getState();
    expect(state.dockByTab.agents).toBe("bottom");
    expect(state.activeBottom).toBe("agents");
  });

  it("setActive ignores tabs that are not in the panel", () => {
    usePanelStore.getState().setActive("bottom", "diff");
    expect(usePanelStore.getState().activeBottom).toBe("shell");
    usePanelStore.getState().setActive("main", "chat");
    expect(usePanelStore.getState().activeMain).toBe("chat");
  });

  it("resetLayout restores Files to main and Shell to bottom", () => {
    usePanelStore.getState().moveTab("files", "right");
    usePanelStore.getState().moveTab("shell", "main");
    usePanelStore.getState().resetLayout();
    const state = usePanelStore.getState();
    expect(state.dockByTab.files).toBe("main");
    expect(state.dockByTab.shell).toBe("bottom");
    expect(state.activeMain).toBe("chat");
  });
});
describe("resolveMainTab", () => {
  it("keeps the active main tab and falls back to chat", () => {
    const layout = defaultLayout();
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
    expect(window.localStorage.getItem(PANEL_LAYOUT_KEY)).toBeNull();
    usePanelStore.getState().setDraggingTab(null);
    expect(usePanelStore.getState().draggingTab).toBeNull();
  });
});
