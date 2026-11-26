import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  CloudDownload,
  GitBranch,
  GitBranchPlus,
  GitFork,
  GitGraph,
  PackagePlus,
  PanelLeft,
  SquareTerminal
} from "lucide-react";
import type { GitDiffMode, HistoryCommit, HistoryLog, HistoryScope, HistoryTopicData, HistoryWorktree } from "@cw-code/contracts";
import { historyTopic } from "@cw-code/shared/topics";
import { usePanelStore } from "../../stores/panelStore.js";
import { useConnectionEpoch, useTopic } from "../../server/topics.js";
import { useGitStatus } from "../useGit.js";
import { useGitDiff } from "../useGitDiff.js";
import { HistoryFileDiff, useHistoryCommit } from "./HistoryCommitView.js";
import { GRAPH_COLUMN_MAX, GRAPH_COLUMN_MIN, HistoryGraph, REF_COLUMN_DEFAULT, REF_COLUMN_MAX, REF_COLUMN_MIN, WIP_SHA, type ColumnId, type WipSummary } from "./HistoryGraph.js";
import { loadShowAvatars, saveShowAvatars, useHistoryAvatars } from "./historyAvatars.js";
import { MenuSelect, type MenuOption } from "../MenuSelect.js";
import { useConfirm } from "../ConfirmDialog.js";
import { GitGlassToolbar, type ToolbarAction } from "./GitGlassToolbar.js";
import { GitGlassStatusBar } from "./GitGlassStatusBar.js";
import { DETAILS_DEFAULT_WIDTH, DETAILS_MAX_WIDTH, DETAILS_MIN_WIDTH, GitGlassDetails, type GitGlassSelection } from "./GitGlassDetails.js";
import { CommitDetails } from "./CommitDetails.js";
import { ChangesDetails } from "./ChangesDetails.js";
import { NARROW_WIDTH } from "./gitGlassLayout.js";
import { isEmptyQuery, matchesQuery, parseHistoryQuery, type HistorySearchScope } from "./historySearch.js";
import { startWidthDrag, usePersistedChoice, usePersistedWidth } from "./usePersistedState.js";

const PAGE_SIZE = 2000;
const MAX_LIMIT = 20000;
const NO_COMMITS: HistoryCommit[] = [];
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 250;
const COMING_SOON = "Coming in this change";
const TOGGLES = ["on", "off"] as const;
const ACTION_ICON = 17;
const isWip = (commit: HistoryCommit): boolean => commit.sha === WIP_SHA;

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setNarrow(width > 0 && width < NARROW_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

function refNamesBySha(log: HistoryLog | null): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const ref of log?.refs ?? []) {
    const list = names.get(ref.target);
    if (list) list.push(ref.name);
    else names.set(ref.target, [ref.name]);
  }
  return names;
}

function soon(id: string, label: string, icon: ToolbarAction["icon"]): ToolbarAction {
  return { id, label, icon, title: COMING_SOON, disabled: true };
}

export function GitGlassPanel({ scope: scopeProp }: { scope: HistoryScope }) {
  const scopeKey = historyTopic(scopeProp);
  const scope = useMemo(() => scopeProp, [scopeKey]);
  const sessionId = "sessionId" in scope ? scope.sessionId : null;
  const homeLabel = sessionId ? "This session" : "Project checkout";
  const [view, setView] = useState<{ path: string; key: string } | null>(null);
  const viewWorktree = view?.path ?? null;
  const topicName = historyTopic(scope, view?.key ?? null);
  const topic = useTopic<HistoryTopicData>(topicName);
  const status = useGitStatus(sessionId);
  const epoch = useConnectionEpoch();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [log, setLog] = useState<HistoryLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<GitGlassSelection | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const selectedSha = selection?.kind === "commit" ? selection.sha : null;
  const commit = useHistoryCommit(scope, selectedSha);
  const changesMode = selection?.kind === "changes" && sessionId && viewWorktree === null ? selection.mode : null;
  const diff = useGitDiff(changesMode ? sessionId : null, changesMode ?? "working");
  const diffModeRequest = usePanelStore((s) => s.diffModeRequest);
  const handledRequest = useRef(0);
  const { confirm, dialog } = useConfirm();
  const panelRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(panelRef);
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [homePath, setHomePath] = useState<string | null>(null);
  const busy = useRef<string | null>(null);
  const [sidebarSetting, setSidebarSetting] = usePersistedChoice("cw-code:git-glass-sidebar", TOGGLES, "on");
  const [sidebarOverlay, setSidebarOverlay] = useState(false);
  const sidebarWidth = usePersistedWidth("cw-code:git-glass-sidebar-width", SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
  const detailsWidth = usePersistedWidth("cw-code:git-glass-details-width", DETAILS_MIN_WIDTH, DETAILS_MAX_WIDTH);
  const refWidth = usePersistedWidth("cw-code:git-glass-ref-width", REF_COLUMN_MIN, REF_COLUMN_MAX);
  const graphWidth = usePersistedWidth("cw-code:git-glass-graph-width", GRAPH_COLUMN_MIN, GRAPH_COLUMN_MAX);
  const [datesSetting, setDatesSetting] = usePersistedChoice("cw-code:git-glass-exact-dates", TOGGLES, "off");
  const [authorsSetting, setAuthorsSetting] = usePersistedChoice("cw-code:git-glass-authors", TOGGLES, "on");
  const [searchText, setSearchText] = useState("");
  const [searchScope, setSearchScope] = useState<HistorySearchScope>("everything");
  const worktreeBranches = useMemo<ReadonlyMap<string, HistoryWorktree>>(() => {
    const byBranch = new Map<string, HistoryWorktree>();
    for (const worktree of log?.worktrees ?? []) {
      if (!worktree.isCurrent && worktree.branch) byBranch.set(worktree.branch, worktree);
    }
    return byBranch;
  }, [log]);
  const [showAvatars, setShowAvatars] = useState(loadShowAvatars);
  const avatars = useHistoryAvatars(scope, log?.commits ?? NO_COMMITS, isWip, showAvatars, topic?.data.avatarsRev ?? 0);
  const rev = topic?.data.rev ?? 0;
  const topicError = topic?.status === "error" ? (topic.error ?? "History unavailable") : (topic?.data.error ?? null);

  useEffect(() => {
    if (rev === 0) return;
    let active = true;
    setLoading(true);
    window.cw.getHistoryLog(scope, limit, viewWorktree).then(
      (next) => {
        if (!active) return;
        setLog(next);
        setError("");
        if (viewWorktree === null) setHomePath(next.worktrees.find((worktree) => worktree.isCurrent)?.path ?? null);
      },
      (reason: Error) => {
        if (!active) return;
        setLog(null);
        setError(reason.message);
      }
    ).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [topicName, rev, limit, epoch]);

  useEffect(() => {
    if (!narrow) setSidebarOverlay(false);
  }, [narrow]);

  const openWorktree = useCallback(
    (path: string | null): void => {
      const target = path === null || path === homePath ? null : (log?.worktrees.find((worktree) => worktree.path === path) ?? null);
      const next = target === null ? null : { path: target.path, key: target.key };
      if ((next?.key ?? null) === (view?.key ?? null)) return;
      setView(next);
      setLog(null);
      setError("");
      setSelection(null);
      setOpenPath(null);
      setActionError("");
    },
    [homePath, log, view]
  );

  const selectCommit = useCallback((sha: string): void => {
    setSelection({ kind: "commit", sha });
    setOpenPath(null);
  }, []);

  const selectChanges = useCallback((mode: GitDiffMode): void => {
    setSelection({ kind: "changes", mode });
    setOpenPath(null);
  }, []);

  const select = useCallback(
    (sha: string): void => {
      if (sha === WIP_SHA) {
        if (viewWorktree === null && sessionId && selection?.kind !== "changes") selectChanges("working");
        return;
      }
      selectCommit(sha);
    },
    [sessionId, viewWorktree, selection, selectCommit, selectChanges]
  );

  useEffect(() => {
    if (!sessionId || !diffModeRequest) return;
    const { clearDiffModeRequest, clearStaleDiffModeRequest } = usePanelStore.getState();
    if (diffModeRequest.sessionId !== sessionId) {
      clearStaleDiffModeRequest(sessionId);
      return;
    }
    if (diffModeRequest.nonce === handledRequest.current) return;
    handledRequest.current = diffModeRequest.nonce;
    openWorktree(null);
    selectChanges(diffModeRequest.mode);
    clearDiffModeRequest(diffModeRequest.nonce);
  }, [diffModeRequest, sessionId, openWorktree, selectChanges]);

  const highlight = useCallback(
    (sha: string): void => {
      if (sha !== WIP_SHA) selectCommit(sha);
    },
    [selectCommit]
  );

  const closeDiff = useCallback((): void => {
    setOpenPath(null);
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".history-scroll")?.focus({ preventScroll: true }));
  }, []);

  const clearSelection = useCallback((): void => {
    if (openPath) closeDiff();
    else {
      setSelection(null);
      setOpenPath(null);
    }
  }, [openPath, closeDiff]);

  const runAction = useCallback((label: string, task: () => Promise<unknown>): void => {
    if (busy.current) {
      setActionError(`Wait for “${busy.current}” to finish before starting another action`);
      return;
    }
    busy.current = label.replace(/…$/, "");
    setAction(label);
    setActionError("");
    task()
      .catch((reason: Error) => setActionError(reason.message))
      .finally(() => {
        busy.current = null;
        setAction(null);
      });
  }, []);

  const checkout = useCallback(
    (branch: string): void => {
      const elsewhere = worktreeBranches.get(branch);
      if (elsewhere) {
        openWorktree(elsewhere.path);
        return;
      }
      const checkedPath = viewWorktree ?? ("projectId" in scope ? homePath : null);
      const owned = checkedPath === null ? undefined : log?.worktrees.find((worktree) => worktree.path === checkedPath && worktree.sessionId);
      const run = (): void => runAction(`Checking out ${branch}…`, () => window.cw.checkoutHistory(scope, viewWorktree, branch));
      if (!owned) {
        run();
        return;
      }
      void confirm({
        title: `Switch ${owned.name} to ${branch}?`,
        message: "A cw-code session works in this checkout. Its branch changes too.",
        confirmLabel: "Switch branch"
      }).then((ok) => {
        if (ok) run();
      });
    },
    [runAction, scope, viewWorktree, homePath, worktreeBranches, openWorktree, log, confirm]
  );

  const query = useMemo(() => parseHistoryQuery(searchText, searchScope), [searchText, searchScope]);
  const searchMatches = useMemo<string[] | null>(() => {
    if (!log || isEmptyQuery(query)) return null;
    const refs = refNamesBySha(log);
    return log.commits
      .filter((candidate) =>
        matchesQuery(query, {
          sha: candidate.sha,
          subject: candidate.subject,
          authorName: candidate.authorName,
          authorEmail: candidate.authorEmail,
          refs: refs.get(candidate.sha) ?? []
        })
      )
      .map((candidate) => candidate.sha);
  }, [log, query]);
  const matchSet = useMemo(() => (searchMatches ? new Set(searchMatches) : null), [searchMatches]);
  const logIndex = useMemo(() => new Map((log?.commits ?? []).map((candidate, index) => [candidate.sha, index])), [log]);
  const matchPosition = searchMatches && selectedSha ? searchMatches.indexOf(selectedSha) : -1;
  const searchCounter =
    searchMatches === null ? null : searchMatches.length === 0 ? "No results" : `${matchPosition === -1 ? "?" : matchPosition + 1} of ${searchMatches.length}`;

  const jumpMatch = (direction: 1 | -1): void => {
    if (!searchMatches || searchMatches.length === 0) return;
    const current = selectedSha ? (logIndex.get(selectedSha) ?? -1) : -1;
    const ordered = direction === 1 ? searchMatches : [...searchMatches].reverse();
    const next =
      ordered.find((sha) => {
        const index = logIndex.get(sha) ?? -1;
        return direction === 1 ? index > current : current === -1 || index < current;
      }) ?? ordered[0];
    if (next) selectCommit(next);
  };

  const head = log?.head ?? null;
  const currentRef = head?.branch ? log?.refs.find((ref) => ref.kind === "local" && ref.isCurrent) : undefined;
  const pullBlocked = !head?.branch ? "HEAD is detached — check out a branch to pull" : !currentRef?.upstream ? `${head.branch} has no upstream branch` : null;
  const pullTitle = pullBlocked ?? `Fast-forward ${head?.branch} from ${currentRef?.upstream} (git pull --ff-only)`;
  const pull = (): void => runAction("Pulling…", () => window.cw.pullHistory(scope, viewWorktree));

  const toggleAvatars = (): void => {
    const next = !showAvatars;
    setShowAvatars(next);
    saveShowAvatars(next);
  };

  const branch = head?.branch ?? (head?.sha ? `detached at ${head.sha.slice(0, 7)}` : null);
  const worktrees = log?.worktrees ?? [];
  const activePath = viewWorktree ?? homePath;
  const viewed = viewWorktree === null ? undefined : worktrees.find((worktree) => worktree.path === viewWorktree);
  const viewName = view === null ? "" : baseName(view.path);
  const mainWorktree = worktrees.find((worktree) => worktree.isMain);
  const repoName = mainWorktree ? baseName(mainWorktree.path) : activePath ? baseName(activePath) : null;
  const sessionBranch = worktrees.find((worktree) => worktree.path === homePath)?.branch ?? null;
  const worktreeOptions: MenuOption[] = worktrees.map((worktree) => {
    const home = worktree.path === homePath;
    const owner = worktree.sessionId && !home ? " · used by another cw-code session" : "";
    return {
      id: worktree.path,
      label: home ? homeLabel : worktree.name,
      hint: worktree.branch ?? "detached",
      description: `${worktree.path}${owner}`,
      icon: <GitFork size={13} />
    };
  });
  const branchDisplay = branch ? (viewed ? `${viewed.name} · ${branch}` : branch) : "";
  const branchPicker =
    worktrees.length > 1 && activePath ? (
      <MenuSelect
        label="Switch worktree"
        title="Switch worktree — each one has its own branch and changes"
        direction="down"
        value={activePath}
        display={branchDisplay || (viewed ? viewed.name : homeLabel)}
        icon={<GitBranch size={12} aria-hidden="true" />}
        options={worktreeOptions}
        onPick={openWorktree}
        searchable
        searchPlaceholder="Filter worktrees…"
      />
    ) : branchDisplay ? (
      <span className="gg-repo-branch" title={viewed ? viewed.path : undefined}>
        <GitBranch size={12} aria-hidden="true" />
        {branchDisplay}
      </span>
    ) : null;

  const wip: WipSummary | null =
    viewWorktree === null && sessionId
      ? status?.available
        ? { files: status.dirtyCount, added: status.addedLines, deleted: status.deletedLines }
        : null
      : log?.wipCount
        ? { files: log.wipCount, added: null, deleted: null }
        : null;
  const failure = topicError ?? (error || null);

  const groups: ToolbarAction[][] = [
    [
      soon("fetch", "Fetch", <CloudDownload size={ACTION_ICON} aria-hidden="true" />),
      {
        id: "pull",
        label: "Pull",
        icon: <ArrowDownToLine size={ACTION_ICON} aria-hidden="true" />,
        title: pullTitle,
        disabled: pullBlocked !== null || action !== null,
        badge: currentRef && currentRef.behind > 0 ? currentRef.behind : null,
        onClick: pull
      },
      soon("push", "Push", <ArrowUpFromLine size={ACTION_ICON} aria-hidden="true" />)
    ],
    [
      soon("branch", "Branch", <GitBranchPlus size={ACTION_ICON} aria-hidden="true" />),
      soon("stash", "Stash", <PackagePlus size={ACTION_ICON} aria-hidden="true" />),
      soon("pop", "Pop", <ArchiveRestore size={ACTION_ICON} aria-hidden="true" />)
    ],
    sessionId
      ? [
          {
            id: "terminal",
            label: "Terminal",
            icon: <SquareTerminal size={ACTION_ICON} aria-hidden="true" />,
            title: "Open this session's terminal",
            onClick: () => usePanelStore.getState().revealTab(sessionId, "shell")
          }
        ]
      : []
  ];

  const sidebarOpen = narrow ? sidebarOverlay : sidebarSetting === "on";
  const toggleSidebar = (): void => {
    if (narrow) setSidebarOverlay((value) => !value);
    else setSidebarSetting(sidebarSetting === "on" ? "off" : "on");
  };
  const currentSidebarWidth = sidebarWidth.width ?? SIDEBAR_DEFAULT_WIDTH;
  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>): void =>
    startWidthDrag(event, currentSidebarWidth, 1, sidebarWidth.preview, sidebarWidth.save);

  const resizeColumn = (column: ColumnId, width: number | null, commit: boolean): void => {
    const target = column === "ref" ? refWidth : graphWidth;
    if (commit) target.save(width);
    else target.preview(width);
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if ((event.target as HTMLElement).closest(".menu, [role='dialog'], .confirm-backdrop")) return;
    if (openPath || selection) {
      event.preventDefault();
      clearSelection();
    } else if (sidebarOverlay) {
      event.preventDefault();
      setSidebarOverlay(false);
    }
  };

  const openActivePath = activePath && window.cw.local ? (): void => {
    window.cw.local?.openPath(activePath).catch((reason: Error) => setActionError(reason.message));
  } : null;

  const showDetails = !narrow || selection !== null;

  return (
    <div ref={panelRef} className={`git-glass${narrow ? " narrow" : ""}`} onKeyDown={onPanelKeyDown}>
      {dialog}
      <GitGlassToolbar
        narrow={narrow}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        repoName={repoName}
        branchPicker={branchPicker}
        groups={groups}
        search={{
          text: searchText,
          scope: searchScope,
          counter: searchCounter,
          onText: setSearchText,
          onScope: setSearchScope,
          onNext: () => jumpMatch(1),
          onPrevious: () => jumpMatch(-1)
        }}
        showAvatars={showAvatars}
        onToggleAvatars={toggleAvatars}
        viewOptions={{
          absoluteDates: datesSetting === "on",
          showAuthors: authorsSetting === "on",
          onAbsoluteDates: (value) => setDatesSetting(value ? "on" : "off"),
          onShowAuthors: (value) => setAuthorsSetting(value ? "on" : "off")
        }}
      />
      {worktrees.length > 1 && (
        <div className="history-worktrees" role="tablist" aria-label="Worktrees">
          <span className="history-worktrees-label">Worktrees</span>
          {worktrees.map((worktree) => {
            const home = worktree.path === homePath;
            const active = worktree.path === activePath;
            const owned = worktree.sessionId && !home ? " — used by another cw-code session" : "";
            return (
              <button
                key={worktree.path}
                type="button"
                role="tab"
                aria-selected={active}
                className={`history-worktree-tab${active ? " active" : ""}`}
                title={`${worktree.path} — ${worktree.branch ?? "detached"}${owned}`}
                onClick={() => openWorktree(worktree.path)}
              >
                <GitFork size={12} aria-hidden="true" />
                <span className="history-worktree-name">{home ? homeLabel : worktree.name}</span>
                {worktree.branch && <span className="history-worktree-branch">{worktree.branch}</span>}
              </button>
            );
          })}
        </div>
      )}
      {view !== null && (
        <div className="history-viewing" role="status">
          <GitFork size={13} aria-hidden="true" />
          {viewed ? (
            <span className="history-viewing-text">
              You are viewing the worktree <b>{viewed.name}</b>
              {viewed.branch ? <> on <b>{viewed.branch}</b></> : null}, {sessionId ? "not your session's checkout" : "not the project's checkout"}
              {sessionBranch ? <> (<b>{sessionBranch}</b>)</> : null}. Switching branches and pulling here do not change{" "}
              {sessionId ? "your session" : "the project's checkout"}.
            </span>
          ) : (
            <span className="history-viewing-text" title={view.path}>
              {failure ? (
                <>
                  The worktree <b>{viewName}</b> could not be loaded — it may have been removed.
                </>
              ) : (
                <>
                  Loading the worktree <b>{viewName}</b>…
                </>
              )}
            </span>
          )}
          <button type="button" className="inspect-mode" onClick={() => openWorktree(null)}>
            {sessionId ? "Back to this session" : "Back to the project's checkout"}
          </button>
        </div>
      )}
      {failure && <div className="inspect-error">History unavailable: {failure}</div>}
      {actionError && (
        <div className="inspect-error history-action-error" role="alert" onClick={() => setActionError("")} title="Click to dismiss">
          {actionError}
        </div>
      )}
      <div className="gg-workspace">
        {narrow && (
          <aside className="gg-strip" aria-label="Repository">
            <button
              type="button"
              className={`gg-icon-btn${sidebarOverlay ? " on" : ""}`}
              onClick={toggleSidebar}
              title={sidebarOverlay ? "Hide the sidebar" : "Show the sidebar"}
              aria-label="Toggle the sidebar"
              aria-pressed={sidebarOverlay}
            >
              <PanelLeft size={15} aria-hidden="true" />
            </button>
          </aside>
        )}
        {sidebarOpen && (
          <aside className={`gg-sidebar${narrow ? " overlay" : ""}`} style={{ width: currentSidebarWidth }} aria-label="Repository">
            <div className="gg-note gg-sidebar-empty">Branches, sessions and pull requests will be listed here.</div>
            <div
              className="gg-resize gg-resize-right"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the sidebar"
              title="Drag to resize (double-click resets)"
              onPointerDown={beginSidebarResize}
              onDoubleClick={() => sidebarWidth.save(null)}
            />
          </aside>
        )}
        <div className="gg-center">
          {action && <div className="gg-progress">{action}</div>}
          {loading && log && !action && <div className="gg-progress">Refreshing…</div>}
          {!failure && !log && <div className="diff-empty">Loading history…</div>}
          {!failure && log && log.commits.length === 0 && (
            <div className="inspect-empty">
              <GitGraph size={24} />
              <span>No commits yet</span>
            </div>
          )}
          {log && log.commits.length > 0 && (
            <HistoryGraph
              log={log}
              wip={wip}
              selected={changesMode ? WIP_SHA : selectedSha}
              onSelect={select}
              onHighlight={highlight}
              onLoadMore={limit < MAX_LIMIT ? () => setLimit((current) => Math.min(MAX_LIMIT, current + PAGE_SIZE)) : null}
              loadingMore={loading}
              avatars={avatars}
              showAvatars={showAvatars}
              onCheckout={checkout}
              worktreeBranches={worktreeBranches}
              wipHint={sessionId ? null : "Review uncommitted changes from a session in this project"}
              onClearSelection={clearSelection}
              matches={matchSet}
              refWidth={refWidth.width ?? REF_COLUMN_DEFAULT}
              graphWidth={graphWidth.width}
              onColumnResize={resizeColumn}
              narrow={narrow}
              showAuthors={authorsSetting === "on"}
              absoluteDates={datesSetting === "on"}
            />
          )}
          {openPath && selectedSha && (
            <HistoryFileDiff files={commit.files} path={openPath} missingNote="This file is not part of the commit" onOpenFile={setOpenPath} onClose={closeDiff} />
          )}
          {openPath && changesMode && (
            <HistoryFileDiff files={diff.files} path={openPath} missingNote="This file has no changes in this comparison" onOpenFile={setOpenPath} onClose={closeDiff} />
          )}
        </div>
        {showDetails && (
          <GitGlassDetails
            selection={selection}
            width={detailsWidth.width ?? DETAILS_DEFAULT_WIDTH}
            onResize={(width, commit) => (commit ? detailsWidth.save(width) : detailsWidth.preview(width))}
            onReset={() => detailsWidth.save(null)}
            onClose={() => {
              setSelection(null);
              setOpenPath(null);
            }}
            renderCommit={(sha) =>
              log ? (
                <CommitDetails
                  scope={scope}
                  sessionId={sessionId}
                  log={log}
                  sha={sha}
                  commit={commit}
                  avatars={avatars}
                  showAvatars={showAvatars}
                  openPath={openPath}
                  onOpenFile={setOpenPath}
                  onSelectCommit={selectCommit}
                  onCheckout={checkout}
                  busy={action !== null}
                  worktreeBranches={worktreeBranches}
                />
              ) : null
            }
            renderChanges={() =>
              changesMode && sessionId ? (
                <ChangesDetails sessionId={sessionId} diff={diff} onMode={selectChanges} openPath={openPath} onOpenFile={setOpenPath} />
              ) : (
                <div className="gg-note gg-details-empty">Changes are shown for this session's own checkout.</div>
              )
            }
          />
        )}
      </div>
      <GitGlassStatusBar
        branch={branch}
        upstream={currentRef?.upstream ? { name: currentRef.upstream, ahead: currentRef.ahead, behind: currentRef.behind, gone: currentRef.upstreamGone } : null}
        commits={log ? log.commits.length : null}
        truncated={log?.truncated ?? false}
        path={activePath}
        onOpenPath={openActivePath}
      />
    </div>
  );
}
