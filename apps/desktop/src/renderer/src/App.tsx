import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Bot, Code, Columns2, Eye, Folder, GitBranch, Orbit, PanelRightClose, PanelRightOpen, Sparkles, Terminal, type LucideIcon } from "lucide-react";
import type { DriverName } from "./cw.js";
import { Sidebar } from "./components/Sidebar.js";
import { SkillsModal } from "./components/SkillsModal.js";
import { TitleBar } from "./components/TitleBar.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { ThreadView } from "./components/ThreadView.js";
import { FilePanel } from "./components/FilePanel.js";
import { GitInspectPanel } from "./components/GitInspectPanel.js";
import { AgentsPanel } from "./components/AgentsPanel.js";
import { PreviewPanel } from "./components/PreviewPanel.js";
import { PtyTab } from "./components/PtyTab.js";
import { useNotifs } from "./components/Notifications.js";
import { useAppStore } from "./stores/appStore.js";
import type { TurnEvent } from "./cw.js";

type RightTab = "files" | "agents" | "diff" | DriverName | "shell" | "preview";

function isHarnessTab(tab: RightTab): tab is DriverName {
  return tab === "claude" || tab === "opencode" || tab === "codex";
}

interface TabDef {
  id: RightTab;
  title: string;
  Icon: LucideIcon;
  driver?: DriverName;
}

const TABS: TabDef[] = [
  { id: "files", title: "Files", Icon: Folder },
  { id: "agents", title: "Subagents", Icon: Bot },
  { id: "diff", title: "Git diff", Icon: GitBranch },
  { id: "claude", title: "Claude terminal", Icon: Sparkles, driver: "claude" },
  { id: "opencode", title: "OpenCode terminal", Icon: Code, driver: "opencode" },
  { id: "codex", title: "Codex terminal", Icon: Orbit, driver: "codex" },
  { id: "shell", title: "Shell terminal", Icon: Terminal }
];

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
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const pendingDriver = useAppStore((s) => s.pendingDriver);
  const preview = useAppStore((s) => s.preview);
  const sourceControlRefreshIntervalSeconds = useAppStore((s) => s.sourceControlRefreshIntervalSeconds);
  const holdingHours = useAppStore((s) => s.holdingHours);
  const settingsVersion = useAppStore((s) => s.settingsVersion);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const closePreview = useAppStore((s) => s.closePreview);
  const [rightTab, setRightTab] = useState<RightTab>("files");
  const [rightSplit, setRightSplit] = useState(false);
  const [rightVisible, setRightVisible] = useState(true);
  const [rightWidth, setRightWidth] = useState(loadRightWidth);
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsHarness, setSettingsHarness] = useState<DriverName>("claude");
  const [skillsOpen, setSkillsOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const openSettings = (harness: DriverName = "claude") => {
    setSettingsHarness(harness);
    setSettingsOpen(true);
  };

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
    };
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      offTitle();
      flushPendingDeltas();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const activeSessionKey = activeProjectId
    ? (sessionsByProject[activeProjectId] ?? []).map((session) => session.id).join("|")
    : "";

  useEffect(() => {
    if (!activeProjectId || !activeSessionKey) return;
    let running = false;
    const refresh = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const current = useAppStore.getState();
        const sessions = current.sessionsByProject[activeProjectId] ?? [];
        for (let i = 0; i < sessions.length; i += 6) {
          await Promise.all(sessions.slice(i, i + 6).map((session) => current.refreshGitStatus(session.id)));
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
  }, [activeProjectId, activeSessionKey, sourceControlRefreshIntervalSeconds]);

  useEffect(() => {
    if (!window.cw) return;
    const expire = () => void useAppStore.getState().expireHoldingSessions();
    expire();
    const timer = window.setInterval(expire, 60_000);
    return () => window.clearInterval(timer);
  }, [holdingHours]);

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
    if (preview) {
      setRightVisible(true);
      setRightTab("preview");
    }
  }, [preview]);

  useEffect(() => {
    const onOpenAgents = () => {
      setRightVisible(true);
      setRightTab("agents");
    };
    window.addEventListener("cw:open-agents", onOpenAgents);
    return () => window.removeEventListener("cw:open-agents", onOpenAgents);
  }, []);

  const allSessions = Object.values(sessionsByProject).flat();
  const driver = pendingDriver ?? allSessions.find((s) => s.id === activeSessionId)?.driver;

  const visibleTabs = TABS.filter((t) => t.driver === undefined || t.driver === driver);
  const activeTab: RightTab = isHarnessTab(rightTab) && rightTab !== driver ? (driver ?? "files") : rightTab;

  const splitTab: RightTab = isHarnessTab(activeTab) || activeTab === "shell" ? "files" : "shell";
  const tabTitle = (tab: RightTab): string => {
    if (tab === "preview") return "Preview";
    return TABS.find((item) => item.id === tab)?.title ?? tab;
  };
  const renderRightContent = (tab: RightTab, suffix = "main") => (
    <>
      {activeSessionId && tab === "files" && <FilePanel sessionId={activeSessionId} />}
      {activeSessionId && tab === "agents" && <AgentsPanel sessionId={activeSessionId} />}
      {activeSessionId && tab === "diff" && <GitInspectPanel sessionId={activeSessionId} />}
      {tab === "preview" && preview && (
        <PreviewPanel
          key={`${preview.sessionId}:${preview.path}:${suffix}`}
          sessionId={preview.sessionId}
          path={preview.path}
          basePath={preview.basePath}
          onClose={() => {
            closePreview();
            setRightTab("files");
          }}
        />
      )}
      {activeSessionId && (tab === "claude" || tab === "opencode" || tab === "codex" || tab === "shell") && (
        <PtyTab key={`${activeSessionId}-${tab}-${suffix}`} sessionId={activeSessionId} kind={tab} />
      )}
    </>
  );

  return (
    <div className="app-shell" data-driver={driver ?? "none"}>
      {preloadError && <div className="preload-error">{preloadError}</div>}
      {!preloadError && (
        <>
          <TitleBar />
          <div className="app-body">
          <Sidebar onOpenSettings={() => openSettings()} onOpenSkills={() => setSkillsOpen(true)} skillsOpen={skillsOpen} />
          <ThreadView />
          {!rightVisible && (
            <button
              className="right-restore"
              onClick={() => setRightVisible(true)}
              title="Restore panel"
              aria-label="Restore panel"
            >
              <PanelRightOpen size={14} />
            </button>
          )}
          {rightVisible && (
            <aside className="right" style={{ width: rightWidth }}>
              <div
                className="right-resizer"
                onMouseDown={onResizeStart}
                onDoubleClick={() => applyRightWidth(RIGHT_WIDTH_DEFAULT)}
                title="Drag to resize · double-click to reset"
              />
              <div className="tabbar">
                {visibleTabs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setRightTab(t.id)}
                    className={`tab${activeTab === t.id ? " active" : ""}`}
                    title={t.title}
                    aria-label={t.title}
                  >
                    <t.Icon size={15} className={t.driver ? `driver-icon ${t.driver}` : undefined} />
                    {activeTab === t.id && <span className="tab-label">{t.title}</span>}
                  </button>
                ))}
                {preview && (
                  <button
                    onClick={() => setRightTab("preview")}
                    className={`tab${activeTab === "preview" ? " active" : ""}`}
                    title="Preview"
                    aria-label="Preview"
                  >
                    <Eye size={15} />
                    {activeTab === "preview" && <span className="tab-label">Preview</span>}
                  </button>
                )}
                <button
                  className={`tab tab-split${rightSplit ? " active" : ""}`}
                  onClick={() => setRightSplit((value) => !value)}
                  title={rightSplit ? "Close split panel" : `Split panel with ${tabTitle(splitTab)}`}
                  aria-label={rightSplit ? "Close split panel" : `Split panel with ${tabTitle(splitTab)}`}
                  aria-pressed={rightSplit}
                >
                  <Columns2 size={15} />
                </button>
                <button
                  className="tab tab-min"
                  onClick={() => setRightVisible(false)}
                  title="Minimize panel"
                  aria-label="Minimize panel"
                >
                  <PanelRightClose size={15} />
                </button>
              </div>
              <div className={`right-body${rightSplit ? " right-body-split" : ""}`}>
                {!activeSessionId && !preview && <div className="right-empty">No session selected.</div>}
                {(activeSessionId || preview) && (
                  rightSplit ? (
                    <>
                      <section className="right-split-pane right-split-primary">
                        <div className="right-split-label">{tabTitle(activeTab)}</div>
                        <div className="right-split-content">{renderRightContent(activeTab)}</div>
                      </section>
                      <section className="right-split-pane right-split-secondary">
                        <div className="right-split-label">{tabTitle(splitTab)}</div>
                        <div className="right-split-content">{renderRightContent(splitTab, "split")}</div>
                      </section>
                    </>
                  ) : renderRightContent(activeTab)
                )}
              </div>
            </aside>
          )}
          </div>
          {settingsOpen && (
            <SettingsModal initialHarness={settingsHarness} onClose={() => setSettingsOpen(false)} />
          )}
          {skillsOpen && <SkillsModal onClose={() => setSkillsOpen(false)} />}
        </>
      )}
    </div>
  );
}
