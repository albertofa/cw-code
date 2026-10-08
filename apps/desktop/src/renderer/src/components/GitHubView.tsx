import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubKind, IssueSummary, PrSummary, RepoRef, WorkflowRunSummary } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import {
  BUILTIN_VIEWS,
  clonedReposOf,
  resolveViews,
  scopeSplitQuery,
  searchKey,
  useGitHubStore
} from "../stores/githubStore.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";
import { usePrStore } from "../stores/prStore.js";
import { anchorRectOf, type AnchorRect } from "./AnchoredPopover.js";
import { GitHubHeader } from "./GitHubHeader.js";
import { GitHubResults, type Listing } from "./GitHubResults.js";
import { GitHubToolbar } from "./GitHubToolbar.js";
import { GitHubViewMenu } from "./GitHubViewMenu.js";
import { addQualifier, applyLocalFilters, normalizeQuery, queryProblems, runMatches, sortRuns, splitQuery } from "./githubQuery.js";
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

function builtinQuery(id: string): string {
  return BUILTIN_VIEWS.find((view) => view.id === id)?.query ?? "";
}

const ISSUE_INBOX_QUERY = builtinQuery("issue:inbox");
const RUN_WATCHING_QUERY = builtinQuery("run:watching");

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

  const inbox = usePrStore((s) => s.inbox);
  const projectRepos = usePrStore((s) => s.projectRepos);
  const projectIdForRef = usePrStore((s) => s.projectIdForRef);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const activeSessionId = useAppStore((s) => s.activeSessionId) ?? undefined;
  const rightVisible = usePanelStore((s) => selectSessionPanel(s, activeSessionId).rightVisible);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewButtonRef = useRef<HTMLButtonElement | null>(null);
  const [viewsMenu, setViewsMenu] = useState<ViewsMenuState | null>(null);

  useEffect(() => {
    const sync = () => useGitHubStore.getState().setActive(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      useGitHubStore.getState().setActive(false);
      useGitHubStore.getState().setWatchedRuns([]);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isEditingTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const viewer = storedViewer ?? inbox?.account?.login ?? null;
  const cloned = useMemo(() => clonedReposOf(projectRepos), [projectRepos]);
  const isCloned = useCallback((repo: RepoRef) => projectIdForRef(repo) !== null, [projectIdForRef, projectRepos]);
  const sessions = useMemo(() => Object.values(sessionsByProject).flat(), [sessionsByProject]);
  const issueMentionsMode = useMemo(() => mentionsMode(tab.query), [tab.query]);

  const resultKey = useMemo(() => searchKey(kind, tab.query, kind === "run" ? cloned : []), [kind, tab.query, cloned]);
  const prEntry = prResults[resultKey];
  const issueEntry = issueResults[resultKey];
  const runEntry = runResults[resultKey];
  const entry = kind === "pr" ? prEntry : kind === "issue" ? issueEntry : runEntry;

  const cachedPrs = useMemo(() => Object.values(prResults).flatMap((result) => result.data?.items ?? NO_PRS), [prResults]);
  const cachedIssues = useMemo(() => Object.values(issueResults).flatMap((result) => result.data?.items ?? NO_ISSUES), [issueResults]);
  const cachedRuns = useMemo(() => Object.values(runResults).flatMap((result) => result.data?.items ?? NO_RUNS), [runResults]);

  const involvedPrKeys = useMemo(() => involvedPrKeysOf(inbox?.items ?? NO_PRS, cachedPrs, viewer), [inbox, cachedPrs, viewer]);
  const runContext = useMemo(() => buildRunContext(viewer, involvedPrKeys, sessions), [viewer, involvedPrKeys, sessions]);

  const split = useMemo(() => (kind === "run" ? null : scopeSplitQuery(splitQuery(kind, tab.query))), [kind, tab.query]);
  const remoteEmpty = split !== null && split.remote.trim() === "";

  const listing = useMemo<Listing>(() => {
    if (kind === "run") {
      const runs = (runEntry?.data?.items ?? NO_RUNS).filter((run) => runMatches(run, tab.query, runContext));
      return { kind, items: sortRuns(runs, sortOf("run", tab.query)) };
    }
    const local = split?.local ?? [];
    const context = buildLocalContext(sessions, isCloned);
    if (kind === "pr") return { kind, items: applyLocalFilters(prEntry?.data?.items ?? NO_PRS, local, context) };
    return { kind, items: applyLocalFilters(issueEntry?.data?.items ?? NO_ISSUES, local, context) };
  }, [kind, tab.query, runEntry, prEntry, issueEntry, split, runContext, sessions, isCloned]);

  const liveRefs = useMemo(() => (listing.kind === "run" ? liveRunRefs(listing.items) : []), [listing]);
  const liveSignature = runRefsSignature(liveRefs);
  const stableLiveRefs = useMemo(() => liveRefs, [liveSignature]);
  useEffect(() => {
    setWatchedRuns(stableLiveRefs);
  }, [stableLiveRefs, setWatchedRuns]);

  const badges = useMemo<Record<GitHubKind, TabBadge>>(() => {
    const issues = issueResults[searchKey("issue", ISSUE_INBOX_QUERY, [])]?.data?.items ?? NO_ISSUES;
    const runs = runResults[searchKey("run", RUN_WATCHING_QUERY, cloned)]?.data?.items ?? NO_RUNS;
    return {
      pr: prBadge(inbox?.items ?? NO_PRS),
      issue: { count: assignedOpenIssueCount(issues, viewer), tone: "quiet" },
      run: { count: failingInvolvedRunCount(runs, runContext), tone: "bad" }
    };
  }, [inbox, issueResults, runResults, cloned, viewer, runContext]);

  const suggestionSource = useMemo(
    () => buildSuggestionSource({ viewer, prs: [...(inbox?.items ?? NO_PRS), ...cachedPrs], issues: cachedIssues, runs: cachedRuns, repos: projectRepos }),
    [viewer, inbox, cachedPrs, cachedIssues, cachedRuns, projectRepos]
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

  const onQueryChange = (query: string) => setQuery(kind, query);
  const onAddQualifier = (key: string, value: string) => setQuery(kind, addQualifier(useGitHubStore.getState().tabs[kind].query, key, value));
  const openViews = (saving: boolean) => {
    const button = viewButtonRef.current;
    if (button) setViewsMenu({ anchor: anchorRectOf(button), saving });
  };
  const reset = () => {
    if (view) selectView(view.id);
  };

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
        panelSessionId={activeSessionId}
        showPanelToggles={!rightVisible}
        inputRef={inputRef}
        viewButtonRef={viewButtonRef}
        viewsOpen={viewsMenu !== null}
        onSelectKind={setKind}
        onQueryChange={onQueryChange}
        onOpenViews={openViews}
        onReset={reset}
        onRefresh={() => void refresh(true)}
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
            <button type="button" className="pr-view-retry" onClick={() => void refresh(true)}>
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
          visibleCount={listing.items.length}
          problems={problems}
          refreshing={loading && hasItems}
          truncatedLimit={searchData?.truncated ? searchData.limit : null}
          onQueryChange={onQueryChange}
          onGroupChange={(group) => setGroup(kind, group)}
        />
        {remoteEmpty && <div className="pr-view-empty">Type a query or pick a view</div>}
        {showLoading && <div className="pr-view-empty">Loading {KIND_NOUNS[kind]}…</div>}
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
              issueMentionsMode={issueMentionsMode}
              isCloned={isCloned}
              onToggle={(groupId) => toggleCollapsed(kind, groupId)}
              onAddQualifier={onAddQualifier}
            />
          </div>
        )}
      </div>
      {viewsMenu && <GitHubViewMenu anchor={viewsMenu.anchor} initialSaving={viewsMenu.saving} onClose={() => setViewsMenu(null)} />}
    </div>
  );
}
