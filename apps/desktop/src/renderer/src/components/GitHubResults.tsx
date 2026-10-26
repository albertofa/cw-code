import { useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { GitHubRow as GitHubRowData, GitHubSubject } from "@cw-code/contracts";
import type { GitHubKind, GitHubViewGroup, RepoRef } from "../cw.js";
import { GitHubRow } from "./GitHubRow.js";
import { NamedIcon } from "./GitHubIcon.js";
import { ISSUE_BUCKETS, PR_BUCKETS, RUN_BUCKETS, groupItems, type BucketDef } from "./githubViewModel.js";
import { prKey } from "./prInbox.js";

const BUCKETS: Record<GitHubKind, BucketDef[]> = { pr: PR_BUCKETS, issue: ISSUE_BUCKETS, run: RUN_BUCKETS };

function rowKeyOf(subject: GitHubSubject): string {
  if (subject.kind === "pr") return prKey(subject.pr.ref);
  if (subject.kind === "issue") return prKey(subject.issue.ref);
  const { host, owner, repo, runId } = subject.run.ref;
  return `${host}/${owner}/${repo}#${runId}`;
}

export function GitHubResults({
  kind,
  rows,
  mode,
  collapsed,
  viewer,
  isCloned,
  onToggle,
  onAddQualifier
}: {
  kind: GitHubKind;
  rows: GitHubRowData[];
  mode: GitHubViewGroup;
  collapsed: string[];
  viewer: string | null;
  isCloned: (repo: RepoRef) => boolean;
  onToggle: (groupId: string) => void;
  onAddQualifier: (key: string, value: string) => void;
}) {
  const groups = useMemo(() => groupItems(rows, mode, { buckets: BUCKETS[kind], isCloned }), [rows, mode, kind, isCloned]);
  const list = (items: GitHubRowData[]) => (
    <div className="pr-inbox-rows">
      {items.map((row) => (
        <GitHubRow key={rowKeyOf(row.subject)} row={row} viewer={viewer} isCloned={isCloned} onAddQualifier={onAddQualifier} />
      ))}
    </div>
  );
  return (
    <div className="pr-inbox-groups">
      {groups.map((group) => {
        if (group.flat) {
          return (
            <section key={group.id} className="pr-inbox-group">
              {list(group.items)}
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
            {!isCollapsed && list(group.items)}
          </section>
        );
      })}
    </div>
  );
}
