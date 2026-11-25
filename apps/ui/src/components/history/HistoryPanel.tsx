import { useEffect, useState } from "react";
import { GitGraph, UserRound } from "lucide-react";
import type { HistoryCommit, HistoryLog, HistoryTopicData } from "@cw-code/contracts";
import { historyTopic } from "@cw-code/shared/topics";
import { usePanelStore } from "../../stores/panelStore.js";
import { useConnectionEpoch, useTopic } from "../../server/topics.js";
import { useGitStatus } from "../useGit.js";
import { HistoryCommitView } from "./HistoryCommitView.js";
import { HistoryGraph, WIP_SHA } from "./HistoryGraph.js";
import { loadShowAvatars, saveShowAvatars, useHistoryAvatars } from "./historyAvatars.js";

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
  };

  const toggleAvatars = (): void => {
    const next = !showAvatars;
    setShowAvatars(next);
    saveShowAvatars(next);
  };

  const branch = topic?.data.head?.branch ?? (topic?.data.head?.sha ? `detached at ${topic.data.head.sha.slice(0, 7)}` : null);
  const failure = topicError ?? (error || null);

  return (
    <div className="inspect history">
      <div className="inspect-toolbar">
        <span className="inspect-title">
          <GitGraph size={14} /> History
        </span>
        {branch && <span className="inspect-head-ref">{branch}</span>}
        {loading && log && <span className="inspect-refreshing">Refreshing…</span>}
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
      {!failure && !log && <div className="diff-empty">Loading history…</div>}
      {!failure && log && log.commits.length === 0 && (
        <div className="inspect-empty">
          <GitGraph size={24} />
          <span>No commits yet</span>
        </div>
      )}
      {log && log.commits.length > 0 && (
        <div className={`history-split${selected ? " with-detail" : ""}`}>
          <HistoryGraph
            log={log}
            dirtyCount={status?.available ? status.dirtyCount : 0}
            selected={selected}
            onSelect={select}
            onLoadMore={limit < MAX_LIMIT ? () => setLimit((current) => Math.min(MAX_LIMIT, current + PAGE_SIZE)) : null}
            loadingMore={loading}
            avatars={avatars}
            showAvatars={showAvatars}
          />
          {selected && <HistoryCommitView key={selected} sessionId={sessionId} sha={selected} onSelect={select} />}
        </div>
      )}
    </div>
  );
}
