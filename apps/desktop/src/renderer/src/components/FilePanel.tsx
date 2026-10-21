import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronsDownUp,
  ClipboardCopy,
  Copy,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Files,
  Pencil,
  Pin,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react";
import type { DirEntry, FsChangeEvent, GitBaseline } from "@cw-code/contracts";
import { useConfirm } from "./ConfirmDialog.js";
import { ipcErrorMessage } from "./ipcError.js";
import { EditorGroup, isImagePath, type PathReveal, type TabView } from "./files/EditorGroup.js";
import { FileContextMenu, type MenuEntry } from "./files/FileContextMenu.js";
import { FileExplorer, type InlineEdit } from "./files/FileExplorer.js";
import { FileSearchView, type SearchSeed } from "./files/FileSearchView.js";
import { QuickOpen, invalidateQuickOpenCache } from "./files/QuickOpen.js";
import "./files/files.css";
import { disposeEditorState } from "../editor/CodeEditor.js";
import { EMPTY_FILE_TABS, useFileTabs } from "../files/fileTabs.js";
import { buildDecorationIndex, type DecorationLookup } from "../files/gitDecorationIndex.js";
import { resolveRevealPath } from "../files/revealPath.js";
import { ancestorsOf, flattenTree, parentDir, rebasePath, type TreeRow } from "../files/treeModel.js";
import { bufferKey, isDirtyBuffer, useEditorBuffers } from "../stores/editorBuffers.js";
import { usePanelStore } from "../stores/panelStore.js";

const SIDE_KEY = "cw-code:files-side";
const WRAP_KEY = "cw-code:editor-wrap";
const SIDE_MIN = 170;
const SIDE_MAX = 640;
const WATCH_DEBOUNCE_MS = 150;
const DECORATION_DEBOUNCE_MS = 600;
const GIT_POLL_MS = 15_000;
const NOTICE_MS = 7000;
const INVALID_NAME = /[<>:"|?*\u0000-\u001f]/;

const registered = new Set<string>();
const hiddenByReveal = new Set<string>();
const NO_DECORATIONS: DecorationLookup = () => null;

interface SideState {
  width: number;
  visible: boolean;
}

function readSide(): SideState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDE_KEY) ?? "null") as Partial<SideState> | null;
    return {
      width: typeof parsed?.width === "number" ? Math.min(SIDE_MAX, Math.max(SIDE_MIN, parsed.width)) : 250,
      visible: parsed?.visible !== false
    };
  } catch {
    return { width: 250, visible: true };
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[files] could not persist ${key}: ${(err as Error).message}`);
  }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function validateName(name: string): string | null {
  const trimmed = name.trim().replace(/\\/g, "/");
  if (!trimmed) return "A name is required.";
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return "Use a name relative to the folder.";
  if (trimmed.split("/").some((part) => part === "" || part === "." || part === "..")) return "That name is not valid.";
  if (INVALID_NAME.test(trimmed)) return "Names can't contain < > : \" | ? *";
  return null;
}

function sameEntries(a: DirEntry[] | undefined, b: DirEntry[]): boolean {
  return a !== undefined && a.length === b.length && a.every((entry, index) => entry.path === b[index].path && entry.isDir === b[index].isDir);
}

export function FilePanel({ sessionId }: { sessionId: string }) {
  return <FileWorkspace key={sessionId} sessionId={sessionId} />;
}

function FileWorkspace({ sessionId }: { sessionId: string }) {
  const tabsState = useFileTabs((s) => s.bySession[sessionId] ?? EMPTY_FILE_TABS);
  const expandedList = useFileTabs((s) => s.expandedBySession[sessionId]);
  const expanded = useMemo(() => new Set(expandedList ?? []), [expandedList]);
  const dirtyKey = useEditorBuffers((s) =>
    Object.values(s.buffers)
      .filter((buffer) => buffer.sessionId === sessionId && isDirtyBuffer(buffer))
      .map((buffer) => buffer.path)
      .sort()
      .join("\n")
  );
  const dirtyPaths = useMemo(() => new Set(dirtyKey ? dirtyKey.split("\n") : []), [dirtyKey]);

  const [childrenByDir, setChildrenByDir] = useState<Record<string, DirEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [views, setViews] = useState<Record<string, TabView>>({});
  const [baselines, setBaselines] = useState<Record<string, GitBaseline>>({});
  const [decorations, setDecorations] = useState<DecorationLookup>(() => NO_DECORATIONS);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [treeRevealNonce, setTreeRevealNonce] = useState(0);
  const [edit, setEdit] = useState<InlineEdit | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [sideView, setSideView] = useState<"explorer" | "search">("explorer");
  const [side, setSide] = useState<SideState>(readSide);
  const [revealHidden, setRevealHidden] = useState(() => hiddenByReveal.has(sessionId));
  const sideShown = side.visible && !revealHidden;
  const showSide = useCallback(() => {
    hiddenByReveal.delete(sessionId);
    setRevealHidden(false);
    setSide((prev) => (prev.visible ? prev : { ...prev, visible: true }));
  }, [sessionId]);
  const hideSideForReveal = useCallback(() => {
    hiddenByReveal.add(sessionId);
    setRevealHidden(true);
  }, [sessionId]);
  const [wrap, setWrap] = useState(() => {
    try {
      return window.localStorage.getItem(WRAP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [previewing, setPreviewing] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState<PathReveal | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [quickOpen, setQuickOpen] = useState<{ query: string } | null>(null);
  const [searchFocus, setSearchFocus] = useState(0);
  const [searchSeed, setSearchSeed] = useState<SearchSeed | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const { confirm, dialog } = useConfirm();

  const rootRef = useRef<HTMLDivElement>(null);
  const pendingDirs = useRef(new Set<string>());
  const rerunDirs = useRef(new Set<string>());
  const childrenRef = useRef(childrenByDir);
  childrenRef.current = childrenByDir;
  const tabsRef = useRef(tabsState);
  tabsRef.current = tabsState;
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const rootPathRef = useRef<string | null>(null);
  const revealNonce = useRef(0);
  const decorationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const showNotice = useCallback((text: string, tone: "info" | "error" = "info") => setNotice({ text, tone }), []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const setExpandedPaths = useCallback(
    (update: (current: Set<string>) => Set<string>) => {
      const current = new Set(useFileTabs.getState().expandedBySession[sessionId] ?? []);
      useFileTabs.getState().setExpanded(sessionId, Array.from(update(current)).sort());
    },
    [sessionId]
  );

  const loadDir = useCallback(
    (dir: string) => {
      if (pendingDirs.current.has(dir)) {
        rerunDirs.current.add(dir);
        return;
      }
      pendingDirs.current.add(dir);
      setLoading((prev) => new Set(prev).add(dir));
      window.cw
        .listDir(sessionId, dir || undefined)
        .then((entries) => {
          if (!aliveRef.current) return;
          setChildrenByDir((prev) => (sameEntries(prev[dir], entries) ? prev : { ...prev, [dir]: entries }));
          setDirErrors((prev) => {
            if (!(dir in prev)) return prev;
            const next = { ...prev };
            delete next[dir];
            return next;
          });
        })
        .catch((err: unknown) => {
          if (!aliveRef.current) return;
          const message = ipcErrorMessage(err);
          if (dir && /directory not found|not a directory/.test(message)) {
            setChildrenByDir((prev) => {
              const next = { ...prev };
              for (const key of Object.keys(next)) if (isUnder(key, dir)) delete next[key];
              return next;
            });
            setExpandedPaths((current) => new Set([...current].filter((path) => !isUnder(path, dir))));
            return;
          }
          setDirErrors((prev) => ({ ...prev, [dir]: message }));
        })
        .finally(() => {
          pendingDirs.current.delete(dir);
          if (!aliveRef.current) return;
          if (rerunDirs.current.delete(dir)) loadDir(dir);
          setLoading((prev) => {
            if (!prev.has(dir)) return prev;
            const next = new Set(prev);
            next.delete(dir);
            return next;
          });
        });
    },
    [sessionId, setExpandedPaths]
  );

  const refreshBaseline = useCallback(
    (path: string) => {
      window.cw
        .gitBaseline(sessionId, path)
        .then((baseline) => {
          if (!aliveRef.current) return;
          setBaselines((prev) => {
            const current = prev[path];
            const same =
              current?.kind === baseline.kind &&
              (current.kind !== "tracked" || (baseline.kind === "tracked" && current.content === baseline.content));
            return same ? prev : { ...prev, [path]: baseline };
          });
        })
        .catch((err: unknown) => console.warn(`[files] git changes unavailable for ${path}: ${ipcErrorMessage(err)}`));
    },
    [sessionId]
  );

  const refreshDecorations = useCallback(() => {
    if (decorationTimer.current) clearTimeout(decorationTimer.current);
    decorationTimer.current = setTimeout(() => {
      decorationTimer.current = null;
      const active = tabsRef.current.active;
      const activeView = active ? viewsRef.current[active] : undefined;
      if (active && activeView?.status === "text" && activeView.readOnlyReason !== "large") refreshBaseline(active);
      window.cw
        .gitDecorations(sessionId)
        .then((result) => {
          if (aliveRef.current) setDecorations(() => (result.available ? buildDecorationIndex(result.entries) : NO_DECORATIONS));
        })
        .catch((err: unknown) => console.warn(`[files] git decorations unavailable: ${ipcErrorMessage(err)}`));
    }, DECORATION_DEBOUNCE_MS);
  }, [sessionId, refreshBaseline]);

  const releaseTab = useCallback(
    (path: string) => {
      const key = bufferKey(sessionId, path);
      if (registered.delete(key)) useEditorBuffers.getState().unregister(key);
      disposeEditorState(key);
      setViews((prev) => {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
      setPreviewing((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      setBaselines((prev) => {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
    },
    [sessionId]
  );

  const loadTab = useCallback(
    (path: string, force = false) => {
      const key = bufferKey(sessionId, path);
      if (isImagePath(path)) {
        setViews((prev) => ({ ...prev, [path]: { status: "image" } }));
        return;
      }
      if (!force && registered.has(key) && useEditorBuffers.getState().buffers[key]) {
        setViews((prev) => (prev[path]?.status === "text" ? prev : { ...prev, [path]: { status: "text" } }));
        if (!useEditorBuffers.getState().buffers[key]?.readOnly) refreshBaseline(path);
        return;
      }
      setViews((prev) => (prev[path] ? prev : { ...prev, [path]: { status: "loading" } }));
      window.cw
        .readFileInfo(sessionId, path)
        .then((info) => {
          if (!aliveRef.current) return;
          if (info.kind === "text") {
            const store = useEditorBuffers.getState();
            const prior = viewsRef.current[path];
            const previousReason = prior?.status === "text" ? prior.readOnlyReason : undefined;
            if (registered.has(key) && store.buffers[key]) {
              store.applyExternal(key, info.content, info.mtimeMs);
              store.setReadOnly(key, info.readOnly);
            } else {
              store.register(sessionId, path, info.content, { mtimeMs: info.mtimeMs, readOnly: info.readOnly });
              registered.add(key);
            }
            if (info.readOnlyReason === "encoding" && previousReason !== "encoding") {
              showNotice(`${baseName(path)} isn't UTF-8, so it opened read-only to avoid corrupting it.`);
            }
            setViews((prev) => ({ ...prev, [path]: { status: "text", readOnlyReason: info.readOnlyReason } }));
            if (info.readOnlyReason !== "large") refreshBaseline(path);
          } else if (info.kind === "missing") {
            if (registered.has(key) && useEditorBuffers.getState().buffers[key]) {
              if (!useEditorBuffers.getState().markMissing(key)) {
                showNotice(`${baseName(path)} was deleted on disk. It still has unsaved edits; saving will recreate it.`, "error");
              }
              return;
            }
            setViews((prev) => ({ ...prev, [path]: { status: "error", message: `${path} doesn’t exist in this workspace.` } }));
          } else {
            setViews((prev) => ({ ...prev, [path]: { status: info.kind, size: info.size } }));
          }
        })
        .catch((err: unknown) => {
          if (!aliveRef.current) return;
          setViews((prev) => ({ ...prev, [path]: { status: "error", message: `Couldn’t open ${path}: ${ipcErrorMessage(err)}` } }));
        });
    },
    [sessionId, showNotice, refreshBaseline]
  );

  const revealInTree = useCallback(
    (path: string) => {
      const dirs = ancestorsOf(path);
      setExpandedPaths((current) => {
        const next = new Set(current);
        for (const dir of dirs) next.add(dir);
        return next;
      });
      for (const dir of ["", ...dirs]) if (!childrenRef.current[dir]) loadDir(dir);
      setFocusPath(path);
      setTreeRevealNonce((value) => value + 1);
    },
    [loadDir, setExpandedPaths]
  );

  const openFile = useCallback(
    (path: string, opts: { preview?: boolean; line?: number | null; text?: string; revealTree?: boolean } = {}) => {
      useFileTabs.getState().open(sessionId, path, opts.preview ?? true);
      loadTab(path);
      if (opts.line) {
        revealNonce.current += 1;
        setReveal({ path, line: opts.line, text: opts.text, nonce: revealNonce.current });
      }
      if (opts.revealTree) revealInTree(path);
    },
    [sessionId, loadTab, revealInTree]
  );

  useEffect(() => {
    loadDir("");
    for (const dir of expandedList ?? []) loadDir(dir);
    refreshDecorations();
    for (const tab of tabsRef.current.tabs) {
      if (registered.has(bufferKey(sessionId, tab.path))) loadTab(tab.path, true);
    }
    const onFocus = () => refreshDecorations();
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refreshDecorations();
    }, GIT_POLL_MS);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      if (decorationTimer.current) clearTimeout(decorationTimer.current);
    };
  }, [sessionId]);

  useEffect(() => {
    if (tabsState.active) loadTab(tabsState.active);
  }, [tabsState.active, loadTab]);

  useEffect(() => {
    const open = new Set(tabsState.tabs.map((tab) => tab.path));
    const prefix = `${sessionId}\n`;
    for (const key of Array.from(registered)) {
      if (key.startsWith(prefix) && !open.has(key.slice(prefix.length))) releaseTab(key.slice(prefix.length));
    }
  }, [tabsState.tabs, sessionId, releaseTab]);

  useEffect(() => {
    for (const tab of tabsState.tabs) if (tab.preview && dirtyPaths.has(tab.path)) useFileTabs.getState().pin(sessionId, tab.path);
  }, [dirtyPaths, tabsState.tabs, sessionId]);

  const watched = useMemo(
    () => Array.from(new Set(["", ...expanded, ...tabsState.tabs.map((tab) => tab.path)])).sort(),
    [expanded, tabsState.tabs]
  );
  const watchedKey = watched.join("\n");

  useEffect(() => {
    const timer = setTimeout(() => {
      window.cw.setWatchedPaths(sessionId, watched).catch((err: unknown) => console.warn(`[files] live refresh unavailable: ${ipcErrorMessage(err)}`));
    }, WATCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [watchedKey, sessionId]);

  useEffect(
    () => () => {
      window.cw.unwatchPaths(sessionId).catch((err: unknown) => console.warn(`[files] could not stop watching: ${ipcErrorMessage(err)}`));
    },
    [sessionId]
  );

  useEffect(
    () =>
      window.cw.onFsChanged((event: FsChangeEvent) => {
        if (event.sessionId !== sessionId) return;
        const dirs = new Set<string>();
        const files = new Set<string>();
        for (const path of event.paths) {
          dirs.add(parentDir(path));
          if (childrenRef.current[path]) dirs.add(path);
          for (const tab of tabsRef.current.tabs) if (isUnder(tab.path, path)) files.add(tab.path);
        }
        for (const dir of dirs) if (childrenRef.current[dir]) loadDir(dir);
        for (const path of files) if (registered.has(bufferKey(sessionId, path)) || viewsRef.current[path]) loadTab(path, true);
        invalidateQuickOpenCache(sessionId);
        refreshDecorations();
      }),
    [sessionId, loadDir, loadTab, refreshDecorations]
  );

  const toggleDir = useCallback(
    (path: string) => {
      const isOpen = expanded.has(path);
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (isOpen) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!isOpen && !childrenRef.current[path]) loadDir(path);
    },
    [expanded, loadDir, setExpandedPaths]
  );

  const retryDir = useCallback(
    (path: string) => {
      setDirErrors((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      loadDir(path);
    },
    [loadDir]
  );

  const save = useCallback(
    async (path: string) => {
      const key = bufferKey(sessionId, path);
      const store = useEditorBuffers.getState();
      const buffer = store.buffers[key];
      if (!buffer || !isDirtyBuffer(buffer)) return;
      if (buffer.readOnly || buffer.conflict) {
        if (buffer?.conflict) showNotice("Resolve the on-disk change first: reload from disk or keep your edits.", "error");
        return;
      }
      const content = buffer.content;
      const write = async (expectedMtimeMs: number | undefined) => {
        const stat = await window.cw.writeFileGuarded(sessionId, path, content, expectedMtimeMs);
        useEditorBuffers.getState().markSaved(key, content, stat.mtimeMs);
        refreshDecorations();
      };
      try {
        await write(buffer.mtimeMs);
      } catch (err) {
        const message = ipcErrorMessage(err);
        if (!message.startsWith("file changed on disk")) {
          showNotice(`Couldn’t save ${baseName(path)}: ${message}`, "error");
          return;
        }
        try {
          const info = await window.cw.readFileInfo(sessionId, path);
          if (info.kind !== "text") throw new Error("the file on disk is no longer a text file");
          const outcome = useEditorBuffers.getState().applyExternal(key, info.content, info.mtimeMs);
          if (outcome === "conflict") {
            showNotice(`${baseName(path)} changed on disk, so it wasn't saved. Choose whether to reload it or keep your edits.`, "error");
            return;
          }
          if (outcome === "reloaded") {
            showNotice(`${baseName(path)} changed on disk and your edits matched it, so there was nothing to save.`);
            return;
          }
          await write(info.mtimeMs);
        } catch (retryErr) {
          showNotice(`Couldn’t save ${baseName(path)}: ${ipcErrorMessage(retryErr)}`, "error");
        }
      }
    },
    [sessionId, refreshDecorations, showNotice]
  );

  const confirmDiscard = useCallback(
    async (paths: string[]) => {
      const dirty = paths.filter((path) => dirtyPaths.has(path));
      if (dirty.length === 0) return true;
      const ok = await confirm({
        title: dirty.length === 1 ? `Discard changes to ${baseName(dirty[0])}?` : `Discard changes to ${dirty.length} files?`,
        message: "Your unsaved edits will be lost.",
        confirmLabel: "Discard changes",
        danger: true
      });
      if (!ok) return false;
      for (const path of dirty) useEditorBuffers.getState().discard(bufferKey(sessionId, path));
      return true;
    },
    [confirm, dirtyPaths, sessionId]
  );

  const closeTabs = useCallback(
    async (paths: string[], apply: () => void) => {
      if (!(await confirmDiscard(paths))) return;
      apply();
    },
    [confirmDiscard]
  );

  const closeTab = useCallback(
    (path: string) => void closeTabs([path], () => useFileTabs.getState().close(sessionId, path)),
    [closeTabs, sessionId]
  );

  const workspaceRoot = useCallback(async () => {
    rootPathRef.current ??= await window.cw.workspaceRoot(sessionId);
    return rootPathRef.current;
  }, [sessionId]);

  const copyPath = useCallback(
    async (path: string, relative: boolean) => {
      try {
        let text = path;
        if (!relative) {
          const root = await workspaceRoot();
          const sep = root.includes("\\") ? "\\" : "/";
          text = path ? `${root.replace(/[\\/]+$/, "")}${sep}${path.split("/").join(sep)}` : root;
        }
        await navigator.clipboard.writeText(text);
      } catch (err) {
        showNotice(`Couldn’t copy the path: ${ipcErrorMessage(err)}`, "error");
      }
    },
    [workspaceRoot, showNotice]
  );

  const revealInOs = useCallback(
    async (path: string) => {
      try {
        if (path) await window.cw.revealPath(sessionId, path);
        else await window.cw.openPath(await workspaceRoot());
      } catch (err) {
        showNotice(`Couldn’t reveal ${path || "the workspace"}: ${ipcErrorMessage(err)}`, "error");
      }
    },
    [sessionId, workspaceRoot, showNotice]
  );

  const targetDirFor = useCallback(
    (path: string | null): string => {
      if (path === null) return "";
      const isDir = childrenRef.current[path] !== undefined || rowsRef.current.find((row) => row.path === path)?.isDir === true;
      return isDir ? path : parentDir(path);
    },
    []
  );

  const startCreate = useCallback(
    (kind: "createFile" | "createDir", near: string | null) => {
      const parent = targetDirFor(near);
      showSide();
      setSideView("explorer");
      if (parent) {
        setExpandedPaths((current) => new Set([...current, ...ancestorsOf(parent), parent]));
        for (const dir of [...ancestorsOf(parent), parent]) if (!childrenRef.current[dir]) loadDir(dir);
      }
      setEditError(null);
      setEdit({ kind, parent });
    },
    [targetDirFor, setExpandedPaths, loadDir]
  );

  const startRename = useCallback((row: TreeRow) => {
    setEditError(null);
    setEdit({ kind: "rename", path: row.path, isDir: row.isDir });
  }, []);

  const commitEdit = useCallback(
    async (rawName: string): Promise<boolean> => {
      if (!edit) return false;
      const name = rawName.trim().replace(/\\/g, "/");
      const invalid = validateName(name);
      if (invalid) {
        setEditError(invalid);
        return false;
      }
      try {
        if (edit.kind === "rename") {
          const from = edit.path;
          const to = joinPath(parentDir(from), name);
          if (to === from) {
            setEdit(null);
            return true;
          }
          const store = useEditorBuffers.getState();
          const collides = Object.values(store.buffers).some((buffer) => buffer.sessionId === sessionId && isUnder(buffer.path, to) && !isUnder(buffer.path, from));
          if (collides) {
            setEditError("A file with unsaved changes is open at that path.");
            return false;
          }
          await window.cw.renamePath(sessionId, from, to);
          const moved = Array.from(registered).filter((key) => key.startsWith(`${sessionId}\n`) && isUnder(key.slice(sessionId.length + 1), from));
          for (const key of moved) {
            registered.delete(key);
            disposeEditorState(key);
            const next = rebasePath(key.slice(sessionId.length + 1), from, to);
            if (next !== null) registered.add(bufferKey(sessionId, next));
          }
          store.renamePath(sessionId, from, to);
          useFileTabs.getState().rename(sessionId, from, to);
          setExpandedPaths((current) => new Set([...current].map((path) => rebasePath(path, from, to) ?? path)));
          setViews((prev) => Object.fromEntries(Object.entries(prev).map(([path, view]) => [rebasePath(path, from, to) ?? path, view])));
          setPreviewing((prev) => new Set([...prev].map((path) => rebasePath(path, from, to) ?? path)));
          setChildrenByDir((prev) => Object.fromEntries(Object.entries(prev).filter(([dir]) => !isUnder(dir, from))));
          loadDir(parentDir(from));
          if (parentDir(to) !== parentDir(from)) loadDir(parentDir(to));
          if (edit.isDir && expanded.has(from)) loadDir(to);
          setFocusPath(to);
        } else {
          const path = joinPath(edit.parent, name);
          if (edit.kind === "createFile") await window.cw.createFile(sessionId, path);
          else await window.cw.createDir(sessionId, path);
          for (const dir of ancestorsOf(path)) if (!isUnder(edit.parent, dir) || dir === edit.parent) loadDir(dir);
          loadDir(edit.parent);
          setExpandedPaths((current) => new Set([...current, ...ancestorsOf(path), ...(edit.kind === "createDir" ? [path] : [])]));
          setFocusPath(path);
          setTreeRevealNonce((value) => value + 1);
          if (edit.kind === "createFile") openFile(path, { preview: false });
        }
        setEdit(null);
        setEditError(null);
        invalidateQuickOpenCache(sessionId);
        refreshDecorations();
        return true;
      } catch (err) {
        setEditError(ipcErrorMessage(err));
        return false;
      }
    },
    [edit, sessionId, expanded, loadDir, openFile, refreshDecorations, setExpandedPaths]
  );

  const deleteEntry = useCallback(
    async (row: TreeRow) => {
      const affected = tabsRef.current.tabs.map((tab) => tab.path).filter((path) => isUnder(path, row.path));
      const unsaved = affected.filter((path) => dirtyPaths.has(path));
      const ok = await confirm({
        title: `Delete ${row.name}?`,
        message: (
          <>
            {row.isDir ? "This folder and everything in it" : "This file"} will be moved to the {navigator.userAgent.includes("Windows") ? "Recycle Bin" : "Trash"}.
            {unsaved.length > 0 && ` ${unsaved.length} open file${unsaved.length === 1 ? " has" : "s have"} unsaved changes that will be lost.`}
          </>
        ),
        confirmLabel: "Move to trash",
        danger: true
      });
      if (!ok) return;
      try {
        await window.cw.trashPath(sessionId, row.path);
        for (const path of affected) useEditorBuffers.getState().discard(bufferKey(sessionId, path));
        useFileTabs.getState().remove(sessionId, row.path);
        setExpandedPaths((current) => new Set([...current].filter((path) => !isUnder(path, row.path))));
        setChildrenByDir((prev) => Object.fromEntries(Object.entries(prev).filter(([dir]) => !isUnder(dir, row.path))));
        loadDir(parentDir(row.path));
        setFocusPath(parentDir(row.path) || null);
        invalidateQuickOpenCache(sessionId);
        refreshDecorations();
      } catch (err) {
        showNotice(`Couldn’t delete ${row.name}: ${ipcErrorMessage(err)}`, "error");
      }
    },
    [confirm, dirtyPaths, sessionId, loadDir, refreshDecorations, setExpandedPaths, showNotice]
  );

  const resolveConflict = useCallback(
    (path: string, choice: "reload" | "keepMine") => {
      useEditorBuffers.getState().resolveConflict(bufferKey(sessionId, path), choice);
    },
    [sessionId]
  );

  const collapseAll = useCallback(() => useFileTabs.getState().setExpanded(sessionId, []), [sessionId]);

  const refreshAll = useCallback(() => {
    loadDir("");
    for (const dir of expanded) loadDir(dir);
    for (const tab of tabsRef.current.tabs) if (registered.has(bufferKey(sessionId, tab.path))) loadTab(tab.path, true);
    invalidateQuickOpenCache(sessionId);
    refreshDecorations();
  }, [expanded, loadDir, loadTab, sessionId, refreshDecorations]);

  const findInFolder = useCallback((path: string) => {
    showSide();
    setSideView("search");
    setSearchSeed({ include: path ? `${path}/**` : "", nonce: Date.now() });
  }, []);

  const rows = useMemo(() => flattenTree(childrenByDir, expanded, loading, dirErrors), [childrenByDir, expanded, loading, dirErrors]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const entryMenu = useCallback(
    (e: ReactMouseEvent, row: TreeRow | null) => {
      e.preventDefault();
      const items: MenuEntry[] = row
        ? [
            ...(!row.isDir
              ? ([
                  { label: "Open", Icon: FileText, shortcut: "Enter", run: () => openFile(row.path, { preview: false }) },
                  "separator"
                ] as MenuEntry[])
              : []),
            { label: "New File…", Icon: FilePlus2, run: () => startCreate("createFile", row.path) },
            { label: "New Folder…", Icon: FolderPlus, run: () => startCreate("createDir", row.path) },
            ...(row.isDir ? ([{ label: "Find in Folder…", Icon: FolderSearch, run: () => findInFolder(row.path) }] as MenuEntry[]) : []),
            "separator",
            { label: "Copy Path", Icon: Copy, run: () => void copyPath(row.path, false) },
            { label: "Copy Relative Path", Icon: ClipboardCopy, run: () => void copyPath(row.path, true) },
            { label: navigator.userAgent.includes("Windows") ? "Reveal in File Explorer" : "Reveal in File Manager", Icon: ExternalLink, run: () => void revealInOs(row.path) },
            "separator",
            { label: "Rename…", Icon: Pencil, shortcut: "F2", run: () => startRename(row) },
            { label: "Delete", Icon: Trash2, shortcut: "Del", danger: true, run: () => void deleteEntry(row) }
          ]
        : [
            { label: "New File…", Icon: FilePlus2, run: () => startCreate("createFile", null) },
            { label: "New Folder…", Icon: FolderPlus, run: () => startCreate("createDir", null) },
            { label: "Find in Workspace…", Icon: FolderSearch, run: () => findInFolder("") },
            "separator",
            { label: "Refresh", Icon: RefreshCw, run: refreshAll },
            { label: "Collapse All", Icon: ChevronsDownUp, run: collapseAll },
            { label: "Open Workspace Folder", Icon: FolderOpen, run: () => void revealInOs("") }
          ];
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [openFile, startCreate, findInFolder, copyPath, revealInOs, startRename, deleteEntry, refreshAll, collapseAll]
  );

  const tabMenu = useCallback(
    (e: ReactMouseEvent, path: string) => {
      const tabs = tabsRef.current.tabs;
      const index = tabs.findIndex((tab) => tab.path === path);
      const tab = tabs[index];
      const store = useFileTabs.getState();
      const items: MenuEntry[] = [
        { label: "Close", Icon: X, shortcut: "Ctrl+W", run: () => closeTab(path) },
        {
          label: "Close Others",
          disabled: tabs.length < 2,
          run: () => void closeTabs(tabs.filter((t) => t.path !== path).map((t) => t.path), () => store.closeOthers(sessionId, path))
        },
        {
          label: "Close to the Right",
          disabled: index === tabs.length - 1,
          run: () => void closeTabs(tabs.slice(index + 1).map((t) => t.path), () => store.closeToRight(sessionId, path))
        },
        {
          label: "Close Saved",
          run: () => {
            for (const t of tabs) if (!dirtyPaths.has(t.path)) store.close(sessionId, t.path);
          }
        },
        { label: "Close All", run: () => void closeTabs(tabs.map((t) => t.path), () => store.closeAll(sessionId)) },
        "separator",
        ...(tab?.preview ? ([{ label: "Keep Open", Icon: Pin, run: () => store.pin(sessionId, path) }] as MenuEntry[]) : []),
        { label: "Copy Path", Icon: Copy, run: () => void copyPath(path, false) },
        { label: "Copy Relative Path", Icon: ClipboardCopy, run: () => void copyPath(path, true) },
        {
          label: "Reveal in Explorer View",
          Icon: Files,
          run: () => {
            showSide();
            setSideView("explorer");
            revealInTree(path);
          }
        },
        { label: navigator.userAgent.includes("Windows") ? "Reveal in File Explorer" : "Reveal in File Manager", Icon: ExternalLink, run: () => void revealInOs(path) }
      ];
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [closeTab, closeTabs, copyPath, dirtyPaths, revealInOs, revealInTree, sessionId]
  );

  const revealRequest = usePanelStore((s) => s.revealRequest);
  const clearRevealRequest = usePanelStore((s) => s.clearRevealRequest);
  const handledReveal = useRef(0);
  useEffect(() => {
    if (!revealRequest || revealRequest.sessionId !== sessionId || revealRequest.nonce === handledReveal.current) return;
    handledReveal.current = revealRequest.nonce;
    const { path, line } = revealRequest;
    clearRevealRequest(revealRequest.nonce);
    hideSideForReveal();
    void (async () => {
      try {
        const info = await window.cw.readFileInfo(sessionId, path);
        if (!aliveRef.current) return;
        if (info.kind !== "missing") {
          openFile(path, { preview: true, line: line ?? null, revealTree: true });
          return;
        }
        const match = resolveRevealPath(path, await window.cw.listWorkspaceFiles(sessionId));
        if (!aliveRef.current) return;
        if (match.kind === "unique") openFile(match.path, { preview: true, line: line ?? null, revealTree: true });
        else if (match.kind === "ambiguous") setQuickOpen({ query: path });
        else showNotice(`No file named ${path} in this workspace.`, "error");
      } catch (err) {
        if (aliveRef.current) showNotice(`Couldn’t open ${path}: ${ipcErrorMessage(err)}`, "error");
      }
    })();
  }, [revealRequest, sessionId, openFile, clearRevealRequest, showNotice, hideSideForReveal]);

  useEffect(() => {
    if (revealHidden && tabsState.tabs.length === 0) showSide();
  }, [revealHidden, tabsState.tabs.length, showSide]);

  const filesCommand = usePanelStore((s) => s.filesCommand);
  const clearFilesCommand = usePanelStore((s) => s.clearFilesCommand);
  const handledCommand = useRef(0);
  useEffect(() => {
    if (!filesCommand || filesCommand.sessionId !== sessionId || filesCommand.nonce === handledCommand.current) return;
    handledCommand.current = filesCommand.nonce;
    if (filesCommand.kind === "quickOpen") {
      setQuickOpen({ query: "" });
    } else {
      showSide();
      setSideView("search");
      setSearchFocus((value) => value + 1);
    }
    clearFilesCommand(filesCommand.nonce);
  }, [filesCommand, sessionId, clearFilesCommand]);

  useEffect(() => {
    const timer = setTimeout(() => writeLocal(SIDE_KEY, JSON.stringify(side)), 300);
    return () => clearTimeout(timer);
  }, [side]);
  useEffect(() => writeLocal(WRAP_KEY, wrap ? "1" : "0"), [wrap]);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side.width;
    const limit = Math.max(SIDE_MIN, Math.min(SIDE_MAX, (rootRef.current?.clientWidth ?? 800) - 240));
    const onMove = (event: PointerEvent) => {
      setSide((prev) => ({ ...prev, width: Math.round(Math.min(limit, Math.max(SIDE_MIN, startWidth - (event.clientX - startX)))) }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("fx-resizing");
    };
    document.body.classList.add("fx-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const rootEmpty = childrenByDir[""]?.length === 0;

  return (
    <div
      ref={rootRef}
      className="fx"
      onKeyDown={(e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          setWrap((value) => !value);
        }
      }}
    >
      <EditorGroup
        sessionId={sessionId}
        tabs={tabsState.tabs}
        active={tabsState.active}
        views={views}
        reveal={reveal}
        baselines={baselines}
        sideVisible={sideShown}
        wrap={wrap}
        previewing={previewing}
        onToggleSide={() => (sideShown ? setSide((prev) => ({ ...prev, visible: false })) : showSide())}
        onToggleWrap={() => setWrap((value) => !value)}
        onTogglePreview={(path) =>
          setPreviewing((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          })
        }
        onActivate={(path) => useFileTabs.getState().open(sessionId, path, tabsRef.current.tabs.find((tab) => tab.path === path)?.preview ?? false)}
        onPin={(path) => useFileTabs.getState().pin(sessionId, path)}
        onClose={closeTab}
        onTabMenu={tabMenu}
        onSave={(path) => void save(path)}
        onRevealInTree={(path) => {
          showSide();
          setSideView("explorer");
          revealInTree(path);
        }}
        onResolveConflict={resolveConflict}
        onRetry={(path) => loadTab(path, true)}
      />
      {sideShown && (
        <>
          <div className="fx-splitter" role="separator" aria-orientation="vertical" aria-label="Resize explorer" onPointerDown={startResize} />
          <aside className="fx-side" style={{ width: side.width }}>
            <div className="fx-side-head">
              <button
                type="button"
                className={`fx-icon-btn${sideView === "search" ? " on" : ""}`}
                title={sideView === "search" ? "Back to files" : "Search in files (Ctrl+Shift+F)"}
                aria-label={sideView === "search" ? "Back to files" : "Search in files"}
                aria-pressed={sideView === "search"}
                onClick={() => {
                  if (sideView === "search") {
                    setSideView("explorer");
                    return;
                  }
                  setSideView("search");
                  setSearchFocus((value) => value + 1);
                }}
              >
                <Search size={14} />
              </button>
              {sideView === "explorer" && (
                <div className="fx-side-actions">
                  <button type="button" className="fx-icon-btn" title="New file" aria-label="New file" onClick={() => startCreate("createFile", focusPath)}>
                    <FilePlus2 size={14} />
                  </button>
                  <button type="button" className="fx-icon-btn" title="New folder" aria-label="New folder" onClick={() => startCreate("createDir", focusPath)}>
                    <FolderPlus size={14} />
                  </button>
                  <button type="button" className="fx-icon-btn" title="Refresh" aria-label="Refresh explorer" onClick={refreshAll}>
                    <RefreshCw size={14} />
                  </button>
                  <button type="button" className="fx-icon-btn" title="Collapse folders" aria-label="Collapse folders" onClick={collapseAll}>
                    <ChevronsDownUp size={14} />
                  </button>
                </div>
              )}
            </div>
            {sideView === "explorer" && (
              <FileExplorer
                rows={rows}
                rootStatus={{ loading: loading.has(""), error: dirErrors[""] ?? null, empty: rootEmpty, onRetry: () => retryDir("") }}
                activePath={tabsState.active}
                focusPath={focusPath}
                revealNonce={treeRevealNonce}
                decorations={decorations}
                dirtyPaths={dirtyPaths}
                edit={edit}
                editError={editError}
                onFocusPath={setFocusPath}
                onToggleDir={toggleDir}
                onOpen={(path, preview) => openFile(path, { preview })}
                onRetryDir={retryDir}
                onContextMenu={entryMenu}
                onCommitEdit={commitEdit}
                onCancelEdit={() => {
                  setEdit(null);
                  setEditError(null);
                }}
                onRename={startRename}
                onDelete={(row) => void deleteEntry(row)}
              />
            )}
            <FileSearchView
              sessionId={sessionId}
              hidden={sideView !== "search"}
              focusNonce={searchFocus}
              seed={searchSeed}
              onOpenMatch={(path, line, text, preview) => openFile(path, { preview, line, text })}
            />
          </aside>
        </>
      )}
      {quickOpen && (
        <QuickOpen
          initialQuery={quickOpen.query}
          sessionId={sessionId}
          recent={tabsState.tabs.map((tab) => tab.path).filter((path) => path !== tabsState.active)}
          onOpen={(path, line) => {
            setQuickOpen(null);
            openFile(path, { preview: false, line, revealTree: false });
          }}
          onClose={() => setQuickOpen(null)}
        />
      )}
      {menu && <FileContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {notice && (
        <div className={`fx-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button type="button" className="fx-icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X size={13} />
          </button>
        </div>
      )}
      {dialog}
    </div>
  );
}
