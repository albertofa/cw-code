import { memo, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { Check, Cloud, Monitor, Tag } from "lucide-react";
import type { HistoryCommit, HistoryLog } from "@cw-code/contracts";
import { computeGraphLayout } from "../../history/graphLayout.js";
import { relativeTime } from "../prDetailModel.js";
import { GraphCanvas, graphColumnWidth, REF_COLUMN_WIDTH, ROW_HEIGHT, type NodeKind } from "./GraphCanvas.js";
import { initialsOf, type NodeAvatar } from "./historyAvatars.js";
import { PALETTE_SIZE, paletteVar, useGraphTheme } from "./graphTheme.js";
import { buildRefLabel, type RefEntry, type RefLabel } from "./refLabel.js";
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
  const localBranches = {
    names: new Set(log.refs.filter((ref) => ref.kind === "local").map((ref) => ref.name)),
    current: log.head.detached ? null : log.head.branch
  };
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
    const label = buildRefLabel(refs, sha === detachedSha, localBranches);
    if (label) result.set(sha, label);
  }
  return result;
}

function RefIcons({ kind, isCurrent, hasLocal, hasRemote }: { kind: RefLabel["kind"]; isCurrent: boolean; hasLocal: boolean; hasRemote: boolean }) {
  return (
    <>
      {isCurrent && kind !== "head" && <Check size={11} className="history-ref-icon" />}
      {kind === "tag" && <Tag size={11} className="history-ref-icon" />}
      {hasLocal && <Monitor size={11} className="history-ref-icon" />}
      {hasRemote && <Cloud size={11} className="history-ref-icon" />}
    </>
  );
}

function entryTitle(entry: RefEntry, worktreeBranches: ReadonlyMap<string, string>): string {
  const elsewhere = entry.checkout === null ? undefined : worktreeBranches.get(entry.checkout);
  if (elsewhere) return `${entry.name} — checked out in another worktree at ${elsewhere}; it can't be checked out here`;
  if (entry.isCurrent) return `${entry.name} — current branch`;
  if (entry.checkout === null && entry.localElsewhere) return `${entry.name} — its local branch is the current one; Pull updates it`;
  if (entry.checkout === null) return entry.kind === "tag" ? `Tag ${entry.name}` : entry.name;
  if (entry.localElsewhere) return `${entry.name} — double-click to check out the local ${entry.checkout}, which is on another commit; Pull updates it (git switch ${entry.checkout})`;
  const command = entry.kind === "remote" ? `git switch --track ${entry.checkout}` : `git switch ${entry.checkout}`;
  return `${entry.name} — double-click to check out (${command})`;
}

function RefLabelCell({ label, onCheckout, worktreeBranches }: { label: RefLabel; onCheckout: (branch: string) => void; worktreeBranches: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const stacked = label.extra > 0;
  const primary = label.entries[0];
  const checkout = (entry: RefEntry | undefined) => (event: MouseEvent) => {
    event.stopPropagation();
    if (entry?.checkout && !entry.isCurrent) onCheckout(entry.checkout);
  };
  return (
    <>
      <span
        className="history-ref-anchor"
        onMouseEnter={() => setOpen(stacked)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(stacked)}
        onBlur={() => setOpen(false)}
      >
        <span
          className={`history-ref ${label.kind}${label.isCurrent ? " current" : ""}`}
          title={stacked ? undefined : primary ? entryTitle(primary, worktreeBranches) : label.title}
          tabIndex={stacked ? 0 : -1}
          onDoubleClick={checkout(primary)}
        >
          <RefIcons kind={label.kind} isCurrent={label.isCurrent} hasLocal={label.hasLocal} hasRemote={label.hasRemote} />
          <span className="history-ref-text">{label.label}</span>
          {stacked && <span className="history-ref-extra">+{label.extra}</span>}
        </span>
        {open && (
          <span className="history-ref-stack" role="list">
            {label.entries.map((entry) => (
              <span
                key={entry.key}
                className={`history-ref-stack-row ${entry.kind}${entry.isCurrent ? " current" : ""}${entry.checkout !== null && worktreeBranches.has(entry.checkout) ? " elsewhere" : ""}`}
                role="listitem"
                title={entryTitle(entry, worktreeBranches)}
                onDoubleClick={checkout(entry)}
              >
                <RefIcons kind={entry.kind} isCurrent={entry.isCurrent} hasLocal={false} hasRemote={false} />
                <span className="history-ref-text">{entry.name}</span>
                {entry.hasLocal && <Monitor size={11} className="history-ref-icon" />}
                {entry.hasRemote && <Cloud size={11} className="history-ref-icon" />}
              </span>
            ))}
          </span>
        )}
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
  onSelect,
  onCheckout,
  worktreeBranches
}: {
  commit: HistoryCommit;
  label: RefLabel | null;
  colorIndex: number;
  graphWidth: number;
  nowMs: number;
  selected: boolean;
  onSelect: (sha: string) => void;
  onCheckout: (branch: string) => void;
  worktreeBranches: ReadonlyMap<string, string>;
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
        {label && <RefLabelCell label={label} onCheckout={onCheckout} worktreeBranches={worktreeBranches} />}
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
  showAvatars,
  onCheckout,
  onHighlight,
  worktreeBranches
}: {
  log: HistoryLog;
  dirtyCount: number;
  selected: string | null;
  onSelect: (sha: string) => void;
  onLoadMore: (() => void) | null;
  loadingMore: boolean;
  avatars: Record<string, string | null>;
  showAvatars: boolean;
  onCheckout: (branch: string) => void;
  onHighlight: (sha: string) => void;
  worktreeBranches: ReadonlyMap<string, string>;
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
    if (event.key === "Enter" && selected) {
      event.preventDefault();
      onSelect(selected);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (commits.length === 0) return;
    const current = selected ? commits.findIndex((commit) => commit.sha === selected) : -1;
    const next = current === -1 ? 0 : Math.min(commits.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
    const target = commits[next];
    if (!target) return;
    onHighlight(target.sha);
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
              onCheckout={onCheckout}
              worktreeBranches={worktreeBranches}
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
