import { create } from "zustand";
import { rebasePath } from "./treeModel.js";

export interface FileTab {
  path: string;
  preview: boolean;
}

export interface FileTabsState {
  tabs: FileTab[];
  active: string | null;
}

export const FILE_TABS_KEY = "cw-code:file-tabs";
export const FILE_TREE_EXPANDED_KEY = "cw-code:file-tree-expanded";
export const MAX_TABS_PER_SESSION = 30;
export const MAX_PERSISTED_SESSIONS = 100;

export const EMPTY_FILE_TABS: FileTabsState = { tabs: [], active: null };

export function openTab(state: FileTabsState, path: string, preview: boolean): FileTabsState {
  const existing = state.tabs.find((tab) => tab.path === path);
  if (existing) {
    const pinned = existing.preview && !preview;
    if (state.active === path && !pinned) return state;
    const tabs = pinned ? state.tabs.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)) : state.tabs;
    return { tabs, active: path };
  }
  const tab: FileTab = { path, preview };
  const previewIndex = preview ? state.tabs.findIndex((candidate) => candidate.preview) : -1;
  if (previewIndex >= 0) {
    const tabs = [...state.tabs];
    tabs[previewIndex] = tab;
    return { tabs, active: path };
  }
  const activeIndex = state.tabs.findIndex((candidate) => candidate.path === state.active);
  const insertAt = activeIndex < 0 ? state.tabs.length : activeIndex + 1;
  return { tabs: [...state.tabs.slice(0, insertAt), tab, ...state.tabs.slice(insertAt)], active: path };
}

export function pinTab(state: FileTabsState, path: string): FileTabsState {
  if (!state.tabs.some((tab) => tab.path === path && tab.preview)) return state;
  return { ...state, tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)) };
}

function removeWhere(state: FileTabsState, shouldRemove: (tab: FileTab, index: number) => boolean): FileTabsState {
  const tabs = state.tabs.filter((tab, index) => !shouldRemove(tab, index));
  if (tabs.length === state.tabs.length) return state;
  const activeIndex = state.tabs.findIndex((tab) => tab.path === state.active);
  if (activeIndex < 0 || tabs.some((tab) => tab.path === state.active)) return { tabs, active: state.active };
  const right = state.tabs.slice(activeIndex + 1).find((tab) => tabs.includes(tab));
  const left = state.tabs.slice(0, activeIndex).reverse().find((tab) => tabs.includes(tab));
  return { tabs, active: (right ?? left)?.path ?? null };
}

export function closeTab(state: FileTabsState, path: string): FileTabsState {
  return removeWhere(state, (tab) => tab.path === path);
}

export function closeOthers(state: FileTabsState, path: string): FileTabsState {
  if (!state.tabs.some((tab) => tab.path === path)) return state;
  const next = removeWhere(state, (tab) => tab.path !== path);
  return { ...next, active: path };
}

export function closeToRight(state: FileTabsState, path: string): FileTabsState {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return state;
  return removeWhere(state, (_tab, tabIndex) => tabIndex > index);
}

export function closeAll(state: FileTabsState): FileTabsState {
  return state.tabs.length === 0 && state.active === null ? state : EMPTY_FILE_TABS;
}

export function renameTabs(state: FileTabsState, from: string, to: string): FileTabsState {
  if (!state.tabs.some((tab) => rebasePath(tab.path, from, to) !== null)) return state;
  const tabs: FileTab[] = [];
  for (const tab of state.tabs) {
    const path = rebasePath(tab.path, from, to) ?? tab.path;
    const duplicate = tabs.findIndex((candidate) => candidate.path === path);
    if (duplicate < 0) tabs.push({ path, preview: tab.preview });
    else if (!tab.preview) tabs[duplicate] = { path, preview: false };
  }
  const active = state.active === null ? null : (rebasePath(state.active, from, to) ?? state.active);
  return { tabs, active };
}

export function removeTabs(state: FileTabsState, path: string): FileTabsState {
  return removeWhere(state, (tab) => rebasePath(tab.path, path, path) !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTab(value: unknown): FileTab | null {
  if (!isRecord(value) || typeof value.path !== "string" || value.path === "") return null;
  return { path: value.path, preview: value.preview === true };
}

function keepSinglePreview(tabs: FileTab[], active: string | null): FileTab[] {
  const previews = tabs.filter((tab) => tab.preview);
  if (previews.length <= 1) return tabs;
  const kept = (previews.find((tab) => tab.path === active) ?? previews[0]).path;
  return tabs.map((tab) => (tab.preview && tab.path !== kept ? { ...tab, preview: false } : tab));
}

function parseTabsState(value: unknown): FileTabsState | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const seen = new Set<string>();
  const tabs: FileTab[] = [];
  for (const item of value.tabs) {
    const tab = parseTab(item);
    if (!tab || seen.has(tab.path)) continue;
    seen.add(tab.path);
    tabs.push(tab);
  }
  const active = typeof value.active === "string" && seen.has(value.active) ? value.active : (tabs[0]?.path ?? null);
  return { tabs: keepSinglePreview(tabs, active), active: tabs.length === 0 ? null : active };
}

function capTabs(state: FileTabsState): FileTabsState {
  if (state.tabs.length <= MAX_TABS_PER_SESSION) return state;
  const activeIndex = Math.max(0, state.tabs.findIndex((tab) => tab.path === state.active));
  const start = Math.min(Math.max(0, activeIndex - Math.floor(MAX_TABS_PER_SESSION / 2)), state.tabs.length - MAX_TABS_PER_SESSION);
  return { tabs: state.tabs.slice(start, start + MAX_TABS_PER_SESSION), active: state.active };
}

function capSessions<T>(bySession: Record<string, T>): Record<string, T> {
  const entries = Object.entries(bySession);
  return entries.length <= MAX_PERSISTED_SESSIONS ? bySession : Object.fromEntries(entries.slice(entries.length - MAX_PERSISTED_SESSIONS));
}

export function parseFileTabs(raw: string | null): Record<string, FileTabsState> {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return {};
  const result: Record<string, FileTabsState> = {};
  for (const [sessionId, value] of Object.entries(parsed)) {
    const state = parseTabsState(value);
    if (state && state.tabs.length > 0) result[sessionId] = capTabs(state);
  }
  return capSessions(result);
}

export function serializeFileTabs(bySession: Record<string, FileTabsState>): string {
  const result: Record<string, FileTabsState> = {};
  for (const [sessionId, state] of Object.entries(bySession)) {
    if (state.tabs.length > 0) result[sessionId] = capTabs(state);
  }
  return JSON.stringify(capSessions(result));
}

export function parseExpanded(raw: string | null): Record<string, string[]> {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return {};
  const result: Record<string, string[]> = {};
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const paths = value.filter((path): path is string => typeof path === "string" && path !== "");
    if (paths.length > 0) result[sessionId] = [...new Set(paths)];
  }
  return capSessions(result);
}

export function serializeExpanded(expandedBySession: Record<string, string[]>): string {
  const result: Record<string, string[]> = {};
  for (const [sessionId, paths] of Object.entries(expandedBySession)) {
    if (paths.length > 0) result[sessionId] = paths;
  }
  return JSON.stringify(capSessions(result));
}

function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`failed to persist ${key}`, error);
  }
}

function touch<T>(bySession: Record<string, T>, sessionId: string, next: T): Record<string, T> {
  const others = Object.entries(bySession).filter(([id]) => id !== sessionId);
  return Object.fromEntries([...others, [sessionId, next]]);
}

export interface FileTabsActions {
  open(sessionId: string, path: string, preview: boolean): void;
  pin(sessionId: string, path: string): void;
  close(sessionId: string, path: string): void;
  closeOthers(sessionId: string, path: string): void;
  closeToRight(sessionId: string, path: string): void;
  closeAll(sessionId: string): void;
  rename(sessionId: string, from: string, to: string): void;
  remove(sessionId: string, path: string): void;
  setExpanded(sessionId: string, paths: string[]): void;
}

export interface FileTabsStore extends FileTabsActions {
  bySession: Record<string, FileTabsState>;
  expandedBySession: Record<string, string[]>;
}

export const useFileTabs = create<FileTabsStore>((set, get) => {
  const apply = (sessionId: string, reduce: (state: FileTabsState) => FileTabsState): void => {
    const current = get().bySession[sessionId] ?? EMPTY_FILE_TABS;
    const next = reduce(current);
    if (next === current) return;
    const bySession = touch(get().bySession, sessionId, next);
    set({ bySession });
    writeStorage(FILE_TABS_KEY, serializeFileTabs(bySession));
  };

  return {
    bySession: parseFileTabs(readStorage(FILE_TABS_KEY)),
    expandedBySession: parseExpanded(readStorage(FILE_TREE_EXPANDED_KEY)),
    open: (sessionId, path, preview) => apply(sessionId, (state) => openTab(state, path, preview)),
    pin: (sessionId, path) => apply(sessionId, (state) => pinTab(state, path)),
    close: (sessionId, path) => apply(sessionId, (state) => closeTab(state, path)),
    closeOthers: (sessionId, path) => apply(sessionId, (state) => closeOthers(state, path)),
    closeToRight: (sessionId, path) => apply(sessionId, (state) => closeToRight(state, path)),
    closeAll: (sessionId) => apply(sessionId, closeAll),
    rename: (sessionId, from, to) => apply(sessionId, (state) => renameTabs(state, from, to)),
    remove: (sessionId, path) => apply(sessionId, (state) => removeTabs(state, path)),
    setExpanded: (sessionId, paths) => {
      const previous = get().expandedBySession[sessionId] ?? [];
      if (previous.length === paths.length && previous.every((path, index) => path === paths[index])) return;
      const expandedBySession = touch(get().expandedBySession, sessionId, paths);
      set({ expandedBySession });
      writeStorage(FILE_TREE_EXPANDED_KEY, serializeExpanded(expandedBySession));
    }
  };
});
