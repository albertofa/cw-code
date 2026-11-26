import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent
} from "react";
import { Check, Cloud, GitFork, Monitor, Tag } from "lucide-react";
import type { HistoryCommit, HistoryLog, HistoryWorktree } from "@cw-code/contracts";
import { computeGraphLayout } from "../../history/graphLayout.js";
import { relativeTime } from "../prDetailModel.js";
import { GraphCanvas, graphColumnWidth, type NodeKind } from "./GraphCanvas.js";
import { initialsOf, type NodeAvatar } from "./historyAvatars.js";
import { PALETTE_SIZE, paletteVar, useGraphTheme } from "./graphTheme.js";
import { buildRefLabel, type LocalBranches, type RefEntry, type RefLabel } from "./refLabel.js";
import { useVirtualRows } from "./useVirtualRows.js";
import { buildSlots, ROW_HEIGHT, SEPARATOR_HEIGHT, type Slot } from "./gitGlassLayout.js";
import { dayLabels } from "./daySeparators.js";
import { startWidthDrag } from "./usePersistedState.js";

export const WIP_SHA = "WIP";
export const REF_COLUMN_DEFAULT = 170;
export const REF_COLUMN_MIN = 60;
export const REF_COLUMN_MAX = 400;
export const GRAPH_COLUMN_MIN = 30;
export const GRAPH_COLUMN_MAX = 400;
const OVERSCAN = 10;
const HEADER_HEIGHT = 30;
const DATE_WIDTH = 118;
const NARROW_DATE_WIDTH = 76;

export interface WipSummary {
  files: number;
  added: number | null;
  deleted: number | null;
}

export type ColumnId = "ref" | "graph";

function nodeKind(commit: HistoryCommit): NodeKind {
  if (commit.sha === WIP_SHA) return "wip";
  if (commit.isStash) return "stash";
  return commit.parents.length >= 2 ? "merge" : "commit";
}

function withWip(log: HistoryLog, hasWip: boolean): HistoryCommit[] {
  const headSha = log.head.sha;
  if (!hasWip || !headSha) return log.commits;
  const now = Math.floor(Date.now() / 1000);
  const wip: HistoryCommit = {
    sha: WIP_SHA,
    parents: [headSha],
    authorName: "",
    authorEmail: "",
    authorDate: now,
    committerDate: now,
    subject: "Uncommitted changes",
    isStash: false
  };
  return [wip, ...log.commits];
}

export function localBranchesOf(log: HistoryLog): LocalBranches {
  return {
    names: new Set(log.refs.filter((ref) => ref.kind === "local").map((ref) => ref.name)),
    current: log.head.detached ? null : log.head.branch
  };
}

export function refLabelAt(log: HistoryLog, sha: string): RefLabel | null {
  const refs = log.refs.filter((ref) => ref.target === sha);
  return buildRefLabel(refs, log.head.detached && log.head.sha === sha, localBranchesOf(log));
}

function labelsBySha(log: HistoryLog, present: Set<string>): Map<string, RefLabel> {
  const localBranches = localBranchesOf(log);
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

export function RefIcons({ kind, isCurrent, hasLocal, hasRemote }: { kind: RefLabel["kind"]; isCurrent: boolean; hasLocal: boolean; hasRemote: boolean }) {
  return (
    <>
      {isCurrent && kind !== "head" && <Check size={11} className="history-ref-icon" />}
      {kind === "tag" && <Tag size={11} className="history-ref-icon" />}
      {hasLocal && <Monitor size={11} className="history-ref-icon" />}
      {hasRemote && <Cloud size={11} className="history-ref-icon" />}
    </>
  );
}

function worktreeOf(entry: RefEntry | undefined, worktreeBranches: ReadonlyMap<string, HistoryWorktree>): HistoryWorktree | undefined {
  if (!entry || !entry.hasLocal) return undefined;
  return worktreeBranches.get(entry.name);
}

function WorktreeChip({ worktree, compact = false }: { worktree: HistoryWorktree | undefined; compact?: boolean }) {
  if (!worktree) return null;
  return (
    <span className={`history-ref-wt${compact ? " compact" : ""}`} title={`Open in the worktree ${worktree.name} — ${worktree.path}`}>
      <GitFork size={10} aria-hidden="true" />
      {!compact && worktree.name}
    </span>
  );
}

function entryTitle(entry: RefEntry, worktreeBranches: ReadonlyMap<string, HistoryWorktree>): string {
  const elsewhere = entry.checkout === null ? undefined : worktreeBranches.get(entry.checkout);
  if (elsewhere) return `${entry.name} — open in the worktree ${elsewhere.name}; double-click to open its tab`;
  if (entry.isCurrent) return `${entry.name} — current branch`;
  if (entry.checkout === null && entry.localElsewhere) return `${entry.name} — its local branch is the current one; Pull updates it`;
  if (entry.checkout === null) return entry.kind === "tag" ? `Tag ${entry.name}` : entry.name;
  if (entry.localElsewhere) return `${entry.name} — double-click to check out the local ${entry.checkout}, which is on another commit; Pull updates it (git switch ${entry.checkout})`;
  const command = entry.kind === "remote" ? `git switch --track ${entry.checkout}` : `git switch ${entry.checkout}`;
  return `${entry.name} — double-click to check out (${command})`;
}

function isActivation(event: KeyboardEvent): boolean {
  return event.key === "Enter" || event.key === " ";
}

function RefLabelCell({ label, onCheckout, worktreeBranches }: { label: RefLabel; onCheckout: (branch: string) => void; worktreeBranches: ReadonlyMap<string, HistoryWorktree> }) {
  const [open, setOpen] = useState(false);
  const stacked = label.extra > 0;
  const primary = label.entries[0];
  const run = (entry: RefEntry | undefined, event: SyntheticEvent): void => {
    event.stopPropagation();
    if (entry?.checkout && !entry.isCurrent) onCheckout(entry.checkout);
  };
  const chipKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (!isActivation(event)) return;
    event.preventDefault();
    if (stacked) {
      event.stopPropagation();
      setOpen((value) => !value);
    } else run(primary, event);
  };
  const rowKey = (entry: RefEntry) => (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (!isActivation(event)) return;
    event.preventDefault();
    run(entry, event);
  };
  const leave = (event: FocusEvent<HTMLSpanElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };
  return (
    <>
      <span className="history-ref-anchor" onMouseEnter={() => setOpen(stacked)} onMouseLeave={() => setOpen(false)} onBlur={leave}>
        <span
          className={`history-ref ${label.kind}${label.isCurrent ? " current" : ""}`}
          title={stacked ? undefined : primary ? entryTitle(primary, worktreeBranches) : label.title}
          role="button"
          tabIndex={0}
          aria-haspopup={stacked ? "true" : undefined}
          aria-expanded={stacked ? open : undefined}
          onDoubleClick={(event) => run(primary, event)}
          onKeyDown={chipKey}
        >
          <RefIcons kind={label.kind} isCurrent={label.isCurrent} hasLocal={label.hasLocal} hasRemote={label.hasRemote} />
          <span className="history-ref-text">{label.label}</span>
          <WorktreeChip worktree={worktreeOf(primary, worktreeBranches)} compact />
          {stacked && <span className="history-ref-extra">+{label.extra}</span>}
        </span>
        {open && (
          <span className="history-ref-stack" role="list">
            {label.entries.map((entry) => (
              <span
                key={entry.key}
                className={`history-ref-stack-row ${entry.kind}${entry.isCurrent ? " current" : ""}${entry.checkout !== null && worktreeBranches.has(entry.checkout) ? " elsewhere" : ""}`}
                role="button"
                tabIndex={0}
                title={entryTitle(entry, worktreeBranches)}
                onDoubleClick={(event) => run(entry, event)}
                onKeyDown={rowKey(entry)}
              >
                <RefIcons kind={entry.kind} isCurrent={entry.isCurrent} hasLocal={false} hasRemote={false} />
                <span className="history-ref-text">{entry.name}</span>
                {entry.hasLocal && <Monitor size={11} className="history-ref-icon" />}
                {entry.hasRemote && <Cloud size={11} className="history-ref-icon" />}
                <WorktreeChip worktree={worktreeOf(entry, worktreeBranches)} />
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
const shortFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

function WipChanges({ wip }: { wip: WipSummary }) {
  return (
    <span className="gg-wip-counts">
      <span className="gg-chg mod" title={`${wip.files} changed ${wip.files === 1 ? "file" : "files"}`}>
        ~{wip.files}
      </span>
      {wip.added !== null && wip.added > 0 && (
        <span className="gg-chg add" title={`${wip.added} added ${wip.added === 1 ? "line" : "lines"}`}>
          +{wip.added}
        </span>
      )}
      {wip.deleted !== null && wip.deleted > 0 && (
        <span className="gg-chg del" title={`${wip.deleted} removed ${wip.deleted === 1 ? "line" : "lines"}`}>
          −{wip.deleted}
        </span>
      )}
    </span>
  );
}

const HistoryRow = memo(function HistoryRow({
  commit,
  label,
  colorIndex,
  nowMs,
  selected,
  dimmed,
  wip,
  showAuthor,
  absoluteDates,
  onSelect,
  onCheckout,
  worktreeBranches,
  hint
}: {
  commit: HistoryCommit;
  label: RefLabel | null;
  colorIndex: number;
  nowMs: number;
  selected: boolean;
  dimmed: boolean;
  wip: WipSummary | null;
  showAuthor: boolean;
  absoluteDates: boolean;
  onSelect: (sha: string) => void;
  onCheckout: (branch: string) => void;
  worktreeBranches: ReadonlyMap<string, HistoryWorktree>;
  hint: string | null;
}) {
  const isWip = commit.sha === WIP_SHA;
  const date = new Date(commit.authorDate * 1000);
  const title = isWip
    ? hint
      ? `${commit.subject}\n${hint}`
      : commit.subject
    : `${commit.subject}\n${commit.authorName} <${commit.authorEmail}>\n${absoluteFormat.format(date)}\n${commit.sha}`;
  return (
    <div
      className={`history-row${selected ? " selected" : ""}${isWip ? " wip" : ""}${commit.isStash ? " stash" : ""}${dimmed ? " dim" : ""}`}
      style={{ height: ROW_HEIGHT, "--lane": paletteVar(colorIndex) } as CSSProperties}
      role="option"
      aria-selected={selected}
      title={title}
      onClick={() => onSelect(commit.sha)}
    >
      <span className="history-ref-cell">{label && <RefLabelCell label={label} onCheckout={onCheckout} worktreeBranches={worktreeBranches} />}</span>
      <span className="history-graph-cell" />
      <span className="history-message">
        <span className="history-subject">{commit.subject}</span>
        {isWip && wip && <WipChanges wip={wip} />}
        {!isWip && showAuthor && <span className="history-author">{commit.authorName}</span>}
      </span>
      <span className="history-date">{isWip ? "" : absoluteDates ? shortFormat.format(date) : relativeTime(date.getTime(), nowMs)}</span>
    </div>
  );
});

function SeparatorRow({ slot }: { slot: Extract<Slot, { kind: "separator" }> }) {
  return (
    <div className="history-separator" style={{ height: slot.height }} role="presentation">
      <span className="history-separator-label">{slot.label}</span>
    </div>
  );
}

function ColumnHandle({ label, width, onResize, onReset }: { label: string; width: number; onResize: (width: number, commit: boolean) => void; onReset: () => void }) {
  const begin = (event: ReactPointerEvent<HTMLSpanElement>): void =>
    startWidthDrag(
      event,
      width,
      1,
      (next) => onResize(next, false),
      (next) => onResize(next, true)
    );
  return (
    <span
      className="history-col-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${label} column`}
      title="Drag to resize (double-click resets)"
      onPointerDown={begin}
      onDoubleClick={onReset}
    />
  );
}

export function HistoryGraph({
  log,
  wip,
  selected,
  onSelect,
  onLoadMore,
  loadingMore,
  avatars,
  showAvatars,
  onCheckout,
  onHighlight,
  worktreeBranches,
  wipHint,
  onClearSelection,
  matches,
  refWidth,
  graphWidth: graphWidthSetting,
  onColumnResize,
  narrow,
  showAuthors,
  absoluteDates
}: {
  log: HistoryLog;
  wip: WipSummary | null;
  selected: string | null;
  onSelect: (sha: string) => void;
  onLoadMore: (() => void) | null;
  loadingMore: boolean;
  avatars: Record<string, string | null>;
  showAvatars: boolean;
  onCheckout: (branch: string) => void;
  onHighlight: (sha: string) => void;
  worktreeBranches: ReadonlyMap<string, HistoryWorktree>;
  wipHint: string | null;
  onClearSelection: () => void;
  matches: ReadonlySet<string> | null;
  refWidth: number;
  graphWidth: number | null;
  onColumnResize: (column: ColumnId, width: number | null, commit: boolean) => void;
  narrow: boolean;
  showAuthors: boolean;
  absoluteDates: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useGraphTheme();
  const hasWip = wip !== null && wip.files > 0;
  const commits = useMemo(() => withWip(log, hasWip), [log, hasWip]);
  const indexBySha = useMemo(() => new Map(commits.map((commit, index) => [commit.sha, index])), [commits]);
  const nowMs = useMemo(() => Date.now(), [commits]);
  const layout = useMemo(() => computeGraphLayout(commits, PALETTE_SIZE), [commits]);
  const slotLayout = useMemo(
    () =>
      buildSlots(
        dayLabels(
          nowMs,
          commits.map((commit) => (commit.sha === WIP_SHA ? null : commit.authorDate * 1000))
        ),
        ROW_HEIGHT,
        SEPARATOR_HEIGHT
      ),
    [commits, nowMs]
  );
  const kinds = useMemo(() => commits.map(nodeKind), [commits]);
  const labels = useMemo(() => labelsBySha(log, new Set(commits.map((commit) => commit.sha))), [log, commits]);
  const labeled = useMemo(() => commits.map((commit) => labels.has(commit.sha)), [commits, labels]);
  const dimmed = useMemo(() => (matches ? commits.map((commit) => !matches.has(commit.sha)) : null), [commits, matches]);
  const nodeAvatars = useMemo<(NodeAvatar | null)[] | null>(() => {
    if (!showAvatars) return null;
    return commits.map((commit, index) => {
      if (kinds[index] !== "commit" || commit.authorEmail === "") return null;
      const email = commit.authorEmail.toLowerCase();
      return { email, initials: initialsOf(commit.authorName, email), url: avatars[email] ?? null };
    });
  }, [commits, kinds, avatars, showAvatars]);
  const headIndex = useMemo(() => (log.head.sha ? (indexBySha.get(log.head.sha) ?? -1) : -1), [indexBySha, log.head.sha]);
  const autoGraphWidth = graphColumnWidth(layout.laneCount);
  const graphWidth = graphWidthSetting ?? autoGraphWidth;
  const dateWidth = narrow ? NARROW_DATE_WIDTH : DATE_WIDTH;
  const { start, end, scrollToSlot } = useVirtualRows(containerRef, slotLayout, OVERSCAN, HEADER_HEIGHT);
  const columns = { "--gg-cols": `${refWidth}px ${graphWidth}px minmax(0, 1fr) ${dateWidth}px` } as CSSProperties;

  const reveal = useRef<(sha: string) => void>(() => undefined);
  reveal.current = (sha: string): void => {
    const index = indexBySha.get(sha);
    const slot = index === undefined ? undefined : slotLayout.slotOfIndex[index];
    if (slot !== undefined) scrollToSlot(slot);
  };

  useEffect(() => {
    if (selected) reveal.current(selected);
  }, [selected]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && selected) {
      event.preventDefault();
      event.stopPropagation();
      onClearSelection();
      return;
    }
    if (event.key === "Enter" && selected) {
      event.preventDefault();
      onSelect(selected);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const first = commits[0]?.sha === WIP_SHA ? 1 : 0;
    if (commits.length <= first) return;
    const current = selected ? (indexBySha.get(selected) ?? -1) : -1;
    const next = current === -1 ? first : Math.min(commits.length - 1, Math.max(first, current + (event.key === "ArrowDown" ? 1 : -1)));
    const target = commits[next];
    if (!target) return;
    onHighlight(target.sha);
  };

  return (
    <div ref={containerRef} className="history-scroll" style={columns} tabIndex={0} role="listbox" aria-label="Commits" onKeyDown={onKeyDown}>
      <div className="history-header" style={{ height: HEADER_HEIGHT }}>
        <span className="history-header-cell">
          Branch / Tag
          <ColumnHandle
            label="branch and tag"
            width={refWidth}
            onResize={(width, commit) => onColumnResize("ref", width, commit)}
            onReset={() => onColumnResize("ref", null, true)}
          />
        </span>
        <span className="history-header-cell">
          Graph
          <ColumnHandle
            label="graph"
            width={graphWidth}
            onResize={(width, commit) => onColumnResize("graph", width, commit)}
            onReset={() => onColumnResize("graph", null, true)}
          />
        </span>
        <span className="history-header-cell">Message</span>
        <span className="history-header-cell end">Date</span>
      </div>
      <div className="history-spacer" style={{ height: slotLayout.total }}>
        <GraphCanvas
          rows={layout.rows}
          slots={slotLayout.slots}
          start={start}
          end={end}
          kinds={kinds}
          avatars={nodeAvatars}
          labeled={labeled}
          dimmed={dimmed}
          headIndex={headIndex}
          left={refWidth}
          width={graphWidth}
          theme={theme}
        />
        <div className="history-window" style={{ top: slotLayout.slots[start]?.top ?? 0 }}>
          {slotLayout.slots.slice(start, end).map((slot) => {
            if (slot.kind === "separator") return <SeparatorRow key={`sep:${slot.before}`} slot={slot} />;
            const commit = commits[slot.index];
            if (!commit) return null;
            return (
              <HistoryRow
                key={commit.sha}
                commit={commit}
                label={labels.get(commit.sha) ?? null}
                colorIndex={layout.rows[slot.index]?.color ?? 0}
                nowMs={nowMs}
                selected={commit.sha === selected}
                dimmed={dimmed?.[slot.index] ?? false}
                wip={commit.sha === WIP_SHA ? wip : null}
                showAuthor={showAuthors && !narrow}
                absoluteDates={absoluteDates}
                onSelect={onSelect}
                onCheckout={onCheckout}
                worktreeBranches={worktreeBranches}
                hint={commit.sha === WIP_SHA ? wipHint : null}
              />
            );
          })}
        </div>
      </div>
      {log.truncated && onLoadMore && (
        <div className="history-more">
          <button type="button" className="inspect-mode" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : `Load more (showing ${log.commits.length})`}
          </button>
        </div>
      )}
      {log.truncated && !onLoadMore && (
        <div className="history-more" role="status">
          Showing the newest {log.commits.length} commits — older history is not loaded here.
        </div>
      )}
    </div>
  );
}
