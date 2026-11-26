import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
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
  SquareTerminal
} from "lucide-react";
import type { GitDiffMode, HistoryCommit, HistoryLog, HistoryScope, HistoryTopicData, HistoryWorktree, PrRef } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { historyTopic } from "@cw-code/shared/topics";
import { useAppStore } from "../../stores/appStore.js";
import { usePanelStore } from "../../stores/panelStore.js";
import { usePrStore } from "../../stores/prStore.js";
import { useConnectionEpoch, useTopic } from "../../server/topics.js";
import { useGitStatus } from "../useGit.js";
import { useGitDiff } from "../useGitDiff.js";
import { HistoryFileDiff, useHistoryCommit } from "./HistoryCommitView.js";
import { GRAPH_COLUMN_MAX, GRAPH_COLUMN_MIN, HistoryGraph, REF_COLUMN_DEFAULT, REF_COLUMN_MAX, REF_COLUMN_MIN, WIP_SHA, type ColumnId, type WipSummary } from "./HistoryGraph.js";
import { loadShowAvatars, saveShowAvatars, useHistoryAvatars } from "./historyAvatars.js";
import { MenuSelect, type MenuOption } from "../MenuSelect.js";
import { useConfirm } from "../ConfirmDialog.js";
import { GitGlassToolbar, type ToolbarAction } from "./GitGlassToolbar.js";
import { GitGlassInputDialog, type InputDialogRequest } from "./GitGlassInputDialog.js";
import { actionStates } from "./toolbarActions.js";
import { GitGlassStatusBar } from "./GitGlassStatusBar.js";
import { DETAILS_DEFAULT_WIDTH, DETAILS_MAX_WIDTH, DETAILS_MIN_WIDTH, GitGlassDetails, type GitGlassSelection } from "./GitGlassDetails.js";
import { CommitDetails } from "./CommitDetails.js";
import { ChangesDetails } from "./ChangesDetails.js";
import { GitGlassSidebar, GitGlassSidebarStrip, useGitGlassSidebarData, type SectionFocus } from "./GitGlassSidebar.js";
import { PrDetails } from "./PrDetails.js";
import { SessionDetails } from "./SessionDetails.js";
import { WorktreeDetails } from "./WorktreeDetails.js";
import { sessionCheckout, sidebarPrOf, type SidebarSectionId } from "./sidebarModel.js";
import { NARROW_WIDTH } from "./gitGlassLayout.js";
import { isEmptyQuery, matchesQuery, parseHistoryQuery, type HistorySearchScope, type HistorySearchTarget } from "./historySearch.js";
import { usePersistedChoice, usePersistedWidth } from "./usePersistedState.js";
import { ResizeHandle } from "./ResizeHandle.js";

const PAGE_SIZE = 2000;
const MAX_LIMIT = 20000;
const NO_COMMITS: HistoryCommit[] = [];
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 250;
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

function refsBySha(log: HistoryLog | null): Map<string, HistorySearchTarget["refs"][number][]> {
  const refs = new Map<string, HistorySearchTarget["refs"][number][]>();
  for (const ref of log?.refs ?? []) {
    const entry = { name: ref.name, kind: ref.kind };
    const list = refs.get(ref.target);
    if (list) list.push(entry);
    else refs.set(ref.target, [entry]);
  }
  return refs;
}

function openSession(sessionId: string): void {
  usePrStore.getState().openSessionView();
  useAppStore.getState().selectSession(sessionId);
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
  const [inputDialog, setInputDialog] = useState<InputDialogRequest | null>(null);
  const [homePath, setHomePath] = useState<string | null>(null);
  const busy = useRef<string | null>(null);
  const [sidebarSetting, setSidebarSetting] = usePersistedChoice("cw-code:git-glass-sidebar", TOGGLES, "on");
  const [sidebarOverlay, setSidebarOverlay] = useState(false);
  const [sectionFocus, setSectionFocus] = useState<SectionFocus | null>(null);
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

  const pick = useCallback(
    (next: GitGlassSelection): void => {
      if (next.kind === "changes") {
        openWorktree(null);
        selectChanges(next.mode);
      } else {
        setSelection(next);
        setOpenPath(null);
      }
      if (narrow) setSidebarOverlay(false);
    },
    [openWorktree, selectChanges, narrow]
  );

  const selectPr = useCallback((ref: PrRef): void => pick({ kind: "pr", ref }), [pick]);

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

  const runAction = useCallback((label: string, task: () => Promise<unknown>, report = true): Promise<string | null> => {
    if (busy.current) {
      const message = `Wait for “${busy.current}” to finish before starting another action`;
      if (report) setActionError(message);
      return Promise.resolve(message);
    }
    busy.current = label.replace(/…$/, "");
    setAction(label);
    setActionError("");
    return task()
      .then(
        () => null,
        (reason: Error) => {
          if (report) setActionError(reason.message);
          return reason.message;
        }
      )
      .finally(() => {
        busy.current = null;
        setAction(null);
      });
  }, []);

  const checkedPath = viewWorktree ?? ("projectId" in scope ? homePath : null);
  const ownedCheckout = checkedPath === null ? undefined : log?.worktrees.find((worktree) => worktree.path === checkedPath && worktree.sessionId);

  const checkout = useCallback(
    (branch: string): void => {
      const elsewhere = worktreeBranches.get(branch);
      if (elsewhere) {
        openWorktree(elsewhere.path);
        return;
      }
      const owned = ownedCheckout;
      const run = (): void => void runAction(`Checking out ${branch}…`, () => window.cw.checkoutHistory(scope, viewWorktree, branch));
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
    [runAction, scope, viewWorktree, worktreeBranches, openWorktree, ownedCheckout, confirm]
  );

  const query = useMemo(() => parseHistoryQuery(searchText, searchScope), [searchText, searchScope]);
  const searchMatches = useMemo<string[] | null>(() => {
    if (!log || isEmptyQuery(query)) return null;
    const refs = refsBySha(log);
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
    searchMatches === null ? null : searchMatches.length === 0 ? "No results" : `${matchPosition === -1 ? "–" : matchPosition + 1} of ${searchMatches.length}`;

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

  const sidebarOpen = narrow ? sidebarOverlay : sidebarSetting === "on";
  const toggleSidebar = (): void => {
    if (narrow) setSidebarOverlay((value) => !value);
    else setSidebarSetting(sidebarSetting === "on" ? "off" : "on");
  };
  const openSection = (id: SidebarSectionId): void => {
    if (narrow) setSidebarOverlay(true);
    else setSidebarSetting("on");
    setSectionFocus((current) => ({ id, nonce: (current?.nonce ?? 0) + 1 }));
  };
  const sidebarData = useGitGlassSidebarData({ scope, sessionId, log, homePath, active: narrow || sidebarOpen });
  useEffect(() => {
    if (!sidebarOpen) setSectionFocus(null);
  }, [sidebarOpen]);
  const linkedKeys = useMemo(
    () => new Set((sidebarData.thisRow?.session.prs ?? []).map((link) => prKey(link.ref))),
    [sidebarData.thisRow]
  );
  const currentSidebarWidth = sidebarWidth.width ?? SIDEBAR_DEFAULT_WIDTH;

  const dirtyCount = viewWorktree === null && sessionId ? (status?.available ? status.dirtyCount : null) : (log?.wipCount ?? null);
  const latestStash = sidebarData.model.stashes[0] ?? null;
  const branchTarget = selectedSha ? { sha: selectedSha, selected: true } : head?.sha ? { sha: head.sha, selected: false } : null;
  const states = actionStates({
    head,
    currentRef: currentRef ?? null,
    dirtyCount,
    stash: latestStash ? { name: latestStash.ref.name, subject: latestStash.subject } : null,
    branchTarget,
    busy: action === null ? null : action.replace(/…$/, "")
  });
  const checkoutName = viewed ? `the worktree ${viewed.name}` : sessionId ? "this session's checkout" : "the project's checkout";

  const fetchRemote = (): void => void runAction("Fetching…", () => window.cw.fetchHistory(scope, viewWorktree));
  const pull = (): void => void runAction("Pulling…", () => window.cw.pullHistory(scope, viewWorktree));
  const push = (): void => {
    const publishing = !currentRef?.upstream || currentRef.upstreamGone;
    void runAction(publishing ? "Publishing…" : "Pushing…", () => window.cw.pushHistory(scope, viewWorktree));
  };

  const openBranchDialog = (): void => {
    if (!branchTarget) return;
    const { sha, selected } = branchTarget;
    const subject = log?.commits.find((candidate) => candidate.sha === sha)?.subject;
    setInputDialog({
      title: "Create a branch",
      label: "Branch name",
      placeholder: "feature/my-change",
      required: "Enter a branch name",
      note: (
        <>
          At {selected ? "the selected commit" : "HEAD"} <code>{sha.slice(0, 7)}</code>
          {subject ? ` · ${subject}` : ""}, in {checkoutName}.
          {ownedCheckout ? " A cw-code session works in this checkout — checking out changes its branch too." : ""}
        </>
      ),
      checkbox: { label: "Check out after creating", initial: true },
      confirmLabel: "Create branch",
      busyLabel: "Creating…",
      submit: (name, checkoutAfter) =>
        runAction(`Creating ${name}…`, () => window.cw.createHistoryBranch(scope, viewWorktree, { name, sha, checkout: checkoutAfter }), false)
    });
  };

  const openStashDialog = (): void => {
    setInputDialog({
      title: "Stash changes",
      label: "Message (optional)",
      placeholder: head?.branch ? `WIP on ${head.branch}` : "WIP",
      note: `Saves the uncommitted changes in ${checkoutName}, including untracked files, and cleans its working tree.`,
      confirmLabel: "Stash",
      busyLabel: "Stashing…",
      submit: (message) => runAction("Stashing…", () => window.cw.stashHistory(scope, viewWorktree, message || undefined), false)
    });
  };

  const popStash = (): void => {
    if (!latestStash) return;
    const { name } = latestStash.ref;
    void confirm({
      title: latestStash.subject ? `Pop ${name}: ${latestStash.subject}?` : `Pop ${name}?`,
      message: `Applies the stash to ${checkoutName} and drops it. If it conflicts, the stash is kept.`,
      confirmLabel: "Pop"
    }).then((ok) => {
      if (ok) void runAction(`Popping ${name}…`, () => window.cw.popStashHistory(scope, viewWorktree));
    });
  };

  const fromState = (id: keyof typeof states, label: string, icon: ToolbarAction["icon"], onClick: () => void, badgeHint?: string): ToolbarAction => ({
    id,
    label,
    icon,
    title: states[id].title,
    disabled: states[id].disabled,
    badge: states[id].badge,
    badgeHint,
    onClick
  });

  const groups: ToolbarAction[][] = [
    [
      fromState("fetch", "Fetch", <CloudDownload size={ACTION_ICON} aria-hidden="true" />, fetchRemote),
      {
        ...fromState("pull", "Pull", <ArrowDownToLine size={ACTION_ICON} aria-hidden="true" />, pull, "behind"),
        menu: [
          { id: "pull", label: "Pull (fast-forward only)", title: states.pull.title, disabled: states.pull.disabled, onSelect: pull },
          { id: "fetch", label: "Fetch", title: states.fetch.title, disabled: states.fetch.disabled, onSelect: fetchRemote }
        ]
      },
      fromState("push", "Push", <ArrowUpFromLine size={ACTION_ICON} aria-hidden="true" />, push, "ahead")
    ],
    [
      fromState("branch", "Branch", <GitBranchPlus size={ACTION_ICON} aria-hidden="true" />, openBranchDialog),
      fromState("stash", "Stash", <PackagePlus size={ACTION_ICON} aria-hidden="true" />, openStashDialog),
      fromState("pop", "Pop", <ArchiveRestore size={ACTION_ICON} aria-hidden="true" />, popStash)
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

  const diffOpen = openPath !== null && (selectedSha !== null || changesMode !== null);
  const showDetails = !narrow || (selection !== null && !diffOpen);

  return (
    <div ref={panelRef} className={`git-glass${narrow ? " narrow" : ""}`} onKeyDown={onPanelKeyDown}>
      {dialog}
      {inputDialog && <GitGlassInputDialog request={inputDialog} onClose={() => setInputDialog(null)} />}
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
          <GitGlassSidebarStrip data={sidebarData} sessionScope={sessionId !== null} overlay={sidebarOverlay} onToggle={toggleSidebar} onSection={openSection} />
        )}
        {sidebarOpen && (
          <aside className={`gg-sidebar${narrow ? " overlay" : ""}`} style={{ width: currentSidebarWidth }} aria-label="Repository">
            <GitGlassSidebar
              data={sidebarData}
              sessionId={sessionId}
              log={log}
              logFailure={failure}
              status={status}
              sessionBranch={sessionBranch}
              activePath={activePath}
              selection={selection}
              worktreeBranches={worktreeBranches}
              busy={action !== null}
              focus={sectionFocus}
              onSelect={pick}
              onCheckout={checkout}
              onOpenSession={openSession}
            />
            <ResizeHandle
              className="gg-resize gg-resize-right"
              label="Resize the sidebar"
              value={currentSidebarWidth}
              min={SIDEBAR_MIN_WIDTH}
              max={SIDEBAR_MAX_WIDTH}
              direction={1}
              onChange={(width, commit) => (commit ? sidebarWidth.save(width) : sidebarWidth.preview(width))}
              onReset={() => sidebarWidth.save(null)}
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
            renderPr={(ref) => (
              <PrDetails pr={sidebarData.model.prs.find((pr) => pr.key === prKey(ref)) ?? sidebarPrOf(ref)} sessionId={sessionId} onOpenSession={openSession} />
            )}
            renderSession={(id) => {
              const row = sidebarData.rows.find((candidate) => candidate.session.id === id);
              const owned = row ? sessionCheckout(worktrees, row.session) : null;
              return (
                <SessionDetails
                  row={row}
                  isThis={id === sessionId}
                  worktree={owned}
                  viewing={owned !== null && owned.path === activePath}
                  onOpenSession={openSession}
                  onShowHistory={openWorktree}
                  onSelectPr={selectPr}
                />
              );
            }}
            renderWorktree={(path) => {
              const entry = sidebarData.model.worktrees.find((candidate) => candidate.worktree.path === path);
              const branchName = entry?.worktree.branch ?? null;
              return (
                <WorktreeDetails
                  scope={scope}
                  entry={entry}
                  sessionId={sessionId}
                  branchRef={branchName ? log?.refs.find((ref) => ref.kind === "local" && ref.name === branchName) : undefined}
                  viewing={path === activePath}
                  linkedKeys={linkedKeys}
                  onShowHistory={openWorktree}
                  onOpenSession={openSession}
                />
              );
            }}
          />
        )}
      </div>
      <GitGlassStatusBar
        branch={branch}
        upstream={currentRef?.upstream ? { name: currentRef.upstream, ahead: currentRef.ahead, behind: currentRef.behind, gone: currentRef.upstreamGone } : null}
        fetchedAt={topic?.data.fetchedAt ?? null}
        busy={action !== null}
        onFetch={fetchRemote}
        sessions={{
          total: sidebarData.model.sessions.length,
          running: sidebarData.model.sessions.filter((row) => row.busy).length,
          onOpen: () => openSection("sessions")
        }}
        commits={log ? log.commits.length : null}
        truncated={log?.truncated ?? false}
        path={activePath}
        onOpenPath={openActivePath}
      />
    </div>
  );
}
