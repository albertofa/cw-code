import type { RepoRef, RunConclusion, RunJob, RunRef, RunStatus, WorkflowRunSummary } from "@cw-code/contracts";
import { GH_HOST } from "./githubAccount.js";
import { asEpochMs, asNodes, asNumber, asRecord, asString, parseJsonObject } from "./prParsers.js";

const CONCLUSIONS = new Set<string>(["success", "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale", "startup_failure"]);
const RUN_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/i;
const REPO_ALIAS_RE = /^r\d+$/;
const ORG_ALIAS_RE = /^o\d+$/;

export function mapRunStatus(value: unknown): RunStatus {
  const status = asString(value).toLowerCase();
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in_progress";
  return "queued";
}

export function mapRunConclusion(value: unknown): RunConclusion {
  const conclusion = asString(value).toLowerCase();
  return CONCLUSIONS.has(conclusion) ? (conclusion as RunConclusion) : null;
}

function epochOrNull(value: unknown): number | null {
  const epoch = asEpochMs(value);
  return epoch > 0 ? epoch : null;
}

function mapJob(job: Record<string, unknown>, urlKey: string, startedKey: string, completedKey: string): RunJob {
  const status = mapRunStatus(job.status);
  return {
    name: asString(job.name),
    status,
    conclusion: status === "completed" ? mapRunConclusion(job.conclusion) : null,
    startedAt: epochOrNull(job[startedKey]),
    completedAt: epochOrNull(job[completedKey]),
    url: asString(job[urlKey]) || null
  };
}

function repoFromFullName(fullName: unknown): RepoRef | null {
  const [owner, repo, ...rest] = asString(fullName).split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return { host: GH_HOST, owner, repo };
}

function runRefFromUrl(url: string): RunRef | null {
  const match = RUN_URL_RE.exec(url.trim());
  if (!match) return null;
  const runId = Number.parseInt(match[4], 10);
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  return { host: match[1].toLowerCase(), owner: match[2], repo: match[3], runId };
}

interface CommitContext {
  repo: RepoRef | null;
  sha: string;
  title: string;
  prNumber: number | null;
  onDefaultBranch: boolean;
}

function suiteToRun(suite: Record<string, unknown>, context: CommitContext): WorkflowRunSummary | null {
  const workflowRun = asRecord(suite.workflowRun);
  const runId = asNumber(workflowRun.databaseId);
  if (runId <= 0) return null;
  const url = asString(workflowRun.url);
  const urlRef = runRefFromUrl(url);
  const repo = context.repo ?? urlRef;
  if (!repo) return null;
  const status = mapRunStatus(suite.status);
  const branch = asString(asRecord(suite.branch).name);
  const actor = asString(asRecord(suite.creator).login);
  const createdAt = asEpochMs(workflowRun.createdAt) || asEpochMs(suite.createdAt);
  return {
    ref: { host: repo.host, owner: repo.owner, repo: repo.repo, runId },
    url,
    workflowName: asString(asRecord(workflowRun.workflow).name),
    runNumber: asNumber(workflowRun.runNumber),
    event: asString(workflowRun.event),
    branch: branch || null,
    headSha: context.sha,
    title: context.title,
    actor: actor || null,
    status,
    conclusion: status === "completed" ? mapRunConclusion(suite.conclusion) : null,
    prNumber: context.prNumber,
    onDefaultBranch: context.onDefaultBranch,
    createdAt,
    updatedAt: asEpochMs(workflowRun.updatedAt) || asEpochMs(suite.updatedAt) || createdAt,
    jobs: asNodes(suite.checkRuns).map((job) => mapJob(job, "detailsUrl", "startedAt", "completedAt"))
  };
}

function commitRuns(commit: Record<string, unknown>, context: CommitContext): WorkflowRunSummary[] {
  return asNodes(commit.checkSuites)
    .map((suite) => suiteToRun(suite, context))
    .filter((run): run is WorkflowRunSummary => run !== null);
}

function pullRequestRuns(data: Record<string, unknown>): WorkflowRunSummary[] {
  return asNodes(asRecord(data.search)).flatMap((node) => {
    const number = asNumber(node.number);
    if (number <= 0) return [];
    const commit = asRecord(asNodes(node.commits)[0]?.commit);
    return commitRuns(commit, {
      repo: repoFromFullName(asRecord(node.repository).nameWithOwner),
      sha: asString(commit.oid),
      title: asString(node.title),
      prNumber: number,
      onDefaultBranch: false
    });
  });
}

function defaultBranchRuns(repository: Record<string, unknown>): WorkflowRunSummary[] {
  const commit = asRecord(asRecord(repository.defaultBranchRef).target);
  return commitRuns(commit, {
    repo: repoFromFullName(repository.nameWithOwner),
    sha: asString(commit.oid),
    title: asString(commit.messageHeadline),
    prNumber: null,
    onDefaultBranch: true
  });
}

export function parseRunSuites(json: string): WorkflowRunSummary[] {
  const data = asRecord(asRecord(parseJsonObject(json)).data);
  const collected = pullRequestRuns(data);
  for (const [alias, value] of Object.entries(data)) {
    if (REPO_ALIAS_RE.test(alias)) collected.push(...defaultBranchRuns(asRecord(value)));
    else if (ORG_ALIAS_RE.test(alias)) collected.push(...asNodes(asRecord(value).repositories).flatMap(defaultBranchRuns));
  }
  const unique = new Map<number, WorkflowRunSummary>();
  for (const run of collected) {
    if (!unique.has(run.ref.runId)) unique.set(run.ref.runId, run);
  }
  return [...unique.values()];
}

export function graphqlOutcome(json: string): { hasData: boolean; message: string | null } {
  const root = asRecord(parseJsonObject(json));
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const message = errors.map((error) => asString(asRecord(error).message)).find(Boolean) ?? null;
  return { hasData: root.data !== null && typeof root.data === "object", message };
}

export function mapRestRun(run: unknown, jobs: unknown): WorkflowRunSummary | null {
  const record = asRecord(run);
  const runId = asNumber(record.id);
  const url = asString(record.html_url);
  const ref = runRefFromUrl(url);
  if (runId <= 0 || !ref) return null;
  const status = mapRunStatus(record.status);
  const createdAt = asEpochMs(record.created_at);
  const jobList = Array.isArray(jobs) ? jobs : asRecord(jobs).jobs;
  const pullRequestNumber = Array.isArray(record.pull_requests) ? asNumber(asRecord(record.pull_requests[0]).number) : 0;
  const branch = asString(record.head_branch);
  const actor = asString(asRecord(record.actor).login);
  return {
    ref: { ...ref, runId },
    url,
    workflowName: asString(record.name),
    runNumber: asNumber(record.run_number),
    event: asString(record.event),
    branch: branch || null,
    headSha: asString(record.head_sha),
    title: asString(record.display_title) || asString(record.name),
    actor: actor || null,
    status,
    conclusion: status === "completed" ? mapRunConclusion(record.conclusion) : null,
    prNumber: pullRequestNumber > 0 ? pullRequestNumber : null,
    onDefaultBranch: false,
    createdAt,
    updatedAt: asEpochMs(record.updated_at) || createdAt,
    jobs: Array.isArray(jobList) ? jobList.map((job) => mapJob(asRecord(job), "html_url", "started_at", "completed_at")) : []
  };
}

export function newCiActivity(notifications: unknown, since: number): { found: boolean; latest: number } {
  let latest = since;
  let found = false;
  if (Array.isArray(notifications)) {
    for (const entry of notifications) {
      const notification = asRecord(entry);
      if (notification.reason !== "ci_activity") continue;
      const updatedAt = asEpochMs(notification.updated_at);
      if (updatedAt <= since) continue;
      found = true;
      if (updatedAt > latest) latest = updatedAt;
    }
  }
  return { found, latest };
}
