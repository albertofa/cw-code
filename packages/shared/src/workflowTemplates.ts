import type { PrWorkflow } from "@cw-code/contracts";

export const TEMPLATE_VARS = [
  "pr.number",
  "pr.title",
  "pr.body",
  "pr.url",
  "pr.repo",
  "pr.head",
  "pr.base",
  "pr.sha",
  "pr.diffStat",
  "pr.threads",
  "pr.unresolvedThreads",
  "checks.summary",
  "checks.failedLogs",
  "pr.delta",
  "session.lastSeenSha",
  "attribution",
  "harness"
] as const;

export const ISSUE_TEMPLATE_VARS = [
  "issue.number",
  "issue.title",
  "issue.body",
  "issue.url",
  "issue.repo",
  "issue.labels",
  "issue.comments",
  "issue.delta",
  "attribution",
  "harness"
] as const;

export const RUN_TEMPLATE_VARS = [
  "run.id",
  "run.number",
  "run.workflow",
  "run.url",
  "run.repo",
  "run.branch",
  "run.sha",
  "run.event",
  "run.failedJobs",
  "run.failedLogs",
  "attribution",
  "harness"
] as const;

export const TEMPLATE_VARS_BY_TARGET: Record<PrWorkflow["target"], readonly string[]> = {
  pr: TEMPLATE_VARS,
  issue: ISSUE_TEMPLATE_VARS,
  run: RUN_TEMPLATE_VARS
};
