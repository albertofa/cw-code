import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Check, ChevronDown, ChevronUp, Folder, Plus, Search } from "lucide-react";
import type { Project } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { ProjectMonogram } from "./ProjectMonogram.js";
import { shortenHome } from "./pathDisplay.js";
import { projectsByRecentActivity } from "./projectRecency.js";
import { useNotifs } from "./Notifications.js";
import "./modelPicker.css";

export function NewSessionProjectPicker({ project }: { project: Project | undefined }) {
  const projects = useAppStore((s) => s.projects);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const homeDir = useAppStore((s) => s.homeDir);
  const setPendingProject = useAppStore((s) => s.setPendingProject);
  const addProjectForNewSession = useAppStore((s) => s.addProjectForNewSession);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [adding, setAdding] = useState(false);
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
    setHighlight(0);
  };

  const q = query.trim().toLowerCase();
  const ordered = projectsByRecentActivity(projects, sessionsByProject);
  const visible = q
    ? ordered.filter((p) => p.name.toLowerCase().includes(q) || p.rootPath.toLowerCase().includes(q))
    : ordered;
  const addIndex = visible.length;
  const active = Math.min(highlight, addIndex);
  const optionId = (index: number) => `${listId}-opt-${index}`;

  useLayoutEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [open, active, visible.length]);

  const pick = (id: string) => {
    close();
    if (id === project?.id) return;
    void setPendingProject(id).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not switch project", message: err.message });
    });
  };

  const addFolder = () => {
    if (adding) return;
    close();
    setAdding(true);
    void window.cw
      .pickProjectDir()
      .then((dir) => (dir ? addProjectForNewSession(dir) : undefined))
      .catch((err: Error) => {
        useNotifs.getState().push({ kind: "error", title: "Could not add project", message: err.message });
      })
      .finally(() => setAdding(false));
  };

  const activate = (index: number) => {
    if (index === addIndex) addFolder();
    else pick(visible[index].id);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const count = addIndex + 1;
      setHighlight((active + step + count) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      activate(active);
    }
  };

  const onPopKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" && e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    close();
    triggerRef.current?.focus();
  };

  const keepSearchFocus = (e: ReactMouseEvent) => e.preventDefault();

  return (
    <div className="menu">
      <button
        ref={triggerRef}
        type="button"
        className={`project-picker-btn${project ? "" : " unset"}${open ? " open" : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={project ? shortenHome(project.rootPath, homeDir ?? undefined) : "Choose the project for this session"}
      >
        {project ? <ProjectMonogram name={project.name} size={15} /> : <Folder size={15} aria-hidden="true" />}
        <span className="project-picker-name">{project?.name ?? "Choose a project"}</span>
        <span className="project-picker-chevron" aria-hidden="true">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="project-picker-pop" role="dialog" aria-label="Choose project" onKeyDown={onPopKeyDown}>
            <div className="mp">
              <div className="mp-search">
                <Search size={14} aria-hidden="true" />
                <input
                  autoFocus
                  role="combobox"
                  aria-label="Find a project"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-controls={listId}
                  aria-activedescendant={optionId(active)}
                  placeholder="Find a project"
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                  onKeyDown={onSearchKeyDown}
                />
              </div>
              <div className="mp-body">
                {visible.length === 0 && <div className="mp-empty">{projects.length === 0 ? "No projects yet." : "No matches."}</div>}
                <div id={listId} className="project-picker-listbox" role="listbox" aria-label="Projects">
                  {visible.length > 0 && (
                    <div className="mp-list">
                      {visible.map((p, index) => {
                        const selected = p.id === project?.id;
                        return (
                          <div
                            key={p.id}
                            id={optionId(index)}
                            className={`mp-row${selected ? " sel" : ""}${index === active ? " hi" : ""}`}
                            role="option"
                            aria-selected={selected}
                            title={p.rootPath}
                            onMouseDown={keepSearchFocus}
                            onMouseMove={() => setHighlight(index)}
                            onClick={() => activate(index)}
                          >
                            <ProjectMonogram name={p.name} size={15} />
                            <span className="mp-n">{p.name}</span>
                            <span className="project-path">{shortenHome(p.rootPath, homeDir ?? undefined)}</span>
                            <span className="mp-end">{selected && <Check className="mp-check" size={14} aria-hidden="true" />}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div
                    id={optionId(addIndex)}
                    className={`mp-act${active === addIndex && !adding ? " hi" : ""}`}
                    role="option"
                    aria-selected={false}
                    aria-disabled={adding}
                    onMouseDown={keepSearchFocus}
                    onMouseMove={() => setHighlight(addIndex)}
                    onClick={addFolder}
                  >
                    <Plus size={14} aria-hidden="true" />
                    Add project folder…
                  </div>
                </div>
              </div>
              <div className="mp-foot">
                <span>
                  <span className="mp-kbd">↑↓</span>navigate
                </span>
                <span>
                  <span className="mp-kbd">Enter</span>select
                </span>
                <span className="mp-foot-end">
                  <span className="mp-kbd">Esc</span>
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
