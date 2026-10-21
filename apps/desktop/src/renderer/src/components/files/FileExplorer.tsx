import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import type { GitFileState } from "@cw-code/contracts";
import { FileIcon } from "../fileIcons.js";
import type { DecorationLookup } from "../../files/gitDecorationIndex.js";
import { parentDir, type TreeRow } from "../../files/treeModel.js";

export const TREE_ROW_HEIGHT = 24;
const OVERSCAN = 12;
const INDENT = 12;

export type InlineEdit =
  | { kind: "createFile" | "createDir"; parent: string }
  | { kind: "rename"; path: string; isDir: boolean };

const GIT_LETTER: Record<GitFileState, string> = {
  conflict: "!",
  modified: "M",
  added: "A",
  renamed: "R",
  deleted: "D",
  untracked: "U",
  ignored: ""
};

const GIT_TITLE: Record<GitFileState, string> = {
  conflict: "Merge conflict",
  modified: "Modified",
  added: "Added",
  renamed: "Renamed",
  deleted: "Deleted",
  untracked: "Untracked",
  ignored: "Ignored by git"
};

type DisplayRow =
  | { type: "entry"; row: TreeRow }
  | { type: "edit"; depth: number; isDir: boolean; initial: string };

function displayRows(rows: TreeRow[], edit: InlineEdit | null): DisplayRow[] {
  const out: DisplayRow[] = [];
  const createUnder = edit && edit.kind !== "rename" ? edit.parent : null;
  if (createUnder === "") out.push({ type: "edit", depth: 0, isDir: edit?.kind === "createDir", initial: "" });
  for (const row of rows) {
    if (edit?.kind === "rename" && row.path === edit.path) {
      out.push({ type: "edit", depth: row.depth, isDir: row.isDir, initial: row.name });
      continue;
    }
    out.push({ type: "entry", row });
    if (createUnder && row.isDir && row.path === createUnder) {
      out.push({ type: "edit", depth: row.depth + 1, isDir: edit?.kind === "createDir", initial: "" });
    }
  }
  return out;
}

function InlineNameInput({
  initial,
  isDir,
  depth,
  error,
  onCommit,
  onCancel
}: {
  initial: string;
  isDir: boolean;
  depth: number;
  error: string | null;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const inFlight = useRef(false);

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = isDir ? -1 : initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, isDir]);

  const commit = (fromBlur: boolean) => {
    if (done.current || inFlight.current) return;
    const name = value.trim();
    if (!name || name === initial || (fromBlur && error)) {
      done.current = true;
      onCancel();
      return;
    }
    inFlight.current = true;
    void onCommit(name).then((ok) => {
      inFlight.current = false;
      if (ok) done.current = true;
    });
  };

  return (
    <div className="fx-row fx-row-edit" style={{ paddingLeft: 6 + depth * INDENT }}>
      <span className="fx-chevron" />
      <FileIcon name={value || (isDir ? "folder" : "file")} isDir={isDir} size={14} />
      <div className="fx-edit-wrap">
        <input
          ref={ref}
          className={`fx-edit${error ? " invalid" : ""}`}
          value={value}
          spellCheck={false}
          aria-label={isDir ? "Folder name" : "File name"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit(false);
            else if (e.key === "Escape") {
              done.current = true;
              onCancel();
            }
          }}
          onBlur={() => commit(true)}
        />
        {error && <div className="fx-edit-error">{error}</div>}
      </div>
    </div>
  );
}

export function FileExplorer({
  rows,
  rootStatus,
  activePath,
  focusPath,
  revealNonce,
  decorations,
  dirtyPaths,
  edit,
  editError,
  onFocusPath,
  onToggleDir,
  onOpen,
  onRetryDir,
  onContextMenu,
  onCommitEdit,
  onCancelEdit,
  onRename,
  onDelete
}: {
  rows: TreeRow[];
  rootStatus: { loading: boolean; error: string | null; empty: boolean; onRetry: () => void };
  activePath: string | null;
  focusPath: string | null;
  revealNonce: number;
  decorations: DecorationLookup;
  dirtyPaths: ReadonlySet<string>;
  edit: InlineEdit | null;
  editError: string | null;
  onFocusPath: (path: string | null) => void;
  onToggleDir: (path: string) => void;
  onOpen: (path: string, preview: boolean) => void;
  onRetryDir: (path: string) => void;
  onContextMenu: (e: ReactMouseEvent, row: TreeRow | null) => void;
  onCommitEdit: (name: string) => Promise<boolean>;
  onCancelEdit: () => void;
  onRename: (row: TreeRow) => void;
  onDelete: (row: TreeRow) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const items = displayRows(rows, edit);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    setViewport(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !focusPath || revealNonce === 0) return;
    const index = items.findIndex((item) => item.type === "entry" && item.row.path === focusPath);
    if (index < 0) return;
    const top = index * TREE_ROW_HEIGHT;
    if (top < el.scrollTop || top + TREE_ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
  }, [revealNonce, focusPath, items.length]);

  const ensureVisible = (path: string) => {
    const el = scrollRef.current;
    const index = items.findIndex((item) => item.type === "entry" && item.row.path === path);
    if (!el || index < 0) return;
    const top = index * TREE_ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + TREE_ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + TREE_ROW_HEIGHT - el.clientHeight;
  };

  const move = (path: string | undefined) => {
    if (!path) return;
    onFocusPath(path);
    ensureVisible(path);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (edit || rows.length === 0) return;
    const index = focusPath ? rows.findIndex((row) => row.path === focusPath) : -1;
    const row = index >= 0 ? rows[index] : undefined;
    const pageSize = Math.max(1, Math.floor(viewport / TREE_ROW_HEIGHT) - 1);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(rows[Math.min(rows.length - 1, index + 1)]?.path);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(rows[Math.max(0, index < 0 ? 0 : index - 1)]?.path);
        break;
      case "PageDown":
        e.preventDefault();
        move(rows[Math.min(rows.length - 1, Math.max(0, index) + pageSize)]?.path);
        break;
      case "PageUp":
        e.preventDefault();
        move(rows[Math.max(0, index - pageSize)]?.path);
        break;
      case "Home":
        e.preventDefault();
        move(rows[0]?.path);
        break;
      case "End":
        e.preventDefault();
        move(rows[rows.length - 1]?.path);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!row?.isDir) break;
        if (!row.expanded) onToggleDir(row.path);
        else if (rows[index + 1]?.depth === row.depth + 1) move(rows[index + 1].path);
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (!row) break;
        if (row.isDir && row.expanded) onToggleDir(row.path);
        else if (row.depth > 0) move(parentDir(row.path));
        break;
      }
      case "Enter":
        e.preventDefault();
        if (!row) break;
        if (row.isDir) onToggleDir(row.path);
        else onOpen(row.path, false);
        break;
      case " ":
        e.preventDefault();
        if (row && !row.isDir) onOpen(row.path, true);
        break;
      case "F2":
        e.preventDefault();
        if (row) onRename(row);
        break;
      case "Delete":
        e.preventDefault();
        if (row) onDelete(row);
        break;
      default:
        break;
    }
  };

  const start = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewport) / TREE_ROW_HEIGHT) + OVERSCAN);
  const activeId = focusPath ? `fx-row-${encodeURIComponent(focusPath)}` : undefined;

  return (
    <div
      ref={scrollRef}
      className="fx-tree"
      role="tree"
      aria-label="Files"
      tabIndex={0}
      aria-activedescendant={activeId}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("fx-tree-inner")) onContextMenu(e, null);
      }}
    >
      {rootStatus.error ? (
        <div className="fx-empty">
          Couldn’t list files: {rootStatus.error}
          <button className="fx-link-btn" onClick={rootStatus.onRetry}>
            Retry
          </button>
        </div>
      ) : rootStatus.loading && rows.length === 0 ? (
        <div className="fx-empty">Loading files…</div>
      ) : rootStatus.empty && !edit ? (
        <div className="fx-empty">This folder is empty.</div>
      ) : null}
      <div className="fx-tree-inner" style={{ height: items.length * TREE_ROW_HEIGHT }}>
        {items.slice(start, end).map((item, offset) => {
          const index = start + offset;
          const style = { top: index * TREE_ROW_HEIGHT };
          if (item.type === "edit") {
            return (
              <div key="__edit" className="fx-row-slot" style={style}>
                <InlineNameInput
                  initial={item.initial}
                  isDir={item.isDir}
                  depth={item.depth}
                  error={editError}
                  onCommit={onCommitEdit}
                  onCancel={onCancelEdit}
                />
              </div>
            );
          }
          const { row } = item;
          const decoration = decorations(row.path, row.isDir);
          const state = decoration?.state;
          const classes = [
            "fx-row",
            row.isDir ? "dir" : "file",
            row.path === activePath ? "active" : "",
            row.path === focusPath ? "focused" : "",
            state ? `git-${state}` : ""
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={row.path} className="fx-row-slot" style={style}>
              <div
                id={`fx-row-${encodeURIComponent(row.path)}`}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.isDir ? row.expanded : undefined}
                aria-selected={row.path === focusPath}
                className={classes}
                style={{ paddingLeft: 6 + row.depth * INDENT }}
                title={state ? `${row.path} · ${GIT_TITLE[state]}` : row.path}
                onClick={(e) => {
                  onFocusPath(row.path);
                  if (row.isDir) {
                    if (e.detail === 1) onToggleDir(row.path);
                  } else onOpen(row.path, e.detail < 2);
                }}
                onDoubleClick={() => {
                  if (!row.isDir) onOpen(row.path, false);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onFocusPath(row.path);
                  onContextMenu(e, row);
                }}
              >
                {Array.from({ length: row.depth }, (_, level) => (
                  <span key={level} className="fx-guide" style={{ left: 13 + level * INDENT }} />
                ))}
                <span className="fx-chevron">
                  {row.isDir ? (
                    row.loading ? (
                      <LoaderCircle size={12} className="fx-spin" />
                    ) : row.expanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )
                  ) : null}
                </span>
                <FileIcon name={row.name} isDir={row.isDir} expanded={row.expanded} size={14} />
                <span className="fx-name">{row.name}</span>
                {row.error && (
                  <button
                    className="fx-row-error"
                    title={row.error}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetryDir(row.path);
                    }}
                  >
                    retry
                  </button>
                )}
                {!row.isDir && dirtyPaths.has(row.path) && <span className="fx-dirty-dot" aria-label="Unsaved changes" />}
                {state && state !== "ignored" && (
                  row.isDir ? (
                    <span className="fx-git-dot" aria-hidden="true" />
                  ) : (
                    <span className="fx-git-letter">{GIT_LETTER[state]}</span>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
