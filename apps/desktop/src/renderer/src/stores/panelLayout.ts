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
  "preview",
  "pr"
];

export const PANELS: readonly PanelId[] = ["main", "right", "bottom"];

export const PANEL_LAYOUT_KEY = "cw-code:panelLayout:v2";
export const PANEL_STATE_KEY = "cw-code:panelLayout:v3";

export interface SessionPanelState {
  dockByTab: TabDockState;
  activeMain: MainTabId;
  activeRight: DockableTabId;
  activeBottom: DockableTabId;
  mainOrder: MainTabId[];
  bottomHeight: number;
  rightVisible: boolean;
  bottomCollapsed: boolean;
}

export interface PersistedPanelState {
  autoLocation: TabAutoLocation;
  sessions: Record<string, SessionPanelState>;
  legacySession?: SessionPanelState | null;
}

export interface LoadedPanelState extends PersistedPanelState {
  legacySession: SessionPanelState | null;
}

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
  preview: "closed",
  pr: "closed"
};

export const DEFAULT_AUTO: TabAutoLocation = {
  files: "main",
  agents: "right",
  diff: "right",
  claude: "right",
  opencode: "right",
  codex: "right",
  shell: "bottom",
  preview: "right",
  pr: "right"
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

export function defaultSessionPanel(): SessionPanelState {
  return {
    dockByTab: { ...DEFAULT_DOCK },
    activeMain: "chat",
    activeRight: "agents",
    activeBottom: "shell",
    mainOrder: ["chat"],
    bottomHeight: BOTTOM_HEIGHT_DEFAULT,
    rightVisible: true,
    bottomCollapsed: false
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
  } else if (mainOrder[0] !== "chat") {
    const chatIndex = mainOrder.indexOf("chat");
    mainOrder.splice(chatIndex, 1);
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

function sessionFromLayout(snapshot: PanelLayoutSnapshot): SessionPanelState {
  return {
    dockByTab: snapshot.dockByTab,
    activeMain: snapshot.activeMain,
    activeRight: snapshot.activeRight,
    activeBottom: snapshot.activeBottom,
    mainOrder: snapshot.mainOrder,
    bottomHeight: snapshot.bottomHeight,
    rightVisible: true,
    bottomCollapsed: false
  };
}

export function sanitizeSessionPanel(raw: unknown): SessionPanelState {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const layout = sanitizeLayout(source);
  return {
    ...sessionFromLayout(layout),
    rightVisible: typeof source.rightVisible === "boolean" ? source.rightVisible : true,
    bottomCollapsed: typeof source.bottomCollapsed === "boolean" ? source.bottomCollapsed : false
  };
}

function sanitizePersistedPanelState(raw: unknown): LoadedPanelState {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const autoLocation = sanitizeLayout({ autoLocation: source.autoLocation }).autoLocation;
  const sessions: Record<string, SessionPanelState> = {};
  const rawSessions = typeof source.sessions === "object" && source.sessions !== null
    ? (source.sessions as Record<string, unknown>)
    : {};
  for (const [sessionId, value] of Object.entries(rawSessions)) {
    if (sessionId.length === 0) continue;
    sessions[sessionId] = sanitizeSessionPanel(value);
  }
  return {
    autoLocation,
    sessions,
    legacySession:
      Object.keys(sessions).length === 0 && source.legacySession != null
        ? sanitizeSessionPanel(source.legacySession)
        : null
  };
}

export function parsePanelState(
  raw: string | null | undefined,
  legacyRaw: string | null | undefined
): LoadedPanelState {
  if (typeof raw === "string" && raw.length > 0) {
    try {
      return sanitizePersistedPanelState(JSON.parse(raw) as unknown);
    } catch {
    }
  }
  if (typeof legacyRaw === "string" && legacyRaw.length > 0) {
    const legacy = parseLayout(legacyRaw);
    return {
      autoLocation: legacy.autoLocation,
      sessions: {},
      legacySession: sessionFromLayout(legacy)
    };
  }
  return sanitizePersistedPanelState(null);
}

export function serializePanelState(state: PersistedPanelState): string {
  return JSON.stringify({
    autoLocation: state.autoLocation,
    sessions: state.sessions,
    legacySession: state.legacySession ?? null
  });
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
  activeMain: MainTabId,
  hasPr: boolean
): MainTabId {
  const visible = mainOrder.filter(
    (id) =>
      id === "chat" ||
      (dockByTab[id] === "main" && (!HARNESS_TABS.includes(id) || id === driver) && (id !== "pr" || hasPr))
  );
  return visible.includes(activeMain) ? activeMain : "chat";
}
