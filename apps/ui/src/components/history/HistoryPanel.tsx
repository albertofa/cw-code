import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, GitGraph, UserRound } from "lucide-react";
import type { HistoryCommit, HistoryLog, HistoryTopicData } from "@cw-code/contracts";
import { historyTopic } from "@cw-code/shared/topics";
import { usePanelStore } from "../../stores/panelStore.js";
import { useConnectionEpoch, useTopic } from "../../server/topics.js";
import { useGitStatus } from "../useGit.js";
import { HistoryCommitSidebar, HistoryFileDiff, useHistoryCommit } from "./HistoryCommitView.js";
import { HistoryGraph, WIP_SHA } from "./HistoryGraph.js";
import { loadShowAvatars, saveShowAvatars, useHistoryAvatars } from "./historyAvatars.js";
import { useHistorySide } from "./useHistorySide.js";

const PAGE_SIZE = 2000;
const MAX_LIMIT = 20000;
const NO_COMMITS: HistoryCommit[] = [];
const isWip = (commit: HistoryCommit): boolean => commit.sha === WIP_SHA;

export function HistoryPanel({ sessionId }: { sessionId: string }) {
  const topic = useTopic<HistoryTopicData>(historyTopic(sessionId));
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
  const panelRef = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [showAvatars, setShowAvatars] = useState(loadShowAvatars);
  const avatars = useHistoryAvatars(sessionId, log?.commits ?? NO_COMMITS, isWip, showAvatars);
  const rev = topic?.data.rev ?? 0;
  const topicError = topic?.status === "error" ? (topic.error ?? "History unavailable") : (topic?.data.error ?? null);

  useEffect(() => {
    if (rev === 0) return;
    let active = true;
    setLoading(true);
    window.cw.getHistoryLog(sessionId, limit).then(
      (next) => {
        if (!active) return;
        setLog(next);
        setError("");
      },
      (reason: Error) => {
        if (active) setError(reason.message);
      }
    ).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [sessionId, rev, limit, epoch]);

  const select = (sha: string): void => {
    if (sha === WIP_SHA) {
      usePanelStore.getState().requestDiffMode(sessionId, "working");
      return;
    }
    setSelected(sha);
    setOpenPath(null);
  };

  const highlight = (sha: string): void => {
    if (sha === WIP_SHA) return;
    setSelected(sha);
    setOpenPath(null);
  };

  const closeDiff = useCallback((): void => {
    setOpenPath(null);
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".history-scroll")?.focus({ preventScroll: true }));
  }, []);

  const runAction = useCallback((label: string, task: () => Promise<unknown>): void => {
    setAction(label);
    setActionError("");
    task().catch((reason: Error) => setActionError(reason.message)).finally(() => setAction(null));
  }, []);

  const checkout = useCallback(
    (branch: string): void => runAction(`Checking out ${branch}…`, () => window.cw.switchGitBranch(sessionId, branch)),
    [runAction, sessionId]
  );

  const head = topic?.data.head ?? null;
  const currentRef = head?.branch ? topic?.data.refs.find((ref) => ref.kind === "local" && ref.isCurrent) : undefined;
  const pullBlocked = !head?.branch ? "HEAD is detached — check out a branch to pull" : !currentRef?.upstream ? `${head.branch} has no upstream branch` : null;
  const pullTitle = pullBlocked ?? `Fast-forward ${head?.branch} from ${currentRef?.upstream} (git pull --ff-only)`;
  const pull = (): void => runAction("Pulling…", () => window.cw.pullHistory(sessionId));

  const toggleAvatars = (): void => {
    const next = !showAvatars;
    setShowAvatars(next);
    saveShowAvatars(next);
  };

  const branch = topic?.data.head?.branch ?? (topic?.data.head?.sha ? `detached at ${topic.data.head.sha.slice(0, 7)}` : null);
  const failure = topicError ?? (error || null);

  return (
    <div ref={panelRef} className="inspect history">
      <div className="inspect-toolbar">
        <span className="inspect-title">
          <GitGraph size={14} /> History
        </span>
        {branch && <span className="inspect-head-ref">{branch}</span>}
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
              dirtyCount={status?.available ? status.dirtyCount : 0}
              selected={selected}
              onSelect={select}
              onHighlight={highlight}
              onLoadMore={limit < MAX_LIMIT ? () => setLimit((current) => Math.min(MAX_LIMIT, current + PAGE_SIZE)) : null}
              loadingMore={loading}
              avatars={avatars}
              showAvatars={showAvatars}
              onCheckout={checkout}
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
