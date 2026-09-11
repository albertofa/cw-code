import { useState, type CSSProperties } from "react";
import { Settings, SquarePen } from "lucide-react";
import type { Project, Session, SessionStatus } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { useNotifs } from "./Notifications.js";

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initials(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase() || "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarStyle(name: string): CSSProperties {
  return { background: `hsl(${hashHue(name)} 45% 32%)` };
}

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { projects, sessionsByProject, discoveredByProject, activeProjectId, activeSessionId, gitStatusBySession } = useAppStore();
  const store = useAppStore();
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [managedId, setManagedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const sessions = activeProjectId ? (sessionsByProject[activeProjectId] ?? []) : [];
  const discovered = activeProjectId ? (discoveredByProject[activeProjectId] ?? []) : [];
  const matchesQuery = (s: Session) =>
    !query || s.title.toLowerCase().includes(query.toLowerCase());
  const byRecency = (a: Session, b: Session) => {
    if ((a.status === "input-required") !== (b.status === "input-required")) {
      return a.status === "input-required" ? -1 : 1;
    }
    return b.updatedAt - a.updatedAt;
  };
  const shown = sessions
    .filter((s) => s.status !== "resolved" && s.status !== "archived")
    .filter(matchesQuery)
    .sort(byRecency);
  const resolved = sessions.filter((s) => s.status === "resolved").filter(matchesQuery).sort(byRecency);
  const visibleProjects = projectQuery
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(projectQuery.toLowerCase()) ||
          p.rootPath.toLowerCase().includes(projectQuery.toLowerCase())
      )
    : projects;

  const closePicker = () => {
    setPickerOpen(false);
    setProjectQuery("");
    setManagedId(null);
  };

  const pick = (id: string) => {
    closePicker();
    void store.selectProject(id);
  };

  const pickAndAdd = () => {
    void window.cw
      .pickProjectDir()
      .then((dir) => {
        if (!dir) return;
        return store.addProject(dir).then(() => closePicker());
      })
      .catch((err: Error) => {
        useNotifs.getState().push({ kind: "error", title: "Could not add project", message: err.message });
      });
  };

  const copyPath = (p: Project) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(p.rootPath)
      .then(() => {
        setCopiedId(p.id);
        window.setTimeout(() => setCopiedId((id) => (id === p.id ? null : id)), 1500);
      })
      .catch(() => {});
  };

  const commitRename = (sessionId: string) => {
    const draft = renameDraft.trim();
    setRenamingId(null);
    if (!draft) return;
    void store.renameSession(sessionId, draft).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not rename session", message: err.message });
    });
  };

  const setStatus = (sessionId: string, status: SessionStatus) => {
    setMenu(null);
    void store.setSessionStatus(sessionId, status).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not update session", message: err.message });
    });
  };

  const renderRow = (s: Session) => {
    const git = gitStatusBySession[s.id];
    const pr = git?.pullRequest;
    const prState = pr?.isDraft
      ? "draft"
      : pr?.state !== "OPEN"
        ? pr?.state.toLowerCase()
        : pr?.checks.failed
          ? "failing"
          : pr?.checks.pending
            ? "pending"
            : pr?.reviewDecision === "APPROVED"
              ? "approved"
              : pr?.reviewDecision === "CHANGES_REQUESTED" ? "changes-requested" : "open";
    const status = s.status ?? "idle";
    return <div
      key={s.id}
      onClick={() => store.selectSession(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setRenamingId(null);
        setMenu({ sessionId: s.id, x: e.clientX, y: e.clientY });
      }}
      className={`session-row${s.id === activeSessionId ? " active" : ""}`}
      title={s.title}
    >
      <span className={`state-dot status-${status}`} title={status} />
      <span className="session-copy">
      {renamingId === s.id ? (
        <input
          autoFocus
          className="session-rename"
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitRename(s.id);
            if (e.key === "Escape") setRenamingId(null);
          }}
          onBlur={() => commitRename(s.id)}
        />
      ) : (
        <span className="session-title">{s.title}</span>
      )}
        <span className="session-git" title={git?.worktreePath ?? s.worktreePath}>
          <span>{git?.worktreeName ?? (s.worktreePath ? s.worktreePath.split(/[/\\]/).pop() : "project")}</span>
          <span className="session-branch">{git?.branch ?? s.branch ?? "Git status loading…"}</span>
          {pr && <span className={`session-pr ${prState}`}>#{pr.number} {prState?.replace("-", " ")}</span>}
          {git && !git.clean && <span className="session-dirty">{git.dirtyCount}Δ</span>}
        </span>
      </span>
      <DriverIcon driver={s.driver} size={12} />
    </div>
  };

  return (
    <div className="side" onClick={() => setMenu(null)}>
      <div className="brand">
        <div className="search-row ghost">
          <span className="search-icon">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
          />
          {query && (
            <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </div>
        <div className="project-bar">
          <div className="picker">
            <button className="picker-btn" onClick={() => setPickerOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={pickerOpen}>
            <span className="picker-icon">▤</span>
            <span className="picker-name">{activeProject?.name ?? "Select project…"}</span>
            <span className="picker-chevron">{pickerOpen ? "▴" : "▾"}</span>
          </button>
          {pickerOpen && (
            <>
              <div className="picker-backdrop" onClick={closePicker} />
              <div
                className="picker-panel"
                role="listbox"
                onKeyDown={(e) => {
                  if (e.key === "Escape") closePicker();
                  if (e.key === "Enter" && visibleProjects.length > 0 && document.activeElement?.tagName === "INPUT") {
                    pick(visibleProjects[0].id);
                  }
                }}
              >
        <div className="search-row">
                  <span className="search-icon">⌕</span>
                  <input
                    autoFocus
                    value={projectQuery}
                    onChange={(e) => setProjectQuery(e.target.value)}
                    placeholder="Search projects…"
                  />
                </div>
                <div className="picker-list">
                  {visibleProjects.map((p) => (
                    <div key={p.id}>
                      <div
                        className={`picker-row${p.id === activeProjectId ? " active" : ""}`}
                        onClick={() => pick(p.id)}
                        role="option"
                        aria-selected={p.id === activeProjectId}
                        title={p.rootPath}
                      >
                        <span className="avatar" style={avatarStyle(p.name)}>
                          {initials(p.name)}
                        </span>
                        <span className="name">{p.name}</span>
                        <button
                          className={`gear${managedId === p.id ? " open" : ""}`}
                          title="Project details"
                          onClick={(e) => {
                            e.stopPropagation();
                            setManagedId((id) => (id === p.id ? null : p.id));
                          }}
                        >
                          ⚙
                        </button>
                      </div>
                      {managedId === p.id && (
                        <div className="manage">
                          <span className="path" title={p.rootPath}>
                            {p.rootPath}
                          </span>
                          <button
                            className="btn"
                            style={{ fontSize: 11, padding: "3px 8px" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              copyPath(p);
                            }}
                          >
                            {copiedId === p.id ? "✓" : "Copy"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {visibleProjects.length === 0 && <div className="side-empty">No matches.</div>}
                </div>
                <button className="add-project" onClick={pickAndAdd}>
                  Add project…
                </button>
              </div>
            </>
          )}
          </div>
          <button
            className="new-session-btn"
            disabled={!activeProjectId}
            onClick={() => store.startNewSession()}
            title="New session"
            aria-label="New session"
          >
            <SquarePen size={14} />
          </button>
        </div>
      </div>
      <div className="session-list">
        {shown.map(renderRow)}
        {shown.length === 0 && <div className="side-empty">{query ? "No matches." : "No sessions yet."}</div>}
        {resolved.length > 0 && (
          <details className="resolved">
            <summary>resolved · {resolved.length}</summary>
            {resolved.map(renderRow)}
          </details>
        )}
        {discovered.length > 0 && (
          <details className="discovered">
            <summary>from cli · {discovered.length}</summary>
            {discovered.map((s) => (
              <div key={s.id} className="discovered-row" title={s.title}>
                <span className={`state-dot status-${s.status ?? "idle"}`} title={s.status ?? "idle"} />
                <span className="session-title">{s.title}</span>
                <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => void store.importDiscovered(s)} title="Import into cw-code">
                  Import
                </button>
              </div>
            ))}
          </details>
        )}
      </div>
      {menu && (
        <>
          <div
            className="ctx-backdrop"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 160), top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-item"
              onClick={() => {
                const target = sessions.find((s) => s.id === menu.sessionId);
                setRenameDraft(target?.title ?? "");
                setRenamingId(menu.sessionId);
                setMenu(null);
              }}
            >
              Rename
            </button>
            <button className="ctx-item" onClick={() => setStatus(menu.sessionId, "idle")}>
              Mark as Idle
            </button>
            <button className="ctx-item" onClick={() => setStatus(menu.sessionId, "done")}>
              Mark as Done
            </button>
            <button className="ctx-item" onClick={() => setStatus(menu.sessionId, "resolved")}>
              Mark as Resolved
            </button>
            <button className="ctx-item" onClick={() => setStatus(menu.sessionId, "archived")}>
              Archive
            </button>
          </div>
        </>
      )}
      <div className="side-footer">
        <button className="icon-btn" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
          <Settings size={15} />
        </button>
      </div>
    </div>
  );
}
