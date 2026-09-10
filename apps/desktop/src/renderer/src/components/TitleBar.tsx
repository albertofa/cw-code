import { useEffect, useState } from "react";
import { Copy, Minus, Square, Terminal, X } from "lucide-react";
import { useAppStore } from "../stores/appStore.js";
import { useNotifs } from "./Notifications.js";

function DebugMenu() {
  const [open, setOpen] = useState(false);
  if (!window.cw.isDev) return null;

  const openTrace = async (): Promise<void> => {
    setOpen(false);
    try {
      const res = await window.cw.openHarnessTrace();
      if (!res.ok) {
        useNotifs.getState().push({
          kind: "error",
          title: "Could not open trace",
          message: res.error ?? res.path ?? "unknown error"
        });
      }
    } catch (err) {
      useNotifs.getState().push({
        kind: "error",
        title: "Could not open trace",
        message: (err as Error).message
      });
    }
  };

  return (
    <div className="menu titlebar-menu">
      <button
        className="menu-btn"
        aria-label="Debug"
        title="Debug"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="menu-value">Debug</span>
        <span className="menu-chevron">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu-panel" role="menu" aria-label="Debug">
            <div
              className="menu-row"
              role="menuitem"
              title="Open harness-trace.jsonl"
              onClick={() => void openTrace()}
            >
              <span className="menu-text">
                <span className="name">Open trace</span>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function TitleBar() {
  const { projects, sessionsByProject, activeProjectId, activeSessionId, pendingDriver } = useAppStore();
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    window.cw.isWindowMaximized().then(setMaxed).catch(() => {});
    return window.cw.onWindowMaximized(setMaxed);
  }, []);

  const sessions = activeProjectId ? (sessionsByProject[activeProjectId] ?? []) : [];
  const session = sessions.find((s) => s.id === activeSessionId);
  const project = projects.find((p) => p.id === activeProjectId);

  return (
    <div className="titlebar" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
      <div className="titlebar-brand">
        <Terminal size={13} />
        <span>cw·code</span>
      </div>
      <DebugMenu />
      <div className="titlebar-crumb">
        {project && session ? (
          <span title={`${project.name} / ${session.title}`}>
            {project.name} <span className="sep">/</span> <strong>{session.title}</strong>
          </span>
        ) : project && pendingDriver ? (
          <span title={`${project.name} / New thread`}>
            {project.name} <span className="sep">/</span> <strong>New thread</strong>
          </span>
        ) : (
          <span> </span>
        )}
      </div>
      <div className="win-controls" onDoubleClick={(e) => e.stopPropagation()}>
        <button className="win-btn" onClick={() => window.cw.minimizeWindow()} title="Minimize" aria-label="Minimize">
          <Minus size={14} />
        </button>
        <button
          className="win-btn"
          onClick={() => window.cw.toggleMaximizeWindow()}
          title={maxed ? "Restore" : "Maximize"}
          aria-label={maxed ? "Restore" : "Maximize"}
        >
          {maxed ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button className="win-btn close" onClick={() => window.cw.closeWindow()} title="Close" aria-label="Close">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
