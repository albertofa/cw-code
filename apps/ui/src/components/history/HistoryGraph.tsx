import { memo, useMemo, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Check, Cloud, Monitor, Tag } from "lucide-react";
import type { HistoryCommit, HistoryLog } from "@cw-code/contracts";
import { computeGraphLayout } from "../../history/graphLayout.js";
import { relativeTime } from "../prDetailModel.js";
import { GraphCanvas, graphColumnWidth, REF_COLUMN_WIDTH, ROW_HEIGHT, type NodeKind } from "./GraphCanvas.js";
import { initialsOf, type NodeAvatar } from "./historyAvatars.js";
import { PALETTE_SIZE, paletteVar, useGraphTheme } from "./graphTheme.js";
import { buildRefLabel, type RefLabel } from "./refLabel.js";
import { useVirtualRows } from "./useVirtualRows.js";

export const WIP_SHA = "WIP";
const OVERSCAN = 10;
const HEADER_HEIGHT = 24;

function nodeKind(commit: HistoryCommit): NodeKind {
  if (commit.sha === WIP_SHA) return "wip";
  if (commit.isStash) return "stash";
  return commit.parents.length >= 2 ? "merge" : "commit";
}

function withWip(log: HistoryLog, dirtyCount: number): HistoryCommit[] {
  const headSha = log.head.sha;
  if (dirtyCount <= 0 || !headSha) return log.commits;
  const now = Math.floor(Date.now() / 1000);
  const wip: HistoryCommit = {
    sha: WIP_SHA,
    parents: [headSha],
    authorName: "",
    authorEmail: "",
    authorDate: now,
    committerDate: now,
    subject: `Uncommitted changes (${dirtyCount})`,
    isStash: false
  };
  return [wip, ...log.commits];
}

function labelsBySha(log: HistoryLog, present: Set<string>): Map<string, RefLabel> {
  const grouped = new Map<string, HistoryLog["refs"]>();
  for (const ref of log.refs) {
    if (!present.has(ref.target)) continue;
    const list = grouped.get(ref.target);
    if (list) list.push(ref);
    else grouped.set(ref.target, [ref]);
  }
  const detachedSha = log.head.detached && log.head.sha && present.has(log.head.sha) ? log.head.sha : null;
  if (detachedSha && !grouped.has(detachedSha)) grouped.set(detachedSha, []);
  const result = new Map<string, RefLabel>();
  for (const [sha, refs] of grouped) {
    const label = buildRefLabel(refs, sha === detachedSha);
    if (label) result.set(sha, label);
  }
  return result;
}

function RefLabelCell({ label }: { label: RefLabel }) {
  return (
    <>
      <span className={`history-ref ${label.kind}${label.isCurrent ? " current" : ""}`} title={label.title}>
        {label.isCurrent && label.kind !== "head" && <Check size={11} className="history-ref-icon" />}
        {label.kind === "tag" && <Tag size={11} className="history-ref-icon" />}
        {label.hasLocal && <Monitor size={11} className="history-ref-icon" />}
        {label.hasRemote && <Cloud size={11} className="history-ref-icon" />}
        <span className="history-ref-text">{label.label}</span>
        {label.extra > 0 && <span className="history-ref-extra">+{label.extra}</span>}
      </span>
      <span className="history-ref-link" aria-hidden="true" />
    </>
  );
}

const absoluteFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const HistoryRow = memo(function HistoryRow({
  commit,
  label,
  colorIndex,
  graphWidth,
  nowMs,
  selected,
  onSelect
}: {
  commit: HistoryCommit;
  label: RefLabel | null;
  colorIndex: number;
  graphWidth: number;
  nowMs: number;
  selected: boolean;
  onSelect: (sha: string) => void;
}) {
  const isWip = commit.sha === WIP_SHA;
  const title = isWip
    ? commit.subject
    : `${commit.subject}\n${commit.authorName} <${commit.authorEmail}>\n${absoluteFormat.format(new Date(commit.authorDate * 1000))}\n${commit.sha}`;
  return (
    <div
      className={`history-row${selected ? " selected" : ""}${isWip ? " wip" : ""}${commit.isStash ? " stash" : ""}`}
      style={{ height: ROW_HEIGHT, "--lane": paletteVar(colorIndex) } as CSSProperties}
      role="option"
      aria-selected={selected}
      title={title}
      onClick={() => onSelect(commit.sha)}
    >
      <span className="history-ref-cell" style={{ width: REF_COLUMN_WIDTH }}>
        {label && <RefLabelCell label={label} />}
      </span>
      <span className="history-graph-cell" style={{ width: graphWidth }} />
      <span className="history-subject">{commit.subject}</span>
      {!isWip && <span className="history-author">{commit.authorName}</span>}
      {!isWip && <span className="history-date">{relativeTime(commit.authorDate * 1000, nowMs)}</span>}
    </div>
  );
});

export function HistoryGraph({
  log,
  dirtyCount,
  selected,
  onSelect,
  onLoadMore,
  loadingMore,
  avatars,
  showAvatars
}: {
  log: HistoryLog;
  dirtyCount: number;
  selected: string | null;
  onSelect: (sha: string) => void;
  onLoadMore: (() => void) | null;
  loadingMore: boolean;
  avatars: Record<string, string | null>;
  showAvatars: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useGraphTheme();
  const commits = useMemo(() => withWip(log, dirtyCount), [log, dirtyCount]);
  const nowMs = useMemo(() => Date.now(), [commits]);
  const layout = useMemo(() => computeGraphLayout(commits, PALETTE_SIZE), [commits]);
  const kinds = useMemo(() => commits.map(nodeKind), [commits]);
  const labels = useMemo(() => labelsBySha(log, new Set(commits.map((commit) => commit.sha))), [log, commits]);
  const labeled = useMemo(() => commits.map((commit) => labels.has(commit.sha)), [commits, labels]);
  const nodeAvatars = useMemo<(NodeAvatar | null)[] | null>(() => {
    if (!showAvatars) return null;
    return commits.map((commit, index) => {
      if (kinds[index] !== "commit" || commit.authorEmail === "") return null;
      const email = commit.authorEmail.toLowerCase();
      return { email, initials: initialsOf(commit.authorName, email), url: avatars[email] ?? null };
    });
  }, [commits, kinds, avatars, showAvatars]);
  const headIndex = useMemo(() => (log.head.sha ? commits.findIndex((commit) => commit.sha === log.head.sha) : -1), [commits, log.head.sha]);
  const graphWidth = graphColumnWidth(layout.laneCount);
  const { start, end, scrollToIndex } = useVirtualRows(containerRef, commits.length, ROW_HEIGHT, OVERSCAN, HEADER_HEIGHT);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (commits.length === 0) return;
    const current = selected ? commits.findIndex((commit) => commit.sha === selected) : -1;
    const next = current === -1 ? 0 : Math.min(commits.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
    const target = commits[next];
    if (!target) return;
    onSelect(target.sha);
    scrollToIndex(next);
  };

  return (
    <div ref={containerRef} className="history-scroll" tabIndex={0} role="listbox" aria-label="Commits" onKeyDown={onKeyDown}>
      <div className="history-header" style={{ height: HEADER_HEIGHT }}>
        <span className="history-header-ref" style={{ width: REF_COLUMN_WIDTH }}>
          Branch / tag
        </span>
        <span style={{ width: graphWidth }}>Graph</span>
        <span>Commit message</span>
      </div>
      <div className="history-spacer" style={{ height: commits.length * ROW_HEIGHT }}>
        <GraphCanvas rows={layout.rows} kinds={kinds} avatars={nodeAvatars} labeled={labeled} headIndex={headIndex} start={start} end={end} laneCount={layout.laneCount} theme={theme} />
        <div className="history-window" style={{ top: start * ROW_HEIGHT }}>
          {commits.slice(start, end).map((commit, offset) => (
            <HistoryRow
              key={commit.sha}
              commit={commit}
              label={labels.get(commit.sha) ?? null}
              colorIndex={layout.rows[start + offset]?.color ?? 0}
              graphWidth={graphWidth}
              nowMs={nowMs}
              selected={commit.sha === selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
      {log.truncated && onLoadMore && (
        <div className="history-more">
          <button type="button" className="inspect-mode" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : `Load more (showing ${log.commits.length})`}
          </button>
        </div>
      )}
    </div>
  );
}
