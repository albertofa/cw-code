import type { GitHubRow, GitHubSubject } from "@cw-code/contracts";
import type { GitHubKind, GitHubViewGroup, IssueSummary, PrSummary, ProjectGitHubRepo, RepoRef, WorkflowRunSummary } from "../cw.js";
import type { GitHubView } from "../stores/githubStore.js";
import { normalizeQuery, sortKeysFor, tokenize } from "@cw-code/shared/githubQueryDsl";
import type { SuggestionSource } from "./githubAutocomplete.js";

export type BucketTone = "info" | "warn" | "ok" | "neutral" | "bad" | "merged";

export interface BucketDef {
  id: string;
  title: string;
  icon: string;
  tone: BucketTone;
  hint: string;
}

export interface ResultGroup {
  id: string;
  title: string;
  icon: string;
  tone: BucketTone;
  hint: string;
  flat: boolean;
  items: GitHubRow[];
}

export interface TabBadge {
  count: number;
  tone: "default" | "quiet" | "bad";
}

export const PR_BUCKETS: BucketDef[] = [
  { id: "review", title: "Needs your review", icon: "Eye", tone: "info", hint: "review requested from you" },
  { id: "action", title: "Your PRs · needs action", icon: "TriangleAlert", tone: "warn", hint: "failing checks · changes requested · conflicts" },
  { id: "ready", title: "Ready to merge", icon: "GitMerge", tone: "ok", hint: "approved + green" },
  { id: "waiting", title: "Waiting", icon: "Clock", tone: "neutral", hint: "draft or awaiting reviewers" },
  { id: "merged", title: "Merged", icon: "GitMerge", tone: "merged", hint: "" },
  { id: "closed", title: "Closed", icon: "GitPullRequestClosed", tone: "bad", hint: "not merged" }
];

export const ISSUE_BUCKETS: BucketDef[] = [
  { id: "assigned", title: "Assigned to you", icon: "UserCheck", tone: "info", hint: "" },
  { id: "mentioned", title: "Mentions", icon: "AtSign", tone: "warn", hint: "" },
  { id: "created", title: "Created by you", icon: "Pencil", tone: "neutral", hint: "" },
  { id: "other", title: "Other", icon: "CircleDot", tone: "neutral", hint: "not involving you" },
  { id: "closed", title: "Closed", icon: "CircleCheckBig", tone: "merged", hint: "" }
];

export const RUN_BUCKETS: BucketDef[] = [
  { id: "failing", title: "Failing", icon: "CircleX", tone: "bad", hint: "" },
  { id: "running", title: "In progress", icon: "Loader", tone: "warn", hint: "running or queued" },
  { id: "recent", title: "Recent", icon: "History", tone: "neutral", hint: "" }
];

export const GROUP_LABELS: Record<GitHubKind, string> = { pr: "Triage", issue: "Involvement", run: "Status" };

export const KIND_LABELS: Record<GitHubKind, string> = { pr: "Pull requests", issue: "Issues", run: "Actions" };

export const KIND_NOUNS: Record<GitHubKind, string> = { pr: "pull requests", issue: "issues", run: "workflow runs" };

export const KIND_ORDER: GitHubKind[] = ["pr", "issue", "run"];

const DEFAULT_REMOTE_SORT = "updated-desc";
const DEFAULT_RUN_SORT = "created-desc";
const REPO_GROUP_ICON = "BookMarked";

export function repoNameOf(ref: { owner: string; repo: string }): string {
  return `${ref.owner}/${ref.repo}`;
}

export function subjectRepoOf(subject: GitHubSubject): RepoRef {
  if (subject.kind === "pr") return subject.pr.ref;
  if (subject.kind === "issue") return subject.issue.ref;
  return subject.run.ref;
}

export function groupItems(
  rows: GitHubRow[],
  mode: GitHubViewGroup,
  options: { buckets: BucketDef[]; isCloned(repo: RepoRef): boolean }
): ResultGroup[] {
  if (mode === "none") {
    return [{ id: "all", title: "", icon: "", tone: "neutral", hint: "", flat: true, items: rows }];
  }
  if (mode === "repo") {
    const byRepo = new Map<string, { repo: RepoRef; items: GitHubRow[] }>();
    for (const row of rows) {
      const repo = subjectRepoOf(row.subject);
      const name = repoNameOf(repo);
      const entry = byRepo.get(name);
      if (entry) entry.items.push(row);
      else byRepo.set(name, { repo, items: [row] });
    }
    return [...byRepo.entries()].map(([name, entry]) => ({
      id: `repo:${name}`,
      title: name,
      icon: REPO_GROUP_ICON,
      tone: "neutral",
      hint: options.isCloned(entry.repo) ? "cloned" : "",
      flat: false,
      items: entry.items
    }));
  }
  return options.buckets
    .map((bucket) => ({ ...bucket, flat: false, items: rows.filter((row) => row.bucket === bucket.id) }))
    .filter((group) => group.items.length > 0);
}

const KIND_VALUES: ReadonlySet<string> = new Set<GitHubKind>(["pr", "issue", "run"]);

export function retargetQuery(query: string, kind: GitHubKind): string {
  const kept = tokenize(query).filter((token) => {
    if (token.kind !== "qual" || token.neg || token.key !== "is") return token.kind !== "space";
    const value = (token.value ?? "").toLowerCase();
    return !KIND_VALUES.has(value) || value === kind;
  });
  return `${kept.map((token) => token.text).join(" ")} `;
}

export function sortOf(kind: GitHubKind, query: string): string {
  const valid = sortKeysFor(kind);
  let sort = kind === "run" ? DEFAULT_RUN_SORT : DEFAULT_REMOTE_SORT;
  for (const token of tokenize(query)) {
    const value = (token.value ?? "").toLowerCase();
    if (token.kind === "qual" && !token.neg && token.key === "sort" && valid.includes(value)) sort = value;
  }
  return sort;
}

export function currentViewOf(views: GitHubView[], viewId: string | null): GitHubView | null {
  return viewId === null ? null : (views.find((view) => view.id === viewId) ?? null);
}

export function isViewEdited(view: GitHubView | null, query: string): boolean {
  return view === null || normalizeQuery(view.query) !== normalizeQuery(query);
}

export interface SuggestionInputs {
  viewer: string | null;
  prs: PrSummary[];
  issues: IssueSummary[];
  runs: WorkflowRunSummary[];
  repos: ProjectGitHubRepo[];
}

const GITHUB_HOST = "github.com";

export function githubProjectRepos(repos: ProjectGitHubRepo[]): ProjectGitHubRepo[] {
  return repos.filter((repo) => repo.host.toLowerCase() === GITHUB_HOST);
}

export function buildSuggestionSource({ viewer, prs, issues, runs, repos }: SuggestionInputs): SuggestionSource {
  const people = new Set<string>();
  const repoNames = new Set<string>();
  const labels = new Set<string>();
  const milestones = new Set<string>();
  const workflows = new Set<string>();
  const branches = new Set<string>();
  const addPerson = (login: string | null | undefined) => {
    if (login) people.add(login);
  };

  for (const repo of repos) repoNames.add(repoNameOf(repo));
  for (const pr of prs) {
    addPerson(pr.author.login);
    pr.assignees.forEach(addPerson);
    pr.reviewers.forEach((reviewer) => addPerson(reviewer.login));
    pr.labels.forEach((label) => labels.add(label));
    repoNames.add(repoNameOf(pr.ref));
  }
  for (const issue of issues) {
    addPerson(issue.author.login);
    issue.assignees.forEach(addPerson);
    issue.labels.forEach((label) => labels.add(label));
    if (issue.milestone) milestones.add(issue.milestone);
    repoNames.add(repoNameOf(issue.ref));
  }
  for (const run of runs) {
    addPerson(run.actor);
    workflows.add(run.workflowName);
    if (run.branch) branches.add(run.branch);
    repoNames.add(repoNameOf(run.ref));
  }

  const names = [...repoNames];
  return {
    viewer,
    people: [...people],
    repos: names,
    orgs: [...new Set(names.map((name) => name.split("/")[0]))],
    labels: [...labels],
    milestones: [...milestones],
    workflows: [...workflows],
    branches: [...branches]
  };
}
