import type {
  DockableTabId,
  MainTabId,
  PanelId,
  PanelLayoutSnapshot,
  TabAutoLocation,
  TabDockState
} from "@cw-code/contracts";

export const DOCKABLE_TABS: readonly DockableTabId[] = [
  "files",
  "agents",
  "diff",
  "claude",
  "opencode",
  "codex",
  "shell",
  "preview"
];

export const PANELS: readonly PanelId[] = ["main", "right", "bottom"];

export const PANEL_LAYOUT_KEY = "cw-code:panelLayout:v2";

export const BOTTOM_HEIGHT_DEFAULT = 260;
export const BOTTOM_HEIGHT_MIN = 140;
export const BOTTOM_HEIGHT_MAX = 520;

export const DEFAULT_DOCK: TabDockState = {
  files: "closed",
  agents: "closed",
  diff: "closed",
  claude: "closed",
  opencode: "closed",
  codex: "closed",
  shell: "closed",
  preview: "closed"
};

export const DEFAULT_AUTO: TabAutoLocation = {
  files: "main",
  agents: "right",
  diff: "right",
  claude: "right",
  opencode: "right",
  codex: "right",
  shell: "bottom",
  preview: "right"
};

export function defaultLayout(): PanelLayoutSnapshot {
  return {
    dockByTab: { ...DEFAULT_DOCK },
    autoLocation: { ...DEFAULT_AUTO },
    activeMain: "chat",
    activeRight: "agents",
    activeBottom: "shell",
    mainOrder: ["chat"],
    bottomHeight: BOTTOM_HEIGHT_DEFAULT
  };
}

export function isPanelId(value: unknown): value is PanelId {
  return value === "main" || value === "right" || value === "bottom";
}

export function isDockableTabId(value: unknown): value is DockableTabId {
  return typeof value === "string" && (DOCKABLE_TABS as readonly string[]).includes(value);
}

function isMainTabId(value: unknown): value is MainTabId {
  return value === "chat" || isDockableTabId(value);
}

export function tabsInPanel(dockByTab: TabDockState, panel: PanelId): DockableTabId[] {
  return DOCKABLE_TABS.filter((tab) => dockByTab[tab] === panel);
}

export function isBottomOpen(dockByTab: TabDockState): boolean {
  return tabsInPanel(dockByTab, "bottom").length > 0;
}

export function clampBottomHeight(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return BOTTOM_HEIGHT_DEFAULT;
  return Math.min(BOTTOM_HEIGHT_MAX, Math.max(BOTTOM_HEIGHT_MIN, Math.round(n)));
}

function sanitizeDock<T extends TabDockState>(raw: unknown, fallback: T, allowClosed: boolean): T {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = { ...fallback };
  for (const tab of DOCKABLE_TABS) {
    const value = source[tab];
    if (isPanelId(value) || (allowClosed && value === "closed")) out[tab] = value;
  }
  return out;
}

export function sanitizeLayout(raw: unknown): PanelLayoutSnapshot {
  const defaults = defaultLayout();
  if (typeof raw !== "object" || raw === null) return defaults;
  const source = raw as Record<string, unknown>;
  const dockByTab = sanitizeDock(source.dockByTab, defaults.dockByTab, true);
  const autoLocation = sanitizeDock(source.autoLocation, defaults.autoLocation, false);
  const seen = new Set<MainTabId>();
  const mainOrder: MainTabId[] = [];
  const candidateOrder = Array.isArray(source.mainOrder) ? source.mainOrder : [];
  for (const entry of candidateOrder) {
    if (!isMainTabId(entry) || seen.has(entry)) continue;
    if (entry !== "chat" && dockByTab[entry] !== "main") continue;
    seen.add(entry);
    mainOrder.push(entry);
  }
  if (!seen.has("chat")) {
    seen.add("chat");
    mainOrder.unshift("chat");
  }
  for (const tab of tabsInPanel(dockByTab, "main")) {
    if (!seen.has(tab)) {
      seen.add(tab);
      mainOrder.push(tab);
    }
  }
  const rawActiveMain = source.activeMain;
  const activeMain: MainTabId =
    isMainTabId(rawActiveMain) && (rawActiveMain === "chat" || dockByTab[rawActiveMain] === "main")
      ? rawActiveMain
      : "chat";
  const rightTabs = tabsInPanel(dockByTab, "right");
  const rawActiveRight = source.activeRight;
  const activeRight: DockableTabId =
    isDockableTabId(rawActiveRight) && dockByTab[rawActiveRight] === "right"
      ? rawActiveRight
      : (rightTabs[0] ?? defaults.activeRight);
  const bottomTabs = tabsInPanel(dockByTab, "bottom");
  const rawActiveBottom = source.activeBottom;
  const activeBottom: DockableTabId =
    isDockableTabId(rawActiveBottom) && dockByTab[rawActiveBottom] === "bottom"
      ? rawActiveBottom
      : (bottomTabs[0] ?? defaults.activeBottom);
  return {
    dockByTab,
    autoLocation,
    activeMain,
    activeRight,
    activeBottom,
    mainOrder,
    bottomHeight: clampBottomHeight(source.bottomHeight)
  };
}

export function serializeLayout(snapshot: PanelLayoutSnapshot): string {
  return JSON.stringify({
    dockByTab: snapshot.dockByTab,
    autoLocation: snapshot.autoLocation,
    activeMain: snapshot.activeMain,
    activeRight: snapshot.activeRight,
    activeBottom: snapshot.activeBottom,
    mainOrder: snapshot.mainOrder,
    bottomHeight: snapshot.bottomHeight
  });
}

export function parseLayout(raw: string | null | undefined): PanelLayoutSnapshot {
  if (typeof raw !== "string" || raw.length === 0) return defaultLayout();
  try {
    return sanitizeLayout(JSON.parse(raw) as unknown);
  } catch {
    return defaultLayout();
  }
}
const HARNESS_TABS: readonly DockableTabId[] = [
  "claude",
  "opencode",
  "codex"
];

export function resolveMainTab(
  mainOrder: MainTabId[],
  dockByTab: TabDockState,
  driver: DockableTabId | undefined,
  activeMain: MainTabId
): MainTabId {
  const visible = mainOrder.filter(
    (id) => id === "chat" || (dockByTab[id] === "main" && (!HARNESS_TABS.includes(id) || id === driver))
  );
  return visible.includes(activeMain) ? activeMain : "chat";
}
