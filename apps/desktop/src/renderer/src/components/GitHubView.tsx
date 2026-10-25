import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubKind, GitHubViewGroup, IssueSummary, PrSummary, RepoRef, WorkflowRunSummary } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import "./prInbox.css";
import {
  badgeSearchKeys,
  clonedReposOf,
  githubProjectRepos,
  scopedSplitOf,
  searchKey,
  useGitHubStore
} from "../stores/githubStore.js";
import { anchorRectOf, type AnchorRect } from "./AnchoredPopover.js";
import { GitHubHeader } from "./GitHubHeader.js";
import { GitHubResults, type Listing } from "./GitHubResults.js";
import { GitHubListSkeleton } from "./GitHubSkeletons.js";
import { GitHubToolbar } from "./GitHubToolbar.js";
import { GitHubViewMenu } from "./GitHubViewMenu.js";
import { useRetainedEntry } from "./useRetainedEntry.js";
import { EMPTY_GITHUB_CONTEXT, projectIdFor, useGitHubContext, usePrInbox, usePrInboxItems } from "./usePrs.js";
import { addQualifier, normalizeQuery, queryProblems } from "@cw-code/shared/githubQueryDsl";
import { resolveViews } from "@cw-code/shared/githubViews";
import { applyLocalFilters, runMatches, sortRuns } from "./githubViewQueryLegacy.js";
import {
  KIND_NOUNS,
  assignedOpenIssueCount,
  buildLocalContext,
  buildRunContext,
  buildSuggestionSource,
  currentViewOf,
  failingInvolvedRunCount,
  involvedPrKeysOf,
  isViewEdited,
  liveRunRefs,
  mentionsMode,
  prBadge,
  runRefsSignature,
  sortOf,
  type TabBadge
} from "./githubViewModel.js";

const NO_PRS: PrSummary[] = [];
const NO_ISSUES: IssueSummary[] = [];
const NO_RUNS: WorkflowRunSummary[] = [];

const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

interface ViewsMenuState {
  anchor: AnchorRect;
  saving: boolean;
}

export function GitHubView() {
  const kind = useGitHubStore((s) => s.kind);
  const tab = useGitHubStore((s) => s.tabs[s.kind]);
  const prResults = useGitHubStore((s) => s.prResults);
  const issueResults = useGitHubStore((s) => s.issueResults);
  const runResults = useGitHubStore((s) => s.runResults);
  const savedViews = useGitHubStore((s) => s.savedViews);
  const org = useGitHubStore((s) => s.org);
  const storedViewer = useGitHubStore((s) => s.viewer);
  const storeError = useGitHubStore((s) => s.error);
  const setKind = useGitHubStore((s) => s.setKind);
  const setQuery = useGitHubStore((s) => s.setQuery);
  const setGroup = useGitHubStore((s) => s.setGroup);
  const toggleCollapsed = useGitHubStore((s) => s.toggleCollapsed);
  const refresh = useGitHubStore((s) => s.refresh);
  const selectView = useGitHubStore((s) => s.selectView);
  const clearError = useGitHubStore((s) => s.clearError);
  const setWatchedRuns = useGitHubStore((s) => s.setWatchedRuns);

  const inbox = usePrInbox();
  const inboxItems = usePrInboxItems();
  const projectRepos = (useGitHubContext() ?? EMPTY_GITHUB_CONTEXT).projectRepos;
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewButtonRef = useRef<HTMLButtonElement | null>(null);
  const [viewsMenu, setViewsMenu] = useState<ViewsMenuState | null>(null);

  useEffect(() => {
    const onVisibility = () => useGitHubStore.getState().setActive(!document.hidden, true);
    useGitHubStore.getState().setActive(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      useGitHubStore.getState().setActive(false);
      useGitHubStore.getState().setWatchedRuns([]);
    };
  }, []);

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

  const viewer = storedViewer ?? inbox?.account?.login ?? null;
  const cloned = useMemo(() => clonedReposOf(projectRepos), [projectRepos]);
  const isCloned = useCallback((repo: RepoRef) => projectIdFor(projectRepos, repo) !== null, [projectRepos]);
  const sessions = useMemo(() => Object.values(sessionsByProject).flat(), [sessionsByProject]);
  const issueMentionsMode = useMemo(() => mentionsMode(tab.query), [tab.query]);

  const resultKey = useMemo(() => searchKey(kind, tab.query, kind === "run" ? cloned : []), [kind, tab.query, cloned]);
  const prEntry = useRetainedEntry(kind === "pr" ? prResults[resultKey] : undefined);
  const issueEntry = useRetainedEntry(kind === "issue" ? issueResults[resultKey] : undefined);
  const runEntry = useRetainedEntry(kind === "run" ? runResults[resultKey] : undefined);
  const entry = kind === "pr" ? prEntry : kind === "issue" ? issueEntry : runEntry;

  const cachedPrs = useMemo(() => Object.values(prResults).flatMap((result) => result.data?.items ?? NO_PRS), [prResults]);
  const cachedIssues = useMemo(() => Object.values(issueResults).flatMap((result) => result.data?.items ?? NO_ISSUES), [issueResults]);
  const cachedRuns = useMemo(() => Object.values(runResults).flatMap((result) => result.data?.items ?? NO_RUNS), [runResults]);

  const involvedPrKeys = useMemo(() => involvedPrKeysOf(inboxItems, cachedPrs, viewer), [inboxItems, cachedPrs, viewer]);
  const runContext = useMemo(() => buildRunContext(viewer, involvedPrKeys, sessions), [viewer, involvedPrKeys, sessions]);

  const split = useMemo(() => (kind === "run" ? null : scopedSplitOf(kind, tab.query)), [kind, tab.query]);
  const remoteEmpty = split !== null && split.remote.trim() === "";

  const listing = useMemo<Listing>(() => {
    if (kind === "run") {
      const runs = (runEntry?.data?.items ?? NO_RUNS).filter((run) => runMatches(run, tab.query, runContext));
      return { kind, items: sortRuns(runs, sortOf("run", tab.query)) };
    }
    const local = split?.local ?? [];
    const context = buildLocalContext(sessions, isCloned);
    if (kind === "pr") return { kind, items: remoteEmpty ? NO_PRS : applyLocalFilters(prEntry?.data?.items ?? NO_PRS, local, context) };
    return { kind, items: remoteEmpty ? NO_ISSUES : applyLocalFilters(issueEntry?.data?.items ?? NO_ISSUES, local, context) };
  }, [kind, tab.query, runEntry, prEntry, issueEntry, split, remoteEmpty, runContext, sessions, isCloned]);

  const liveRefs = useMemo(() => (listing.kind === "run" ? liveRunRefs(listing.items) : []), [listing]);
  const liveSignature = runRefsSignature(liveRefs);
  const stableLiveRefs = useMemo(() => liveRefs, [liveSignature]);
  useEffect(() => {
    setWatchedRuns(stableLiveRefs);
  }, [stableLiveRefs, setWatchedRuns]);

  const badges = useMemo<Record<GitHubKind, TabBadge>>(() => {
    const keys = badgeSearchKeys(cloned);
    const issues = issueResults[keys.issue]?.data?.items ?? NO_ISSUES;
    const runs = runResults[keys.run]?.data?.items ?? NO_RUNS;
    return {
      pr: prBadge(inboxItems),
      issue: { count: assignedOpenIssueCount(issues, viewer), tone: "quiet" },
      run: { count: failingInvolvedRunCount(runs, runContext), tone: "bad" }
    };
  }, [inboxItems, issueResults, runResults, cloned, viewer, runContext]);

  const suggestionSource = useMemo(
    () => buildSuggestionSource({ viewer, prs: [...inboxItems, ...cachedPrs], issues: cachedIssues, runs: cachedRuns, repos: githubProjectRepos(projectRepos) }),
    [viewer, inboxItems, cachedPrs, cachedIssues, cachedRuns, projectRepos]
  );

  const views = useMemo(() => resolveViews(kind, org, savedViews), [kind, org, savedViews]);
  const view = currentViewOf(views, tab.viewId);
  const edited = isViewEdited(view, tab.query);
  const problems = useMemo(() => queryProblems(kind, tab.query), [kind, tab.query]);

  const searchData = kind === "run" ? null : (kind === "pr" ? prEntry : issueEntry)?.data ?? null;
  const account = entry?.data?.account ?? inbox?.account ?? null;
  const loading = entry?.loading ?? false;
  const stale = entry?.stale === true;
  const hasItems = listing.items.length > 0;
  const showLoading = !remoteEmpty && !hasItems && (entry === undefined || entry.loading);
  const showEmpty = !remoteEmpty && !hasItems && entry !== undefined && !entry.loading && entry.error === null;

  const countsUnavailable = split !== null && split.local.length > 0;
  const viewId = view?.id ?? null;

  const onQueryChange = useCallback((query: string) => setQuery(kind, query), [kind, setQuery]);
  const onAddQualifier = useCallback(
    (key: string, value: string) => setQuery(kind, addQualifier(useGitHubStore.getState().tabs[kind].query, key, value)),
    [kind, setQuery]
  );
  const onToggleGroup = useCallback((groupId: string) => toggleCollapsed(kind, groupId), [kind, toggleCollapsed]);
  const onGroupChange = useCallback((group: GitHubViewGroup) => setGroup(kind, group), [kind, setGroup]);
  const onRefresh = useCallback(() => void refresh(true), [refresh]);
  const openViews = useCallback((saving: boolean) => {
    const button = viewButtonRef.current;
    if (button) setViewsMenu({ anchor: anchorRectOf(button), saving });
  }, []);
  const closeViews = useCallback(() => setViewsMenu(null), []);
  const reset = useCallback(() => {
    if (viewId) selectView(viewId);
  }, [viewId, selectView]);

  return (
    <div className="thread-col pr-view pr-inbox-view hub-view">
      <GitHubHeader
        kind={kind}
        query={tab.query}
        view={view}
        edited={edited}
        badges={badges}
        source={suggestionSource}
        account={account}
        fetchedAt={entry?.data?.fetchedAt ?? null}
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
        {entry?.error && (
          <div className="pr-view-error" role="alert">
            <span>{entry.error}</span>
            <button type="button" className="pr-view-retry" onClick={onRefresh}>
              Retry
            </button>
          </div>
        )}
        <GitHubToolbar
          kind={kind}
          query={tab.query}
          group={tab.group}
          openCount={searchData?.openCount ?? null}
          closedCount={searchData?.closedCount ?? null}
          countsUnavailable={countsUnavailable}
          visibleCount={listing.items.length}
          problems={problems}
          refreshing={loading && hasItems}
          truncatedLimit={searchData?.truncated ? searchData.limit : null}
          onQueryChange={onQueryChange}
          onGroupChange={onGroupChange}
        />
        {remoteEmpty && <div className="pr-view-empty">Type a query or pick a view</div>}
        {showLoading && <GitHubListSkeleton label={`Loading ${KIND_NOUNS[kind]}`} />}
        {showEmpty && (
          <div className="pr-view-empty">
            No {KIND_NOUNS[kind]} match <code>{normalizeQuery(tab.query)}</code>.
            {view && edited && (
              <>
                {" "}
                <button type="button" className="hub-link" onClick={reset}>
                  Reset to “{view.name}”
                </button>
              </>
            )}
          </div>
        )}
        {hasItems && (
          <div className={`hub-results${stale ? " stale" : ""}`} aria-busy={loading}>
            <GitHubResults
              listing={listing}
              mode={tab.group}
              collapsed={tab.collapsed}
              viewer={viewer}
              mentionsMode={issueMentionsMode}
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
