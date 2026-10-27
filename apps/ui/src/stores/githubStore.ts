import { create } from "zustand";
import type { GitHubMetaTopicData } from "@cw-code/contracts";
import type { GitHubKind, GitHubViewDef, GitHubViewGroup } from "../cw.js";
import { kindFromQuery, normalizeQuery } from "@cw-code/shared/githubQueryDsl";
import { BUILTIN_VIEWS } from "@cw-code/shared/githubViews";
import { GITHUB_META_TOPIC } from "@cw-code/shared/topics";
import { errorMessage } from "../components/errorMessage.js";
import { peekTopic } from "../server/topics.js";

export interface GitHubTabState {
  query: string;
  topicQuery: string;
  viewId: string | null;
  group: GitHubViewGroup;
  collapsed: string[];
}

export type GitHubView = GitHubViewDef;

export interface GitHubStore {
  kind: GitHubKind;
  tabs: Record<GitHubKind, GitHubTabState>;
  error: string | null;
  setKind(kind: GitHubKind): void;
  setQuery(kind: GitHubKind, query: string): void;
  selectView(view: GitHubView): void;
  setGroup(kind: GitHubKind, group: GitHubViewGroup): void;
  toggleCollapsed(kind: GitHubKind, groupId: string): void;
  refresh(topic: string, force: boolean): Promise<void>;
  saveView(name: string): Promise<void>;
  renameView(id: string, name: string): Promise<void>;
  deleteView(id: string): Promise<void>;
  clearError(): void;
}

const QUERY_DEBOUNCE_MS = 350;

const KINDS: GitHubKind[] = ["pr", "issue", "run"];

function initialTab(kind: GitHubKind): GitHubTabState {
  const view = BUILTIN_VIEWS.find((item) => item.kind === kind && item.id.endsWith(":inbox")) ?? BUILTIN_VIEWS.find((item) => item.kind === kind);
  const query = view?.query ?? `is:${kind}`;
  return { query, topicQuery: normalizeQuery(query), viewId: view?.id ?? null, group: view?.group ?? "none", collapsed: [] };
}

function knownViews(kind: GitHubKind): GitHubView[] {
  return peekTopic<Partial<GitHubMetaTopicData>>(GITHUB_META_TOPIC)?.data.views?.[kind] ?? [];
}

let clearTimers: () => void = () => undefined;

export const useGitHubStore = create<GitHubStore>((set, get) => {
  const timers: Record<GitHubKind, ReturnType<typeof setTimeout> | null> = { pr: null, issue: null, run: null };

  const fail = (context: string, err: unknown): void => {
    const message = errorMessage(err);
    console.warn(`[github] ${context}: ${message}`);
    set({ error: message });
  };

  const cancelTimer = (kind: GitHubKind) => {
    const timer = timers[kind];
    if (timer !== null) clearTimeout(timer);
    timers[kind] = null;
  };

  const updateTab = (kind: GitHubKind, patch: Partial<GitHubTabState>) => {
    set((state) => ({ tabs: { ...state.tabs, [kind]: { ...state.tabs[kind], ...patch } } }));
  };

  const scheduleTopicQuery = (kind: GitHubKind) => {
    cancelTimer(kind);
    timers[kind] = setTimeout(() => {
      timers[kind] = null;
      updateTab(kind, { topicQuery: normalizeQuery(get().tabs[kind].query) });
    }, QUERY_DEBOUNCE_MS);
  };

  const matchingViewId = (kind: GitHubKind, query: string): string | null => {
    const normalized = normalizeQuery(query);
    return knownViews(kind).find((view) => normalizeQuery(view.query) === normalized)?.id ?? null;
  };

  clearTimers = () => {
    for (const kind of KINDS) cancelTimer(kind);
  };

  return {
    kind: "pr",
    tabs: { pr: initialTab("pr"), issue: initialTab("issue"), run: initialTab("run") },
    error: null,

    setKind(kind: GitHubKind) {
      set({ kind });
    },

    setQuery(kind: GitHubKind, query: string) {
      const target = kindFromQuery(query) ?? kind;
      updateTab(target, { query, viewId: matchingViewId(target, query) ?? get().tabs[target].viewId });
      if (target !== kind) set({ kind: target });
      scheduleTopicQuery(target);
    },

    selectView(view: GitHubView) {
      cancelTimer(view.kind);
      updateTab(view.kind, { query: view.query, topicQuery: normalizeQuery(view.query), viewId: view.id, group: view.group });
      set({ kind: view.kind });
    },

    setGroup(kind: GitHubKind, group: GitHubViewGroup) {
      updateTab(kind, { group });
    },

    toggleCollapsed(kind: GitHubKind, groupId: string) {
      const collapsed = get().tabs[kind].collapsed;
      updateTab(kind, { collapsed: collapsed.includes(groupId) ? collapsed.filter((id) => id !== groupId) : [...collapsed, groupId] });
    },

    async refresh(topic: string, force: boolean) {
      try {
        await window.cw.refreshGitHubView(topic, force);
      } catch (err) {
        fail("refresh failed", err);
      }
    },

    async saveView(name: string) {
      const { kind, tabs } = get();
      const tab = tabs[kind];
      try {
        const view = await window.cw.saveGitHubView({ kind, name: name.trim(), query: normalizeQuery(tab.query), group: tab.group });
        updateTab(kind, { viewId: view.id });
        set({ error: null });
      } catch (err) {
        fail("saving view failed", err);
      }
    },

    async renameView(id: string, name: string) {
      try {
        await window.cw.renameGitHubView(id, name.trim());
        set({ error: null });
      } catch (err) {
        fail("renaming view failed", err);
      }
    },

    async deleteView(id: string) {
      try {
        await window.cw.deleteGitHubView(id);
        set({ error: null });
      } catch (err) {
        fail("deleting view failed", err);
        return;
      }
      for (const kind of KINDS) {
        if (get().tabs[kind].viewId === id) updateTab(kind, { viewId: null });
      }
    },

    clearError() {
      set({ error: null });
    }
  };
});

import.meta.hot?.dispose(() => clearTimers());
