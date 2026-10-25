import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { orderedEntries, type TopicState } from "@cw-code/client";
import type { GitHubRow, GitHubViewTopicData } from "@cw-code/contracts";
import { addQualifier, normalizeQuery, queryProblems } from "@cw-code/shared/githubQueryDsl";
import { githubViewTopic } from "@cw-code/shared/topics";
import type { GitHubKind, GitHubViewGroup, IssueSummary, PrSummary, RepoRef, WorkflowRunSummary } from "../cw.js";
import { useTopic } from "../server/topics.js";
import { useGitHubStore, type GitHubView as GitHubViewDef } from "../stores/githubStore.js";
import "./prInbox.css";
import { anchorRectOf, type AnchorRect } from "./AnchoredPopover.js";
import { GitHubHeader } from "./GitHubHeader.js";
import { GitHubResults } from "./GitHubResults.js";
import { GitHubListSkeleton } from "./GitHubSkeletons.js";
import { GitHubToolbar } from "./GitHubToolbar.js";
import { GitHubViewMenu } from "./GitHubViewMenu.js";
import { KIND_NOUNS, buildSuggestionSource, currentViewOf, githubProjectRepos, isViewEdited, type TabBadge } from "./githubViewModel.js";
import { useGitHubBadges, useGitHubMetaContext, useGitHubViews } from "./useGitHubMeta.js";
import { projectIdFor, usePrInboxItems } from "./usePrs.js";

type ViewTopicState = TopicState<Partial<GitHubViewTopicData>>;

const ROW_PREFIX = "row/";
const NO_ROWS: GitHubRow[] = [];
const NO_VIEWS: GitHubViewDef[] = [];
const NO_BADGE: TabBadge = { count: 0, tone: "default" };

const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function isSettled(state: ViewTopicState | undefined): state is ViewTopicState {
  return state !== undefined && (state.status !== "subscribing" || state.rev > 0);
}

function useViewTopic(kind: GitHubKind, topic: string): { state: ViewTopicState | undefined; stale: boolean } {
  const live = useTopic<Partial<GitHubViewTopicData>>(topic);
  const shown = useRef<Partial<Record<GitHubKind, { topic: string; state: ViewTopicState }>>>({});
  const settled = isSettled(live);
  useEffect(() => {
    if (live && settled) shown.current[kind] = { topic, state: live };
  }, [kind, topic, live, settled]);
  if (settled) return { state: live, stale: false };
  const previous = shown.current[kind];
  if (previous && previous.topic !== topic) return { state: previous.state, stale: true };
  return { state: live, stale: false };
}

interface ViewsMenuState {
  anchor: AnchorRect;
  saving: boolean;
}

export function GitHubView() {
  const kind = useGitHubStore((s) => s.kind);
  const tab = useGitHubStore((s) => s.tabs[s.kind]);
  const storeError = useGitHubStore((s) => s.error);
  const setKind = useGitHubStore((s) => s.setKind);
  const setQuery = useGitHubStore((s) => s.setQuery);
  const setGroup = useGitHubStore((s) => s.setGroup);
  const toggleCollapsed = useGitHubStore((s) => s.toggleCollapsed);
  const refresh = useGitHubStore((s) => s.refresh);
  const selectView = useGitHubStore((s) => s.selectView);
  const clearError = useGitHubStore((s) => s.clearError);

  const context = useGitHubMetaContext();
  const allViews = useGitHubViews();
  const metaBadges = useGitHubBadges();
  const inboxItems = usePrInboxItems();

  const topic = useMemo(() => githubViewTopic(kind, tab.topicQuery), [kind, tab.topicQuery]);
  const { state, stale } = useViewTopic(kind, topic);
  const data = state?.data;
  const view = data?.view;
  const rows = useMemo(() => (data ? orderedEntries<GitHubRow>(data as Record<string, unknown>, ROW_PREFIX) : NO_ROWS), [data]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewButtonRef = useRef<HTMLButtonElement | null>(null);
  const [viewsMenu, setViewsMenu] = useState<ViewsMenuState | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isEditingTarget(event.target) || document.querySelector(MODAL_SELECTOR)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const projectRepos = context?.projectRepos;
  const account = view?.account ?? null;
  const viewer = context?.viewer ?? account?.login ?? null;
  const isCloned = useCallback((repo: RepoRef) => projectIdFor(projectRepos ?? [], repo) !== null, [projectRepos]);

  const badges = useMemo<Record<GitHubKind, TabBadge>>(
    () => ({ pr: metaBadges?.pr ?? NO_BADGE, issue: metaBadges?.issue ?? NO_BADGE, run: metaBadges?.run ?? NO_BADGE }),
    [metaBadges]
  );

  const suggestionSource = useMemo(() => {
    const prs: PrSummary[] = [...inboxItems];
    const issues: IssueSummary[] = [];
    const runs: WorkflowRunSummary[] = [];
    for (const row of rows) {
      if (row.subject.kind === "pr") prs.push(row.subject.pr);
      else if (row.subject.kind === "issue") issues.push(row.subject.issue);
      else runs.push(row.subject.run);
    }
    return buildSuggestionSource({ viewer, prs, issues, runs, repos: githubProjectRepos(projectRepos ?? []) });
  }, [viewer, inboxItems, rows, projectRepos]);

  const views = allViews?.[kind] ?? NO_VIEWS;
  const currentView = currentViewOf(views, tab.viewId);
  const edited = isViewEdited(currentView, tab.query);
  const problems = useMemo(() => queryProblems(kind, tab.query), [kind, tab.query]);

  const topicError = state?.status === "error" ? state.error : null;
  const viewError = stale ? null : (view?.error ?? null);
  const loading = stale || (view?.loading ?? topicError === null);
  const hasItems = rows.length > 0;
  const settledView = !stale && view !== undefined && !view.loading && view.error === null;
  const awaitingQuery = settledView && view.fetchedAt === null && !hasItems;
  const showLoading = !awaitingQuery && !hasItems && loading;
  const showEmpty = settledView && view.fetchedAt !== null && !hasItems;
  const counted = kind !== "run" && view !== undefined;

  const onQueryChange = useCallback((query: string) => setQuery(kind, query), [kind, setQuery]);
  const onAddQualifier = useCallback(
    (key: string, value: string) => setQuery(kind, addQualifier(useGitHubStore.getState().tabs[kind].query, key, value)),
    [kind, setQuery]
  );
  const onToggleGroup = useCallback((groupId: string) => toggleCollapsed(kind, groupId), [kind, toggleCollapsed]);
  const onGroupChange = useCallback((group: GitHubViewGroup) => setGroup(kind, group), [kind, setGroup]);
  const onRefresh = useCallback(() => void refresh(topic, true), [refresh, topic]);
  const openViews = useCallback((saving: boolean) => {
    const button = viewButtonRef.current;
    if (button) setViewsMenu({ anchor: anchorRectOf(button), saving });
  }, []);
  const closeViews = useCallback(() => setViewsMenu(null), []);
  const reset = useCallback(() => {
    if (currentView) selectView(currentView);
  }, [currentView, selectView]);

  return (
    <div className="thread-col pr-view pr-inbox-view hub-view">
      <GitHubHeader
        kind={kind}
        query={tab.query}
        view={currentView}
        edited={edited}
        badges={badges}
        source={suggestionSource}
        account={account}
        fetchedAt={view?.fetchedAt ?? null}
        loading={loading}
        inputRef={inputRef}
        viewButtonRef={viewButtonRef}
        viewsOpen={viewsMenu !== null}
        onSelectKind={setKind}
        onQueryChange={onQueryChange}
        onOpenViews={openViews}
        onReset={reset}
        onRefresh={onRefresh}
      />
      <div className="pr-view-body pr-inbox-body">
        {storeError && (
          <div className="pr-view-error" role="alert">
            <span>{storeError}</span>
            <button type="button" className="pr-view-retry" onClick={clearError}>
              Dismiss
            </button>
          </div>
        )}
        {topicError && (
          <div className="pr-view-error" role="alert">
            <span>{topicError}</span>
          </div>
        )}
        {viewError && (
          <div className="pr-view-error" role="alert">
            <span>{viewError}</span>
            <button type="button" className="pr-view-retry" onClick={onRefresh}>
              Retry
            </button>
          </div>
        )}
        <GitHubToolbar
          kind={kind}
          query={tab.query}
          group={tab.group}
          openCount={counted ? view.openCount : null}
          closedCount={counted ? view.closedCount : null}
          countsUnavailable={view?.countsUnavailable ?? false}
          visibleCount={rows.length}
          problems={problems}
          refreshing={loading && hasItems}
          truncatedLimit={counted && view.truncated ? view.limit : null}
          onQueryChange={onQueryChange}
          onGroupChange={onGroupChange}
        />
        {awaitingQuery && <div className="pr-view-empty">Type a query or pick a view</div>}
        {showLoading && <GitHubListSkeleton label={`Loading ${KIND_NOUNS[kind]}`} />}
        {showEmpty && (
          <div className="pr-view-empty">
            No {KIND_NOUNS[kind]} match <code>{normalizeQuery(tab.query)}</code>.
            {currentView && edited && (
              <>
                {" "}
                <button type="button" className="hub-link" onClick={reset}>
                  Reset to “{currentView.name}”
                </button>
              </>
            )}
          </div>
        )}
        {hasItems && (
          <div className={`hub-results${stale ? " stale" : ""}`} aria-busy={loading}>
            <GitHubResults
              kind={kind}
              rows={rows}
              mode={tab.group}
              collapsed={tab.collapsed}
              viewer={viewer}
              isCloned={isCloned}
              onToggle={onToggleGroup}
              onAddQualifier={onAddQualifier}
            />
          </div>
        )}
      </div>
      {viewsMenu && <GitHubViewMenu anchor={viewsMenu.anchor} initialSaving={viewsMenu.saving} onClose={closeViews} />}
    </div>
  );
}
