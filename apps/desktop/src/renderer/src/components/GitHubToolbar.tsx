import { useState } from "react";
import { ArrowDownWideNarrow, Check, ChevronDown, CircleDot, GitPullRequest, TriangleAlert } from "lucide-react";
import type { GitHubKind, GitHubViewGroup } from "../cw.js";
import { AnchoredPopover, anchorRectOf, type AnchorRect } from "./AnchoredPopover.js";
import { SORT_LABELS, sortKeysFor, stateOf, withQualifier, withState } from "@cw-code/shared/githubQueryDsl";
import { GROUP_LABELS, sortOf } from "./githubViewModel.js";
import { Spinner } from "./Loading.js";

const GROUP_MODES: GitHubViewGroup[] = ["triage", "repo", "none"];
const COUNTS_UNAVAILABLE_TITLE = "Counts unavailable with cw-only filters";

function groupLabel(kind: GitHubKind, mode: GitHubViewGroup): string {
  if (mode === "triage") return GROUP_LABELS[kind];
  return mode === "repo" ? "Repo" : "None";
}

function StateTab({
  state,
  current,
  count,
  kind,
  onSelect
}: {
  state: "open" | "closed";
  current: "open" | "closed" | null;
  count: number | null;
  kind: GitHubKind;
  onSelect: () => void;
}) {
  const OpenIcon = kind === "pr" ? GitPullRequest : CircleDot;
  return (
    <button type="button" className={`hub-state-tab${current === state ? " on" : ""}`} aria-pressed={current === state} onClick={onSelect}>
      {state === "open" ? <OpenIcon size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      {state === "open" ? "Open" : "Closed"}
      {count !== null && <b>{count}</b>}
    </button>
  );
}

export function GitHubToolbar({
  kind,
  query,
  group,
  openCount,
  closedCount,
  countsUnavailable,
  visibleCount,
  problems,
  refreshing,
  truncatedLimit,
  onQueryChange,
  onGroupChange
}: {
  kind: GitHubKind;
  query: string;
  group: GitHubViewGroup;
  openCount: number | null;
  closedCount: number | null;
  countsUnavailable: boolean;
  visibleCount: number;
  problems: string[];
  refreshing: boolean;
  truncatedLimit: number | null;
  onQueryChange: (query: string) => void;
  onGroupChange: (group: GitHubViewGroup) => void;
}) {
  const [sortAnchor, setSortAnchor] = useState<AnchorRect | null>(null);
  const currentState = stateOf(query);
  const currentSort = sortOf(kind, query);
  const source = kind === "run" ? "from PR checks and default branches" : "via GitHub search";

  return (
    <div className="hub-toolbar">
      {kind === "run" ? (
        <span className="hub-result-count">
          {visibleCount} workflow {visibleCount === 1 ? "run" : "runs"}
        </span>
      ) : (
        <div className="hub-state-tabs" title={countsUnavailable ? COUNTS_UNAVAILABLE_TITLE : undefined}>
          <StateTab state="open" current={currentState} count={countsUnavailable ? null : openCount} kind={kind} onSelect={() => onQueryChange(withState(query, "open"))} />
          <StateTab state="closed" current={currentState} count={countsUnavailable ? null : closedCount} kind={kind} onSelect={() => onQueryChange(withState(query, "closed"))} />
        </div>
      )}
      <div className="hub-toolbar-right">
        {problems.length > 0 && (
          <span className="hub-query-warn" title={problems.join("\n")}>
            <TriangleAlert size={13} aria-hidden="true" />
            {problems[0]}
            {problems.length > 1 && ` +${problems.length - 1}`}
          </span>
        )}
        {refreshing && (
          <span className="hub-updating" role="status">
            <Spinner size={12} />
            Updating…
          </span>
        )}
        {truncatedLimit !== null && (
          <span className="hub-src" title={`GitHub search returns at most ${truncatedLimit} results per query; older ones may be missing`}>
            at most {truncatedLimit} per search
          </span>
        )}
        <span className="hub-src">
          {visibleCount} result{visibleCount === 1 ? "" : "s"} {source}
        </span>
        <button
          type="button"
          className={`side-filter-btn${sortAnchor ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={sortAnchor !== null}
          onClick={(event) => setSortAnchor(sortAnchor ? null : anchorRectOf(event.currentTarget))}
        >
          <ArrowDownWideNarrow size={12} aria-hidden="true" />
          <span>{SORT_LABELS[currentSort] ?? currentSort}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        <span className="hub-seg" role="group" aria-label="Group results">
          {GROUP_MODES.map((mode) => (
            <button key={mode} type="button" className={group === mode ? "on" : ""} aria-pressed={group === mode} onClick={() => onGroupChange(mode)}>
              {groupLabel(kind, mode)}
            </button>
          ))}
        </span>
      </div>
      {sortAnchor && (
        <AnchoredPopover anchor={sortAnchor} align="right" label="Sort results" onClose={() => setSortAnchor(null)}>
          {sortKeysFor(kind).map((key) => (
            <button
              key={key}
              type="button"
              className={`pr-inbox-popover-item${key === currentSort ? " on" : ""}`}
              onClick={() => {
                onQueryChange(withQualifier(query, "sort", key));
                setSortAnchor(null);
              }}
            >
              {key === currentSort ? <Check size={13} aria-hidden="true" /> : <span className="hub-menu-check-spacer" />}
              <span>{SORT_LABELS[key]}</span>
              <span className="hub-ac-desc hub-mono">sort:{key}</span>
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}
