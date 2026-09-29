import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { DriverName } from "./cw.js";
import { applyAppearance } from "./appearanceFonts.js";
import { collectSubagents } from "./components/subagents.js";
import { isWorkingSetStatus } from "./components/workingSet.js";
import { Sidebar } from "./components/Sidebar.js";
import { WindowControls } from "./components/WindowControls.js";
import { SkillsModal } from "./components/SkillsModal.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { SettingsNav } from "./components/SettingsNav.js";
import { useConfirm } from "./components/ConfirmDialog.js";
import { navIdOf, sameValue, sectionSummary, unsavedSectionLabels } from "./components/settingsSections.js";
import { ThreadView } from "./components/ThreadView.js";
import { PrInboxView } from "./components/PrInboxView.js";
import { PrDetailView } from "./components/PrDetailView.js";
import { UsageView } from "./components/UsageView.js";
import { WorkflowRunModal } from "./components/WorkflowRunModal.js";
import { ShutdownDialog } from "./components/ShutdownDialog.js";
import { handleQuitRequest, handleShutdownExpired } from "./stores/shutdownFlow.js";
import { RightPanelBody } from "./components/RightPanelBody.js";
import { ToolRail } from "./components/ToolRail.js";
import { useToolAvailability } from "./components/useToolAvailability.js";
import { useTabMenu } from "./components/TabMenu.js";
import { useDockDrop } from "./components/useDockDrop.js";
import { usePanelAnimationMs, usePresence } from "./components/usePresence.js";
import { useNotifs } from "./components/Notifications.js";
import { useAttentionBadge } from "./components/useAttentionBadge.js";
import { visibleLayerOpen } from "./components/openLayer.js";
import { useAppStore } from "./stores/appStore.js";
import { tabsInPanel, DOCKABLE_TABS } from "./stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "./stores/panelStore.js";
import { usePrStore } from "./stores/prStore.js";
import { useSettingsDraftStore } from "./stores/settingsDraftStore.js";
import { prKey } from "./components/prInbox.js";
import type { DockableTabId } from "@cw-code/contracts";
import type { TurnEvent } from "./cw.js";

const VERSION_NOTIF_ID = "cli-versions";
const BINARY_NOTIF_ID = "cli-binaries";

const RIGHT_WIDTH_KEY = "cw-code:rightWidth";
const RIGHT_WIDTH_DEFAULT = 520;
const RIGHT_WIDTH_MIN = 320;
const RIGHT_WIDTH_MAX = 800;

function loadRightWidth(): number {
  try {
    const raw = window.localStorage.getItem(RIGHT_WIDTH_KEY);
    const n = raw == null ? NaN : Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, n));
  } catch {
  }
  return RIGHT_WIDTH_DEFAULT;
}

const pendingDeltas = new Map<string, string>();
let deltaRaf = 0;

function flushPendingDeltas(): void {
  if (pendingDeltas.size === 0) return;
  const state = useAppStore.getState();
  for (const [key, text] of pendingDeltas) {
    const sep = key.indexOf("\n");
    const sessionId = key.slice(0, sep);
    const turnId = key.slice(sep + 1);
    state.applyEvent(sessionId, { type: "assistant.delta", turnId, text });
  }
  pendingDeltas.clear();
  if (deltaRaf !== 0) {
    cancelAnimationFrame(deltaRaf);
    deltaRaf = 0;
  }
}

function flushPendingDeltasForSession(sessionId: string): void {
  const prefix = `${sessionId}\n`;
  const state = useAppStore.getState();
  let changed = false;
  for (const [key, text] of [...pendingDeltas]) {
    if (!key.startsWith(prefix)) continue;
    pendingDeltas.delete(key);
    state.applyEvent(sessionId, { type: "assistant.delta", turnId: key.slice(prefix.length), text });
    changed = true;
  }
  if (changed && pendingDeltas.size === 0 && deltaRaf !== 0) {
    cancelAnimationFrame(deltaRaf);
    deltaRaf = 0;
  }
}

function handleTurnEvent(msg: { sessionId: string; event: TurnEvent }): void {
  if (msg.event.type === "assistant.delta") {
    const key = `${msg.sessionId}\n${msg.event.turnId}`;
    pendingDeltas.set(key, (pendingDeltas.get(key) ?? "") + msg.event.text);
    if (deltaRaf === 0) {
      deltaRaf = requestAnimationFrame(() => {
        deltaRaf = 0;
        flushPendingDeltas();
      });
    }
    return;
  }
  flushPendingDeltasForSession(msg.sessionId);
  useAppStore.getState().applyEvent(msg.sessionId, msg.event);
}

export function App() {
  useAttentionBadge();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const sourceControlRefreshIntervalSeconds = useAppStore((s) => s.sourceControlRefreshIntervalSeconds);
  const prRefreshIntervalSeconds = useAppStore((s) => s.prRefreshIntervalSeconds);
  const mainView = usePrStore((s) => s.mainView);
  const runModal = usePrStore((s) => s.runModal);
  const holdingHours = useAppStore((s) => s.holdingHours);
  const holdingAutoExpireEnabled = useAppStore((s) => s.holdingAutoExpireEnabled);
  const settingsVersion = useAppStore((s) => s.settingsVersion);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const appearance = useAppStore((s) => s.appearance);
  const sessionPanel = usePanelStore((s) => selectSessionPanel(s, activeSessionId ?? undefined));
  const { dockByTab, rightVisible, rightSplit, rightSplitRatio } = sessionPanel;
  const initializeSession = usePanelStore((s) => s.initializeSession);
  const activateOrOpen = usePanelStore((s) => s.activateOrOpen);
  const dropRight = useDockDrop("right", activeSessionId ?? undefined);
  const tabMenu = useTabMenu(activeSessionId ?? undefined);
  const draggingTab = usePanelStore((s) => s.draggingTab);
  const setRightVisible = usePanelStore((s) => s.setRightVisible);

  useEffect(() => applyAppearance(document.documentElement, appearance), [appearance]);

  useEffect(() => {
    if (activeSessionId) initializeSession(activeSessionId);
  }, [activeSessionId, initializeSession]);

  const panelAnimationMs = usePanelAnimationMs();
  const rightPresence = usePresence(rightVisible, panelAnimationMs);
  const [rightWidth, setRightWidth] = useState(loadRightWidth);
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const settingsActive = mainView.kind === "settings";

  const openSettings = (harness?: DriverName) => usePrStore.getState().openSettings(undefined, harness);

  const leaveSettings = useCallback(
    async (go: () => void) => {
      const drafts = useSettingsDraftStore.getState();
      if (usePrStore.getState().mainView.kind === "settings" && drafts.dirty) {
        const changed = unsavedSectionLabels(drafts.saved, drafts.draft, !sameValue(drafts.repoDraft, drafts.repoSaved));
        const lost = changed.length > 0 ? `Your changes in ${sectionSummary(changed)} will be lost.` : "Your unsaved changes will be lost.";
        const ok = await confirm({
          title: "Discard unsaved settings?",
          message: drafts.saving ? `A save is in progress and will still finish. ${lost}` : lost,
          danger: true,
          confirmLabel: "Discard"
        });
        if (!ok) return;
        useSettingsDraftStore.getState().discard();
      }
      go();
    },
    [confirm]
  );
  const leaveSettingsRef = useRef(leaveSettings);
  leaveSettingsRef.current = leaveSettings;

  const applyRightWidth = (n: number) => {
    const clamped = Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, Math.round(n)));
    setRightWidth(clamped);
    try {
      window.localStorage.setItem(RIGHT_WIDTH_KEY, String(clamped));
    } catch {
    }
  };

  const onResizeStart = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: rightWidth };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      applyRightWidth(d.startWidth + (d.startX - ev.clientX));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    if (!window.cw) {
      setPreloadError("window.cw is missing — preload did not load. Restart the Electron app (plain browsers can't reach the backend).");
      return;
    }
    void loadProjects();
    const off = window.cw.onTurnEvent(handleTurnEvent);
    const offTitle = window.cw.onSessionTitle(({ sessionId, title }) => useAppStore.getState().applySessionTitle(sessionId, title));
    const offSession = window.cw.onSessionUpdated((session) => useAppStore.getState().applySession(session));
    const offUpdates = useAppStore.getState().subscribeUpdates();
    const offShutdown = window.cw.shutdown.onRequested(() => void handleQuitRequest());
    const offShutdownExpired = window.cw.shutdown.onExpired(() => handleShutdownExpired());
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".pty-wrap")) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        window.cw.zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        window.cw.zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        window.cw.zoomReset();
      } else if (e.key.toLowerCase() === "t" && !e.shiftKey && !visibleLayerOpen()) {
        e.preventDefault();
        void leaveSettingsRef.current(() => {
          usePrStore.getState().openSessionView();
          useAppStore.getState().startNewSession();
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      offTitle();
      offSession();
      offUpdates();
      offShutdown();
      offShutdownExpired();
      flushPendingDeltas();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const workingSetKey = useMemo(
    () =>
      Object.values(sessionsByProject)
        .flat()
        .filter((session) => isWorkingSetStatus(session.status))
        .map((session) => session.id)
        .sort()
        .join("|"),
    [sessionsByProject]
  );

  useEffect(() => {
    if (!workingSetKey) return;
    let running = false;
    const refresh = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const { refreshGitStatus } = useAppStore.getState();
        const ids = workingSetKey.split("|");
        for (let i = 0; i < ids.length; i += 6) {
          await Promise.all(ids.slice(i, i + 6).map((id) => refreshGitStatus(id)));
        }
      } finally {
        running = false;
      }
    };
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), sourceControlRefreshIntervalSeconds * 1000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workingSetKey, sourceControlRefreshIntervalSeconds]);

  useEffect(() => {
    const onFocus = () => {
      const { activeSessionId: sessionId, refreshGitStatus } = useAppStore.getState();
      if (sessionId) void refreshGitStatus(sessionId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!window.cw) return;
    const refresh = () => {
      if (!document.hidden) void usePrStore.getState().refreshInbox();
    };
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, Math.max(30, prRefreshIntervalSeconds || 120) * 1000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [prRefreshIntervalSeconds]);

  useEffect(() => {
    if (!window.cw || !holdingAutoExpireEnabled) return;
    const expire = () => void useAppStore.getState().expireHoldingSessions();
    expire();
    const timer = window.setInterval(expire, 60_000);
    return () => window.clearInterval(timer);
  }, [holdingAutoExpireEnabled, holdingHours]);

  useEffect(() => {
    if (!window.cw) return;
    let active = true;
    const recheckVersions = () => {
      window.cw
        .checkVersions()
        .then((checks) => {
          if (!active) return;
          const missing = checks.filter((c) => !c.available);
          const failed = checks.filter((c) => c.available && c.actual === null);
          const outdated = checks.filter((c) => c.actual !== null && !c.ok);
          const notifs = useNotifs.getState();

          if (missing.length === 0) {
            notifs.dismiss(BINARY_NOTIF_ID);
          } else {
            notifs.upsert({
              id: BINARY_NOTIF_ID,
              kind: "error",
              title: "CLI binary unavailable",
              message: missing
                .map((c) => `${c.binary}: could not run '${c.binaryPath}'. Change its executable in Settings.`)
                .join("\n"),
              sticky: true,
              actions: [
                ...missing.map((c, index) => ({
                  label: `Configure ${c.binary === "claude" ? "Claude" : c.binary === "codex" ? "Codex" : "OpenCode"}`,
                  primary: index === 0,
                  onClick: () => openSettings(c.binary)
                })),
                { label: "Recheck", onClick: recheckVersions }
              ]
            });
          }

          if (failed.length === 0 && outdated.length === 0) {
            notifs.dismiss(VERSION_NOTIF_ID);
          } else {
            notifs.upsert({
              id: VERSION_NOTIF_ID,
              kind: "warning",
              title: failed.length > 0 ? "CLI version check failed" : "CLI out of date",
              message: [
                ...failed.map((c) => `${c.binary}: could not read the version from '${c.binaryPath}'`),
                ...outdated.map((c) => `${c.binary}: needs >= ${c.minimum}, found ${c.actual}`)
              ].join("\n"),
              sticky: true,
              actions: [
                { label: "Recheck", primary: true, onClick: recheckVersions },
                { label: "Dismiss", onClick: () => notifs.dismiss(VERSION_NOTIF_ID) }
              ]
            });
          }

          if (missing.length === 0 && failed.length === 0 && outdated.length === 0 && settingsVersion > 0) {
            notifs.push({ kind: "success", title: "CLI settings verified" });
          }
        })
        .catch((err) => {
          if (!active) return;
          const notifs = useNotifs.getState();
          notifs.upsert({
            id: BINARY_NOTIF_ID,
            kind: "error",
            title: "CLI binary check failed",
            message: err instanceof Error ? err.message : "Could not validate the configured CLI executables.",
            sticky: true,
            actions: [
              { label: "Configure Claude", primary: true, onClick: () => openSettings("claude") },
              { label: "Configure OpenCode", onClick: () => openSettings("opencode") },
              { label: "Configure Codex", onClick: () => openSettings("codex") },
              { label: "Recheck", onClick: recheckVersions }
            ]
          });
        });
    };
    recheckVersions();
    return () => {
      active = false;
    };
  }, [settingsVersion]);

  useEffect(() => {
    if (!activeSessionId) return;
    const onOpenAgents = () => {
      setRightVisible(activeSessionId, true);
      activateOrOpen(activeSessionId, "agents");
    };
    window.addEventListener("cw:open-agents", onOpenAgents);
    return () => window.removeEventListener("cw:open-agents", onOpenAgents);
  }, [activeSessionId, activateOrOpen, setRightVisible]);

  const messagesBySession = useAppStore((s) => s.messagesBySession);
  const subagentStats = useMemo(() => {
    const messages = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];
    const items = collectSubagents(messages);
    return {
      total: items.length,
      running: items.filter((item) => item.status === "running").length,
    };
  }, [messagesBySession, activeSessionId]);

  const { driver, hasPr, hasPreview, isToolAvailable, rightTop: topTool } = useToolAvailability(activeSessionId ?? undefined);
  const availableRightIds = tabsInPanel(dockByTab, "right").filter(isToolAvailable);
  const splitTool: DockableTabId | null =
    rightSplit !== null && rightSplit !== topTool && availableRightIds.includes(rightSplit) ? rightSplit : null;
  const allTabsClosed = DOCKABLE_TABS.every((id) => dockByTab[id] === "closed" || (id === "pr" && !hasPr));

  return (
    <div className={`app-shell${rightVisible && !settingsActive ? "" : " right-hidden"}`} data-driver={driver ?? "none"}>
      {preloadError && <div className="preload-error">{preloadError}</div>}
      {!preloadError && (
        <>
          <div className="app-body">
          <Sidebar onOpenSkills={() => setSkillsOpen(true)} skillsOpen={skillsOpen} hidden={settingsActive} />
          {mainView.kind === "settings" && (
            <SettingsNav active={navIdOf(mainView.section, mainView.harness)} onBack={() => void leaveSettings(() => usePrStore.getState().openSessionView())} />
          )}
          {mainView.kind === "settings" ? (
            <SettingsPage
              section={mainView.section}
              harness={mainView.harness}
              onBack={() => void leaveSettings(() => usePrStore.getState().openSessionView())}
              onOpenUsage={() => void leaveSettings(() => usePrStore.getState().openUsage())}
            />
          ) : mainView.kind === "inbox" ? (
            <PrInboxView />
          ) : mainView.kind === "pr" ? (
            <PrDetailView key={prKey(mainView.ref)} prRef={mainView.ref} />
          ) : mainView.kind === "usage" ? (
            <UsageView />
          ) : (
            <ThreadView />
          )}
          {rightPresence.mounted && (
            <aside
              className={`right${rightPresence.entered ? "" : " collapsed"}${dropRight.over || draggingTab !== null ? " drop-target-active" : ""}`}
              hidden={settingsActive}
              style={settingsActive ? { display: "none" } : { width: rightPresence.entered ? rightWidth : 0 }}
              {...dropRight.bind}
            >
              <div className="right-inner" style={{ width: rightWidth }}>
                <div
                  className="right-resizer"
                  onMouseDown={onResizeStart}
                  onDoubleClick={() => applyRightWidth(RIGHT_WIDTH_DEFAULT)}
                  title="Drag to resize · double-click to reset"
                />
                {activeSessionId && topTool !== null ? (
                  <RightPanelBody
                    sessionId={activeSessionId}
                    top={topTool}
                    split={splitTool}
                    ratio={rightSplitRatio}
                    onToolMenu={tabMenu.onTabMenuButton}
                  />
                ) : (
                  <div className="right-body">
                    <div className="right-empty">
                      {!activeSessionId
                        ? "No session selected."
                        : allTabsClosed
                          ? "Pick a tool from the rail to open it."
                          : "All tools are docked in other panels."}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          )}
          <ToolRail
            hidden={settingsActive}
            sessionId={activeSessionId ?? undefined}
            driver={driver}
            hasPr={hasPr}
            hasPreview={hasPreview}
            subagents={subagentStats}
            rightActive={topTool}
            rightSplit={splitTool}
            isToolAvailable={isToolAvailable}
            onToolContextMenu={tabMenu.onTabContextMenu}
          />
          {tabMenu.menuNode}
          </div>
          <WindowControls />
          {skillsOpen && <SkillsModal onClose={() => setSkillsOpen(false)} />}
          {runModal && <WorkflowRunModal request={runModal} />}
          <ShutdownDialog />
          {confirmDialog}
        </>
      )}
    </div>
  );
}
