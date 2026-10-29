import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, ChevronRight, Eye, EyeOff, Folder, GitBranch, Loader2 } from "lucide-react";
import type { DirectoryListing } from "../cw.js";
import { useFolderBrowserStore } from "../stores/folderBrowserStore.js";
import { errorMessage } from "./errorMessage.js";

interface Crumb {
  label: string;
  path: string;
}

function breadcrumbs(path: string): Crumb[] {
  const windows = /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\");
  const separator = windows ? "\\" : "/";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (windows && /^[a-zA-Z]:$/.test(parts[0] ?? "")) {
    const drive = `${parts[0]}${separator}`;
    const crumbs: Crumb[] = [{ label: drive, path: drive }];
    let current = parts[0];
    for (const part of parts.slice(1)) {
      current = `${current}${separator}${part}`;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }
  const crumbs: Crumb[] = windows ? [] : [{ label: "/", path: "/" }];
  let current = windows ? "\\" : "";
  for (const part of parts) {
    current = `${current}${separator}${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function FolderBrowserBody({ initialPath, onResolve }: { initialPath: string | null; onResolve: (path: string | null) => void }) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const requestId = useRef(0);

  const go = useCallback((path: string | null, hidden: boolean) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    window.cw
      .browseDirectories(path, hidden)
      .then((next) => {
        if (id !== requestId.current) return;
        setListing(next);
        setPathInput(next.path);
        setFilter("");
      })
      .catch((err: unknown) => {
        if (id === requestId.current) setError(errorMessage(err));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    go(initialPath, false);
  }, [go, initialPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onResolve(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onResolve]);

  const entries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = listing?.entries ?? [];
    return needle ? all.filter((entry) => entry.name.toLowerCase().includes(needle)) : all;
  }, [listing, filter]);

  const crumbs = useMemo(() => (listing ? breadcrumbs(listing.path) : []), [listing]);

  const onPathKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const target = pathInput.trim();
    if (target) go(target, showHidden);
  };

  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    go(listing?.path ?? (pathInput.trim() || null), next);
  };

  return (
    <div className="confirm-backdrop" onClick={() => onResolve(null)}>
      <div
        className="confirm-card folder-browser"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a folder on the server"
        aria-busy={loading}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-title">Choose a folder on the server</div>

        <div className="folder-path-row">
          <input
            className="field folder-path"
            value={pathInput}
            aria-label="Folder path"
            placeholder="Type a path and press Enter"
            spellCheck={false}
            autoFocus
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={onPathKey}
          />
          <button type="button" className="btn" disabled={!pathInput.trim()} onClick={() => go(pathInput.trim(), showHidden)}>
            Go
          </button>
          <button
            type="button"
            className="icon-btn folder-icon-btn"
            aria-label="Parent folder"
            title="Parent folder"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && go(listing.parent, showHidden)}
          >
            <ArrowUp size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn folder-icon-btn"
            aria-label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            aria-pressed={showHidden}
            title={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            onClick={toggleHidden}
          >
            {showHidden ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}
          </button>
        </div>

        {listing && listing.roots.length > 0 && (
          <div className="folder-roots" role="group" aria-label="Quick locations">
            {listing.roots.map((root) => (
              <button key={root.path} type="button" className="chip folder-root" title={root.path} onClick={() => go(root.path, showHidden)}>
                {root.label}
              </button>
            ))}
          </div>
        )}

        {crumbs.length > 0 && (
          <nav className="folder-crumbs" aria-label="Current path">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} className="folder-crumb-item">
                {index > 0 && <ChevronRight size={11} aria-hidden="true" />}
                <button
                  type="button"
                  className="folder-crumb"
                  aria-current={index === crumbs.length - 1 ? "page" : undefined}
                  onClick={() => go(crumb.path, showHidden)}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        )}

        <input
          className="field folder-filter"
          value={filter}
          aria-label="Filter folders"
          placeholder="Filter folders"
          disabled={!listing}
          onChange={(e) => setFilter(e.target.value)}
        />

        {error && (
          <div className="shutdown-error" role="alert">
            {error}
          </div>
        )}

        <div className="folder-list-wrap">
          {listing && (
            <ul className="folder-list">
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button type="button" className="folder-row" title={entry.path} onClick={() => go(entry.path, showHidden)}>
                    <Folder size={14} aria-hidden="true" />
                    <span className="folder-row-name">{entry.name}</span>
                    {entry.isGitRepo && (
                      <span className="folder-row-git" title="Git repository">
                        <GitBranch size={12} aria-hidden="true" />
                        git
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listing && entries.length === 0 && !loading && (
            <div className="folder-empty">{filter.trim() ? "No folders match the filter." : "No subfolders."}</div>
          )}
          {listing?.truncated && <div className="folder-empty">Only the first folders are shown. Use the filter or type a path.</div>}
          {loading && (
            <div className="folder-loading" role="status">
              <Loader2 size={14} className="skills-spin" aria-hidden="true" />
              Loading…
            </div>
          )}
        </div>

        <div className="confirm-actions">
          <button type="button" className="btn" onClick={() => onResolve(null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!listing} onClick={() => listing && onResolve(listing.path)}>
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

export function FolderBrowserHost() {
  const request = useFolderBrowserStore((s) => s.request);
  const settle = useFolderBrowserStore((s) => s.settle);
  if (!request) return null;
  return <FolderBrowserBody initialPath={request.initialPath} onResolve={settle} />;
}
