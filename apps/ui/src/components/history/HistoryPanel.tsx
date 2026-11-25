import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, GitFork, GitGraph, UserRound } from "lucide-react";
import type { HistoryCommit, HistoryLog, HistoryTopicData, HistoryWorktree } from "@cw-code/contracts";
import { historyTopic } from "@cw-code/shared/topics";
import { usePanelStore } from "../../stores/panelStore.js";
import { useConnectionEpoch, useTopic } from "../../server/topics.js";
import { useGitStatus } from "../useGit.js";
import { HistoryCommitSidebar, HistoryFileDiff, useHistoryCommit } from "./HistoryCommitView.js";
import { HistoryGraph, WIP_SHA } from "./HistoryGraph.js";
import { loadShowAvatars, saveShowAvatars, useHistoryAvatars } from "./historyAvatars.js";
import { MenuSelect, type MenuOption } from "../MenuSelect.js";
import { useHistorySide } from "./useHistorySide.js";
import { useConfirm } from "../ConfirmDialog.js";

const PAGE_SIZE = 2000;
const MAX_LIMIT = 20000;
const NO_COMMITS: HistoryCommit[] = [];
const isWip = (commit: HistoryCommit): boolean => commit.sha === WIP_SHA;

export function HistoryPanel({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<{ path: string; key: string } | null>(null);
  const viewWorktree = view?.path ?? null;
  const topicName = historyTopic(sessionId, view?.key ?? null);
  const topic = useTopic<HistoryTopicData>(topicName);
  const status = useGitStatus(sessionId);
  const epoch = useConnectionEpoch();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [log, setLog] = useState<HistoryLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const commit = useHistoryCommit(sessionId, selected);
  const side = useHistorySide();
  const { confirm, dialog } = useConfirm();
  const panelRef = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [homePath, setHomePath] = useState<string | null>(null);
  const busy = useRef<string | null>(null);
  const worktreeBranches = useMemo<ReadonlyMap<string, HistoryWorktree>>(() => {
    const byBranch = new Map<string, HistoryWorktree>();
    for (const worktree of log?.worktrees ?? []) {
      if (!worktree.isCurrent && worktree.branch) byBranch.set(worktree.branch, worktree);
    }
    return byBranch;
  }, [log]);
  const [showAvatars, setShowAvatars] = useState(loadShowAvatars);
  const avatars = useHistoryAvatars(sessionId, log?.commits ?? NO_COMMITS, isWip, showAvatars, topic?.data.avatarsRev ?? 0);
  const rev = topic?.data.rev ?? 0;
  const topicError = topic?.status === "error" ? (topic.error ?? "History unavailable") : (topic?.data.error ?? null);

  useEffect(() => {
    if (rev === 0) return;
    let active = true;
    setLoading(true);
    window.cw.getHistoryLog(sessionId, limit, viewWorktree).then(
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

  const openWorktree = useCallback(
    (path: string | null): void => {
      const target = path === null || path === homePath ? null : (log?.worktrees.find((worktree) => worktree.path === path) ?? null);
      const next = target === null ? null : { path: target.path, key: target.key };
      if ((next?.key ?? null) === (view?.key ?? null)) return;
      setView(next);
      setLog(null);
      setError("");
      setSelected(null);
      setOpenPath(null);
      setActionError("");
    },
    [homePath, log, view]
  );

  const select = useCallback(
    (sha: string): void => {
      if (sha === WIP_SHA) {
        if (viewWorktree === null) usePanelStore.getState().requestDiffMode(sessionId, "working");
        return;
      }
      setSelected(sha);
      setOpenPath(null);
    },
    [sessionId, viewWorktree]
  );

  const highlight = useCallback((sha: string): void => {
    if (sha === WIP_SHA) return;
    setSelected(sha);
    setOpenPath(null);
  }, []);

  const closeDiff = useCallback((): void => {
    setOpenPath(null);
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".history-scroll")?.focus({ preventScroll: true }));
  }, []);

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
      const owned = viewWorktree === null ? undefined : log?.worktrees.find((worktree) => worktree.path === viewWorktree && worktree.sessionId);
      const run = (): void => runAction(`Checking out ${branch}…`, () => window.cw.checkoutHistory(sessionId, viewWorktree, branch));
      if (!owned) {
        run();
        return;
      }
      void confirm({
        title: `Switch ${owned.name} to ${branch}?`,
        message: "Another cw-code session works in this worktree. Its branch changes too.",
        confirmLabel: "Switch branch"
      }).then((ok) => {
        if (ok) run();
      });
    },
    [runAction, sessionId, viewWorktree, worktreeBranches, openWorktree, log, confirm]
  );

  const head = log?.head ?? null;
  const currentRef = head?.branch ? log?.refs.find((ref) => ref.kind === "local" && ref.isCurrent) : undefined;
  const pullBlocked = !head?.branch ? "HEAD is detached — check out a branch to pull" : !currentRef?.upstream ? `${head.branch} has no upstream branch` : null;
  const pullTitle = pullBlocked ?? `Fast-forward ${head?.branch} from ${currentRef?.upstream} (git pull --ff-only)`;
  const pull = (): void => runAction("Pulling…", () => window.cw.pullHistory(sessionId, viewWorktree));

  const toggleAvatars = (): void => {
    const next = !showAvatars;
    setShowAvatars(next);
    saveShowAvatars(next);
  };

  const branch = head?.branch ?? (head?.sha ? `detached at ${head.sha.slice(0, 7)}` : null);
  const worktrees = log?.worktrees ?? [];
  const activePath = viewWorktree ?? homePath;
  const viewed = viewWorktree === null ? undefined : worktrees.find((worktree) => worktree.path === viewWorktree);
  const viewName = view === null ? "" : (view.path.split(/[\\/]/).filter(Boolean).pop() ?? view.path);
  const sessionBranch = worktrees.find((worktree) => worktree.path === homePath)?.branch ?? null;
  const worktreeOptions: MenuOption[] = worktrees.map((worktree) => {
    const home = worktree.path === homePath;
    const owner = worktree.sessionId && !home ? " · used by another cw-code session" : "";
    return {
      id: worktree.path,
      label: home ? "This session" : worktree.name,
      hint: worktree.branch ?? "detached",
      description: `${worktree.path}${owner}`,
      icon: <GitFork size={13} />
    };
  });
  const dirtyCount = viewWorktree === null ? (status?.available ? status.dirtyCount : 0) : (log?.wipCount ?? 0);
  const failure = topicError ?? (error || null);

  return (
    <div ref={panelRef} className="inspect history">
      {dialog}
      <div className="inspect-toolbar">
        <span className="inspect-title">
          <GitGraph size={14} /> History
        </span>
        {worktrees.length > 1 && activePath && (
          <MenuSelect
            label="Switch worktree"
            title="Switch worktree — each one has its own branch and changes"
            direction="down"
            value={activePath}
            display={viewed ? viewed.name : "This session"}
            icon={<GitFork size={13} aria-hidden="true" />}
            options={worktreeOptions}
            onPick={openWorktree}
            searchable
            searchPlaceholder="Filter worktrees…"
          />
        )}
        {branch && (
          <span className="inspect-head-ref" title={viewed ? viewed.path : undefined}>
            {viewed ? `${viewed.name} · ${branch}` : branch}
          </span>
        )}
        {loading && log && <span className="inspect-refreshing">Refreshing…</span>}
        {action && <span className="inspect-refreshing">{action}</span>}
        <button
          type="button"
          className="inspect-mode history-pull"
          disabled={pullBlocked !== null || action !== null}
          title={pullTitle}
          onClick={pull}
        >
          <ArrowDownToLine size={13} /> Pull
          {currentRef && currentRef.behind > 0 && <span className="history-pull-count">{currentRef.behind}</span>}
        </button>
        <button
          type="button"
          className={`inspect-mode history-avatars-toggle${showAvatars ? " active" : ""}`}
          aria-pressed={showAvatars}
          title="Show author photos from GitHub on commits"
          onClick={toggleAvatars}
        >
          <UserRound size={13} /> Photos
        </button>
      </div>
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
                <span className="history-worktree-name">{home ? "This session" : worktree.name}</span>
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
              {viewed.branch ? <> on <b>{viewed.branch}</b></> : null}, not your session's checkout
              {sessionBranch ? <> (<b>{sessionBranch}</b>)</> : null}. Switching branches and pulling here do not change your session.
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
            Back to this session
          </button>
        </div>
      )}
      {failure && <div className="inspect-error">History unavailable: {failure}</div>}
      {actionError && (
        <div className="inspect-error history-action-error" role="alert" onClick={() => setActionError("")} title="Click to dismiss">
          {actionError}
        </div>
      )}
      {!failure && !log && <div className="diff-empty">Loading history…</div>}
      {!failure && log && log.commits.length === 0 && (
        <div className="inspect-empty">
          <GitGraph size={24} />
          <span>No commits yet</span>
        </div>
      )}
      {log && log.commits.length > 0 && (
        <div className="history-split">
          <div className="history-main">
            <HistoryGraph
              log={log}
              dirtyCount={dirtyCount}
              selected={selected}
              onSelect={select}
              onHighlight={highlight}
              onLoadMore={limit < MAX_LIMIT ? () => setLimit((current) => Math.min(MAX_LIMIT, current + PAGE_SIZE)) : null}
              loadingMore={loading}
              avatars={avatars}
              showAvatars={showAvatars}
              onCheckout={checkout}
              worktreeBranches={worktreeBranches}
            />
            {selected && openPath && <HistoryFileDiff files={commit.files} path={openPath} onOpenFile={setOpenPath} onClose={closeDiff} />}
          </div>
          {selected && (
            <>
              <div
                className="history-side-handle"
                role="separator"
                aria-orientation="horizontal"
                title="Drag to resize (double-click resets)"
                onPointerDown={side.startDrag}
                onDoubleClick={side.reset}
              />
              <aside className="history-side" style={{ height: side.height }} aria-label="Commit detail">
                <HistoryCommitSidebar commit={commit} openPath={openPath} onOpenFile={setOpenPath} onSelect={select} />
              </aside>
            </>
          )}
        </div>
      )}
    </div>
  );
}
