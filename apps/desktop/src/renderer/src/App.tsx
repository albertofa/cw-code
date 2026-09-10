import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Bot, Code, Eye, Folder, GitBranch, Orbit, PanelRightClose, Sparkles, Terminal, type LucideIcon } from "lucide-react";
import type { DriverName } from "./cw.js";
import { Sidebar } from "./components/Sidebar.js";
import { TitleBar } from "./components/TitleBar.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { ThreadView } from "./components/ThreadView.js";
import { DiffPanel, FilePanel } from "./components/FilePanel.js";
import { AgentsPanel } from "./components/AgentsPanel.js";
import { PreviewPanel } from "./components/PreviewPanel.js";
import { PtyTab } from "./components/PtyTab.js";
import { useNotifs } from "./components/Notifications.js";
import { useAppStore } from "./stores/appStore.js";
import type { TurnEvent } from "./cw.js";

type RightTab = "files" | "agents" | "diff" | DriverName | "shell" | "preview";

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
const RIGHT_WIDTH_DEFAULT = 480;
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

export function App() {
  const { activeProjectId, activeSessionId, sessionsByProject, pendingDriver, preview } = useAppStore();
  const store = useAppStore();
  const [rightTab, setRightTab] = useState<RightTab>("files");
  const [rightVisible, setRightVisible] = useState(true);
  const [rightWidth, setRightWidth] = useState(loadRightWidth);
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsHarness, setSettingsHarness] = useState<DriverName>("claude");
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
    void store.loadProjects();
    const off = window.cw.onTurnEvent((msg: { sessionId: string; event: TurnEvent }) => {
      useAppStore.getState().applyEvent(msg.sessionId, msg.event);
    });
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
      window.removeEventListener("keydown", onKey);
    };
  }, []);

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

          if (missing.length === 0 && failed.length === 0 && outdated.length === 0 && store.settingsVersion > 0) {
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
  }, [store.settingsVersion]);

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

  const sessions = activeProjectId ? (sessionsByProject[activeProjectId] ?? []) : [];
  const driver = pendingDriver ?? sessions.find((s) => s.id === activeSessionId)?.driver;

  return (
    <div className="app-shell" data-driver={driver ?? "none"}>
      {preloadError && <div className="preload-error">{preloadError}</div>}
      {!preloadError && (
        <>
          <TitleBar />
          <div className="app-body">
          <Sidebar onOpenSettings={() => openSettings()} />
          <ThreadView rightVisible={rightVisible} onToggleRight={() => setRightVisible((v) => !v)} />
          {rightVisible && (
            <aside className="right" style={{ width: rightWidth }}>
              <div
                className="right-resizer"
                onMouseDown={onResizeStart}
                onDoubleClick={() => applyRightWidth(RIGHT_WIDTH_DEFAULT)}
                title="Drag to resize · double-click to reset"
              />
              <div className="tabbar">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setRightTab(t.id)}
                    className={`tab${rightTab === t.id ? " active" : ""}`}
                    title={t.title}
                    aria-label={t.title}
                  >
                    <t.Icon size={15} className={t.driver ? `driver-icon ${t.driver}` : undefined} />
                  </button>
                ))}
                {preview && (
                  <button
                    onClick={() => setRightTab("preview")}
                    className={`tab${rightTab === "preview" ? " active" : ""}`}
                    title="Preview"
                    aria-label="Preview"
                  >
                    <Eye size={15} />
                  </button>
                )}
                <button
                  className="tab tab-min"
                  onClick={() => setRightVisible(false)}
                  title="Minimize panel"
                  aria-label="Minimize panel"
                >
                  <PanelRightClose size={15} />
                </button>
              </div>
              <div className="right-body">
                {!activeSessionId && !preview && <div className="right-empty">No session selected.</div>}
                {activeSessionId && rightTab === "files" && <FilePanel sessionId={activeSessionId} />}
                {activeSessionId && rightTab === "agents" && <AgentsPanel sessionId={activeSessionId} />}
                {activeSessionId && rightTab === "diff" && <DiffPanel sessionId={activeSessionId} />}
                {rightTab === "preview" && preview && (
                  <PreviewPanel
                    key={`${preview.sessionId}:${preview.path}`}
                    sessionId={preview.sessionId}
                    path={preview.path}
                    basePath={preview.basePath}
                    onClose={() => {
                      store.closePreview();
                      setRightTab("files");
                    }}
                  />
                )}
                {activeSessionId && (rightTab === "claude" || rightTab === "opencode" || rightTab === "codex" || rightTab === "shell") && (
                  <PtyTab key={`${activeSessionId}-${rightTab}`} sessionId={activeSessionId} kind={rightTab} />
                )}
              </div>
            </aside>
          )}
          </div>
          {settingsOpen && (
            <SettingsModal initialHarness={settingsHarness} onClose={() => setSettingsOpen(false)} />
          )}
        </>
      )}
    </div>
  );
}
