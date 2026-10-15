import { Fragment, useCallback, useMemo, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { GitHubViewGroup, IssueSummary, PrSummary, RepoRef, WorkflowRunSummary } from "../cw.js";
import { GitHubRow } from "./GitHubRow.js";
import { NamedIcon } from "./GitHubIcon.js";
import { issueBucket, runBucket } from "./githubRowModel.js";
import { ISSUE_BUCKETS, PR_BUCKETS, RUN_BUCKETS, groupItems, type ResultGroup } from "./githubViewModel.js";
import { prBucket, prKey } from "./prInbox.js";

export type Listing =
  | { kind: "pr"; items: PrSummary[] }
  | { kind: "issue"; items: IssueSummary[] }
  | { kind: "run"; items: WorkflowRunSummary[] };

function GroupList<T>({
  groups,
  collapsed,
  keyOf,
  renderRow,
  onToggle
}: {
  groups: ResultGroup<T>[];
  collapsed: string[];
  keyOf: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  onToggle: (groupId: string) => void;
}) {
  const rows = (items: T[]) => (
    <div className="pr-inbox-rows">
      {items.map((item) => (
        <Fragment key={keyOf(item)}>{renderRow(item)}</Fragment>
      ))}
    </div>
  );
  return (
    <div className="pr-inbox-groups">
      {groups.map((group) => {
        if (group.flat) {
          return (
            <section key={group.id} className="pr-inbox-group">
              {rows(group.items)}
            </section>
          );
        }
        const isCollapsed = collapsed.includes(group.id);
        return (
          <section key={group.id} className={`pr-inbox-group${isCollapsed ? " collapsed" : ""}`}>
            <button type="button" className="pr-inbox-group-head" aria-expanded={!isCollapsed} onClick={() => onToggle(group.id)}>
              {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              <NamedIcon name={group.icon} size={13} className={`pr-inbox-group-icon tone-${group.tone}`} />
              <span className="pr-inbox-group-title">{group.title}</span>
              <span className="pr-inbox-group-count">{group.items.length}</span>
              <span className="pr-inbox-group-hint">{group.hint}</span>
            </button>
            {!isCollapsed && rows(group.items)}
          </section>
        );
      })}
    </div>
  );
}

interface ResultsProps {
  mode: GitHubViewGroup;
  collapsed: string[];
  viewer: string | null;
  isCloned: (repo: RepoRef) => boolean;
  onToggle: (groupId: string) => void;
  onAddQualifier: (key: string, value: string) => void;
}

function PrResults({ items, mode, collapsed, viewer, isCloned, onToggle, onAddQualifier }: ResultsProps & { items: PrSummary[] }) {
  const groups = useMemo(
    () => groupItems(items, mode, { buckets: PR_BUCKETS, bucketOf: prBucket, repoOf: (pr) => pr.ref, isCloned }),
    [items, mode, isCloned]
  );
  const renderRow = useCallback(
    (pr: PrSummary) => <GitHubRow kind="pr" item={pr} viewer={viewer} onAddQualifier={onAddQualifier} />,
    [viewer, onAddQualifier]
  );
  return <GroupList groups={groups} collapsed={collapsed} keyOf={(pr) => prKey(pr.ref)} renderRow={renderRow} onToggle={onToggle} />;
}

function IssueResults({
  items,
  mode,
  collapsed,
  viewer,
  mentionsMode,
  isCloned,
  onToggle,
  onAddQualifier
}: ResultsProps & { items: IssueSummary[]; mentionsMode: boolean }) {
  const groups = useMemo(
    () =>
      groupItems(items, mode, {
        buckets: ISSUE_BUCKETS,
        bucketOf: (issue) => issueBucket(issue, viewer, mentionsMode),
        repoOf: (issue) => issue.ref,
        isCloned
      }),
    [items, mode, viewer, mentionsMode, isCloned]
  );
  const renderRow = useCallback(
    (issue: IssueSummary) => <GitHubRow kind="issue" item={issue} viewer={viewer} onAddQualifier={onAddQualifier} />,
    [viewer, onAddQualifier]
  );
  return <GroupList groups={groups} collapsed={collapsed} keyOf={(issue) => prKey(issue.ref)} renderRow={renderRow} onToggle={onToggle} />;
}

function RunResults({ items, mode, collapsed, viewer, isCloned, onToggle, onAddQualifier }: ResultsProps & { items: WorkflowRunSummary[] }) {
  const groups = useMemo(
    () => groupItems(items, mode, { buckets: RUN_BUCKETS, bucketOf: runBucket, repoOf: (run) => run.ref, isCloned }),
    [items, mode, isCloned]
  );
  const renderRow = useCallback(
    (run: WorkflowRunSummary) => <GitHubRow kind="run" item={run} viewer={viewer} onAddQualifier={onAddQualifier} />,
    [viewer, onAddQualifier]
  );
  return (
    <GroupList
      groups={groups}
      collapsed={collapsed}
      keyOf={(run) => `${run.ref.host}/${run.ref.owner}/${run.ref.repo}#${run.ref.runId}`}
      renderRow={renderRow}
      onToggle={onToggle}
    />
  );
}

export function GitHubResults({ listing, mentionsMode, ...rest }: ResultsProps & { listing: Listing; mentionsMode: boolean }) {
  if (listing.kind === "pr") return <PrResults items={listing.items} {...rest} />;
  if (listing.kind === "issue") return <IssueResults items={listing.items} mentionsMode={mentionsMode} {...rest} />;
  return <RunResults items={listing.items} {...rest} />;
}
