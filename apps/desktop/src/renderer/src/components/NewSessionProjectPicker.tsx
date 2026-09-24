import { useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Folder, FolderPlus, Search } from "lucide-react";
import type { Project } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { projectAvatarStyle, projectInitials } from "./avatar.js";
import { shortenHome } from "./pathDisplay.js";
import { projectsByRecentActivity } from "./projectRecency.js";
import { useNotifs } from "./Notifications.js";

export function NewSessionProjectPicker({ project }: { project: Project | undefined }) {
  const projects = useAppStore((s) => s.projects);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const homeDir = useAppStore((s) => s.homeDir);
  const setPendingProject = useAppStore((s) => s.setPendingProject);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const q = query.trim().toLowerCase();
  const ordered = projectsByRecentActivity(projects, sessionsByProject);
  const visible = q
    ? ordered.filter((p) => p.name.toLowerCase().includes(q) || p.rootPath.toLowerCase().includes(q))
    : ordered;

  const pick = (id: string) => {
    close();
    if (id === project?.id) return;
    void setPendingProject(id).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not switch project", message: err.message });
    });
  };

  return (
    <span className="picker newthread-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`newthread-project-btn${project ? "" : " unset"}${open ? " open" : ""}`}
        onClick={() => {
          setQuery("");
          setOpen((o) => !o);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={project ? shortenHome(project.rootPath, homeDir ?? undefined) : "Choose the project for this session"}
      >
        {project ? (
          <span className="avatar" style={projectAvatarStyle(project.name)} aria-hidden="true">
            {projectInitials(project.name)}
          </span>
        ) : (
          <Folder size={18} aria-hidden="true" />
        )}
        <span className="newthread-project-name">{project?.name ?? "Choose a project"}</span>
        <span className="newthread-project-chevron" aria-hidden="true">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>
      {open && (
        <>
          <span className="picker-backdrop" onClick={close} />
          <span
            className="picker-panel newthread-picker-panel"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
                triggerRef.current?.focus();
                return;
              }
              if (e.key === "Enter" && visible.length > 0 && document.activeElement?.tagName === "INPUT") {
                pick(visible[0].id);
              }
            }}
          >
            <span className="search-row">
              <Search className="search-icon" aria-hidden="true" size={15} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects"
                aria-label="Search projects"
              />
            </span>
            <span className="picker-list" role="listbox" aria-label="Projects">
              {visible.map((p) => (
                <span
                  key={p.id}
                  className={`picker-row${p.id === project?.id ? " active" : ""}`}
                  onClick={() => pick(p.id)}
                  role="option"
                  aria-selected={p.id === project?.id}
                  title={p.rootPath}
                >
                  <span className="avatar sm" style={projectAvatarStyle(p.name)} aria-hidden="true">
                    {projectInitials(p.name)}
                  </span>
                  <span className="name newthread-picker-name">{p.name}</span>
                  <span className="newthread-picker-path">{shortenHome(p.rootPath, homeDir ?? undefined)}</span>
                  <span className="newthread-picker-check" aria-hidden="true">
                    {p.id === project?.id ? <Check size={14} /> : null}
                  </span>
                </span>
              ))}
              {visible.length === 0 && (
                <span className="side-empty">{projects.length === 0 ? "No projects yet." : "No matches."}</span>
              )}
            </span>
          </span>
        </>
      )}
    </span>
  );
}

export function NewSessionAddProject() {
  const addProjectForNewSession = useAppStore((s) => s.addProjectForNewSession);
  const [adding, setAdding] = useState(false);

  const addFolder = () => {
    setAdding(true);
    void window.cw
      .pickProjectDir()
      .then((dir) => (dir ? addProjectForNewSession(dir) : undefined))
      .catch((err: Error) => {
        useNotifs.getState().push({ kind: "error", title: "Could not add project", message: err.message });
      })
      .finally(() => setAdding(false));
  };

  return (
    <button type="button" className="newthread-add-project" onClick={addFolder} disabled={adding} title="Add project" aria-label="Add project">
      <FolderPlus size={16} aria-hidden="true" />
    </button>
  );
}
