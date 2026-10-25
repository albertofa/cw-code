import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { applyAppearance } from "./appearanceFonts.js";
import { ThemeSync } from "./components/ThemeSync.js";
import { HarnessNotices } from "./components/HarnessNotices.js";
import { collectSubagents } from "./components/subagents.js";
import { useThreadItemsSelect } from "./components/useThread.js";
import { Sidebar } from "./components/Sidebar.js";
import { WindowControls } from "./components/WindowControls.js";
import { SkillsModal } from "./components/SkillsModal.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { SettingsNav } from "./components/SettingsNav.js";
import { useConfirm } from "./components/ConfirmDialog.js";
import { navIdOf, sectionSummary, unsavedSectionLabels } from "./components/settingsSections.js";
import { ThreadView } from "./components/ThreadView.js";
import { GitHubView } from "./components/GitHubView.js";
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
import { useResizableWidth } from "./components/useResizableWidth.js";
import { usePanelAnimationMs, usePresence } from "./components/usePresence.js";
import { Notifications } from "./components/Notifications.js";
import { useNotificationSounds } from "./components/useNotificationSounds.js";
import { useHoldPrs } from "./components/usePrs.js";
import { visibleLayerOpen } from "./components/openLayer.js";
import { useAppStore, type ChatMessage } from "./stores/appStore.js";
import { rightOpenTabs } from "./stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "./stores/panelStore.js";
import { usePrStore } from "./stores/prStore.js";
import { useSkillsStore } from "./stores/skillsStore.js";
import { projectDirty, useSettingsDraftStore } from "./stores/settingsDraftStore.js";
import { prKey } from "./components/prInbox.js";
import { startAppBridge } from "./server/appBridge.js";
import { startSidebarBridge } from "./server/sidebarBridge.js";
import { useHoldGit } from "./components/useGit.js";

const RIGHT_WIDTH_DEFAULT = 520;
const SIDE_WIDTH_DEFAULT = 320;

interface SubagentStats {
  total: number;
  running: number;
}

function subagentStatsOf(items: ChatMessage[]): SubagentStats {
  const subagents = collectSubagents(items);
  return { total: subagents.length, running: subagents.filter((item) => item.status === "running").length };
}

function sameSubagentStats(a: SubagentStats, b: SubagentStats): boolean {
  return a.total === b.total && a.running === b.running;
}

export function App() {
  useHoldPrs();
  useNotificationSounds();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const mainView = usePrStore((s) => s.mainView);
  const runModal = usePrStore((s) => s.runModal);
  const appearance = useAppStore((s) => s.appearance);
  const sessionPanel = usePanelStore((s) => selectSessionPanel(s, activeSessionId ?? undefined));
  const { dockByTab, rightVisible } = sessionPanel;
  const initializeSession = usePanelStore((s) => s.initializeSession);
  const activateOrOpen = usePanelStore((s) => s.activateOrOpen);
  const dropRight = useDockDrop("right", activeSessionId ?? undefined);
  const tabMenu = useTabMenu(activeSessionId ?? undefined);
  const draggingTab = usePanelStore((s) => s.draggingTab);
  const setRightVisible = usePanelStore((s) => s.setRightVisible);

  useEffect(() => applyAppearance(document.documentElement, appearance), [appearance]);

  const panelAnimationMs = usePanelAnimationMs();
  const rightResize = useResizableWidth({ storageKey: "cw-code:rightWidth", min: 320, max: 800, grow: "left" });
  const rightWidth = rightResize.width ?? RIGHT_WIDTH_DEFAULT;
  const sideResize = useResizableWidth({ storageKey: "cw-code:sidebarWidth", min: 220, max: 480, grow: "right" });
  const shellStyle: CSSProperties & { "--side-w"?: string } = sideResize.width === null ? {} : { "--side-w": `${sideResize.width}px` };
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const settingsActive = mainView.kind === "settings";

  const leaveSettings = useCallback(
    async (go: () => void) => {
      const drafts = useSettingsDraftStore.getState();
      if (usePrStore.getState().mainView.kind === "settings" && drafts.dirty) {
        const changed = unsavedSectionLabels(drafts.saved, drafts.draft, projectDirty(drafts));
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

  const sideWidthNow = () =>
    document.querySelector<HTMLElement>(".app-body > .side:not([hidden])")?.offsetWidth ?? sideResize.width ?? SIDE_WIDTH_DEFAULT;

  useEffect(() => {
    if (!window.cw) {
      setPreloadError("window.cw is missing — preload did not load. Restart the Electron app (plain browsers can't reach the backend).");
      return;
    }
    const offProject = window.cw.onProjectChanged((project) => useAppStore.getState().applyProject(project));
    const offApp = startAppBridge();
    const offSidebar = startSidebarBridge();
    const offSkills = window.cw.onSkillsChanged((result) => useSkillsStore.getState().applyList(result));
    const offComposer = window.cw.onComposerChanged(({ sessionId, prefs }) => useAppStore.getState().applyComposer(sessionId, prefs));
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
      } else if ((e.key.toLowerCase() === "p" && !e.shiftKey) || (e.key.toLowerCase() === "f" && e.shiftKey)) {
        const sessionId = useAppStore.getState().activeSessionId;
        if (!sessionId || visibleLayerOpen()) return;
        e.preventDefault();
        usePanelStore.getState().requestFilesCommand(sessionId, e.key.toLowerCase() === "p" ? "quickOpen" : "search");
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
      offProject();
      offApp();
      offSidebar();
      offSkills();
      offComposer();
      offUpdates();
      offShutdown();
      offShutdownExpired();
      window.removeEventListener("keydown", onKey);
    };
  }, []);


  useHoldGit(activeSessionId);

  useEffect(() => {
    if (!activeSessionId) return;
    const onOpenAgents = () => {
      setRightVisible(activeSessionId, true);
      activateOrOpen(activeSessionId, "agents");
    };
    window.addEventListener("cw:open-agents", onOpenAgents);
    return () => window.removeEventListener("cw:open-agents", onOpenAgents);
  }, [activeSessionId, activateOrOpen, setRightVisible]);

  const subagentStats = useThreadItemsSelect(activeSessionId, subagentStatsOf, sameSubagentStats);

  const { driver, hasPr, hasPreview, isToolAvailable, rightTop: topTool } = useToolAvailability(activeSessionId ?? undefined);

  useEffect(() => {
    if (!activeSessionId) return;
    initializeSession(activeSessionId);
  }, [activeSessionId, initializeSession]);
  const rightTabs = rightOpenTabs(dockByTab, isToolAvailable);
  const rightShown = rightVisible && topTool !== null;
  const rightPresence = usePresence(rightShown, panelAnimationMs);

  return (
    <div
      className={`app-shell${rightShown && !settingsActive ? "" : " right-hidden"}${settingsActive ? " rail-hidden" : ""}`}
      data-driver={driver ?? "none"}
      style={shellStyle}
    >
      <ThemeSync />
      <HarnessNotices />
      {preloadError && <div className="preload-error">{preloadError}</div>}
      {!preloadError && (
        <>
          <div className="app-body">
          <Sidebar onOpenSkills={() => setSkillsOpen(true)} skillsOpen={skillsOpen} hidden={settingsActive} />
          {mainView.kind === "settings" && (
            <SettingsNav active={navIdOf(mainView.section, mainView.harness)} onBack={() => void leaveSettings(() => usePrStore.getState().openSessionView())} />
          )}
          {!settingsActive && (
            <div className="side-resizer-slot">
              <div
                className="side-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                aria-valuemin={220}
                aria-valuemax={480}
                aria-valuenow={sideResize.width ?? undefined}
                tabIndex={0}
                title="Drag to resize · double-click to reset"
                onMouseDown={(e) => sideResize.onResizeStart(e, sideWidthNow())}
                onKeyDown={(e) => sideResize.onResizeKey(e, sideWidthNow())}
                onDoubleClick={() => sideResize.setWidth(null)}
              />
            </div>
          )}
          <div className="main-col">
            {mainView.kind === "settings" ? (
              <SettingsPage
                section={mainView.section}
                harness={mainView.harness}
                workflowId={mainView.workflowId}
                projectId={mainView.projectId}
                onBack={() => void leaveSettings(() => usePrStore.getState().openSessionView())}
                onOpenUsage={() => void leaveSettings(() => usePrStore.getState().openUsage())}
              />
            ) : mainView.kind === "github" ? (
              <GitHubView />
            ) : mainView.kind === "pr" ? (
              <PrDetailView key={prKey(mainView.ref)} prRef={mainView.ref} />
            ) : mainView.kind === "usage" ? (
              <UsageView />
            ) : null}
            <ThreadView hidden={mainView.kind !== "session"} />
            <Notifications />
          </div>
          {rightPresence.mounted && topTool !== null && activeSessionId !== null && (
            <aside
              className={`right${rightPresence.entered ? "" : " collapsed"}${dropRight.over || draggingTab !== null ? " drop-target-active" : ""}`}
              hidden={settingsActive}
              style={settingsActive ? { display: "none" } : { width: rightPresence.entered ? rightWidth : 0 }}
              {...dropRight.bind}
            >
              <div className="right-inner" style={{ width: rightWidth }}>
                <div
                  className="right-resizer"
                  onMouseDown={(e) => rightResize.onResizeStart(e, rightWidth)}
                  onDoubleClick={() => rightResize.setWidth(null)}
                  title="Drag to resize · double-click to reset"
                />
                <RightPanelBody
                  sessionId={activeSessionId}
                  tabs={rightTabs}
                  top={topTool}
                  onToolMenu={tabMenu.onTabMenuButton}
                  onToolContextMenu={tabMenu.onTabContextMenu}
                />
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
