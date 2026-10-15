import { Activity, CircleDot, GitPullRequest } from "lucide-react";
import type { IssueDetail, PrSummary, RunRef, WorkflowRunSummary } from "../cw.js";
import { prChip } from "./prChip.js";
import { runVerdict } from "./githubRowModel.js";

const SHORT_SHA_LENGTH = 7;

export function PrCard({ pr }: { pr: PrSummary }) {
  const chip = prChip({ pr, git: null });
  return (
    <div className="wf-run-pr">
      <GitPullRequest size={16} aria-hidden="true" className="wf-run-pr-icon" />
      <div className="wf-run-pr-text">
        <div className="wf-run-pr-title" title={pr.title}>
          {pr.title} <span className="wf-run-muted">#{pr.ref.number}</span>
        </div>
        <div className="wf-run-pr-meta">
          <span>{pr.ref.owner}/{pr.ref.repo}</span>
          <span aria-hidden="true">·</span>
          <span className="wf-run-branch">{pr.headRefName}</span>
          <span aria-hidden="true">→</span>
          <span className="wf-run-branch">{pr.baseRefName}</span>
        </div>
      </div>
      {chip && (
        <span className={`pr-chip tone-${chip.tone}`} title={chip.title}>
          {chip.title.replace(/^PR #\d+ · /, "")}
        </span>
      )}
    </div>
  );
}

export function IssueCard({ issue }: { issue: IssueDetail }) {
  const linked = issue.linkedPrs[0];
  return (
    <div className="wf-run-pr">
      <CircleDot size={16} aria-hidden="true" className="wf-run-pr-icon" />
      <div className="wf-run-pr-text">
        <div className="wf-run-pr-title" title={issue.title}>
          {issue.title} <span className="wf-run-muted">#{issue.ref.number}</span>
        </div>
        <div className="wf-run-pr-meta">
          <span>{issue.ref.owner}/{issue.ref.repo}</span>
          {issue.labels.map((label) => (
            <span key={label} className="pr-inbox-label">{label}</span>
          ))}
        </div>
      </div>
      {linked && (
        <span className="pr-chip tone-info" title={`Linked pull request #${linked.number}`}>
          PR #{linked.number} · {linked.isDraft ? "draft" : linked.state.toLowerCase()}
        </span>
      )}
    </div>
  );
}

export function RunCard({ run, runRef }: { run: WorkflowRunSummary | undefined; runRef: RunRef }) {
  if (!run) {
    return (
      <div className="wf-run-pr">
        <Activity size={16} aria-hidden="true" className="wf-run-pr-icon" />
        <div className="wf-run-pr-text">
          <div className="wf-run-pr-title">
            Workflow run <span className="wf-run-muted">{runRef.runId}</span>
          </div>
          <div className="wf-run-pr-meta">
            <span>{runRef.owner}/{runRef.repo}</span>
          </div>
        </div>
      </div>
    );
  }
  const verdict = runVerdict(run);
  return (
    <div className="wf-run-pr">
      <Activity size={16} aria-hidden="true" className="wf-run-pr-icon" />
      <div className="wf-run-pr-text">
        <div className="wf-run-pr-title" title={run.title}>
          {run.workflowName} <span className="wf-run-muted">#{run.runNumber}</span>
        </div>
        <div className="wf-run-pr-meta">
          <span>{run.ref.owner}/{run.ref.repo}</span>
          {run.branch && (
            <>
              <span aria-hidden="true">·</span>
              <span className="wf-run-branch">{run.branch}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="wf-run-branch">{run.headSha.slice(0, SHORT_SHA_LENGTH)}</span>
        </div>
      </div>
      <span className={`pr-chip tone-${verdict.tone}`}>{verdict.text}</span>
    </div>
  );
}
