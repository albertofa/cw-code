import type { HistoryLog, HistoryRef, HistoryWorktree, PrCiState, PrRef, PrSummary, SessionMeta, SessionRow, SessionStatus } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { remoteBranchName } from "./refLabel.js";

export type SidebarSectionId = "session" | "sessions" | "prs" | "branches" | "worktrees" | "tags" | "stashes";

export type SidebarCountedSection = Exclude<SidebarSectionId, "session">;

export interface SidebarPr {
  key: string;
  ref: PrRef;
  title: string | null;
  url: string | null;
  state: PrSummary["state"] | null;
  isDraft: boolean;
  ci: PrCiState | null;
  headRefName: string | null;
  baseRefName: string | null;
  headRefOid: string | null;
  sessionId: string | null;
  sessionTitle: string | null;
  linkedHere: boolean;
}

export interface SidebarWorktree {
  worktree: HistoryWorktree;
  owner: SessionRow | null;
  isHome: boolean;
}

export interface SidebarStash {
  ref: HistoryRef;
  subject: string;
}

export interface SidebarModel {
  sessions: SessionRow[];
  prs: SidebarPr[];
  branches: HistoryRef[];
  remoteBranches: HistoryRef[];
  worktrees: SidebarWorktree[];
  tags: HistoryRef[];
  stashes: SidebarStash[];
  hiddenOpenPrs: number;
}

export interface RemoteGroup {
  remote: string;
  refs: HistoryRef[];
}

export type GitHubRepo = { owner: string; repo: string };

export interface SidebarInput {
  log: HistoryLog | null;
  rows: readonly SessionRow[];
  projectId: string | null;
  sessionId: string | null;
  homePath: string | null;
  openPrs: readonly PrSummary[];
  openCount: number | null;
  summaries: ReadonlyMap<string, PrSummary>;
}

const HIDDEN_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["resolved", "archived"]);

export const EMPTY_SIDEBAR_MODEL: SidebarModel = {
  sessions: [],
  prs: [],
  branches: [],
  remoteBranches: [],
  worktrees: [],
  tags: [],
  stashes: [],
  hiddenOpenPrs: 0
};

export function projectSessions(rows: readonly SessionRow[], projectId: string | null, sessionId: string | null): SessionRow[] {
  if (projectId === null) return [];
  return rows
    .filter((row) => row.session.projectId === projectId && !row.session.subagent && !HIDDEN_STATUSES.has(row.session.status))
    .sort((a, b) => Number(b.session.id === sessionId) - Number(a.session.id === sessionId) || b.session.updatedAt - a.session.updatedAt);
}

export function groupBranches(refs: readonly HistoryRef[]): { local: HistoryRef[]; remoteOnly: HistoryRef[] } {
  const local = refs
    .filter((ref) => ref.kind === "local")
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name));
  const localNames = new Set(local.map((ref) => ref.name));
  const upstreams = new Set(local.flatMap((ref) => (ref.upstream ? [ref.upstream] : [])));
  const remoteOnly = refs
    .filter((ref) => ref.kind === "remote" && !upstreams.has(ref.name) && !localNames.has(remoteBranchName(ref.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { local, remoteOnly };
}

export function remoteGroups(remoteOnly: readonly HistoryRef[]): RemoteGroup[] {
  const groups = new Map<string, HistoryRef[]>();
  for (const ref of remoteOnly) {
    const slash = ref.name.indexOf("/");
    const remote = slash === -1 ? ref.name : ref.name.slice(0, slash);
    const list = groups.get(remote);
    if (list) list.push(ref);
    else groups.set(remote, [ref]);
  }
  return [...groups]
    .sort(([a], [b]) => Number(b === "origin") - Number(a === "origin") || a.localeCompare(b))
    .map(([remote, refs]) => ({ remote, refs }));
}

function comparablePath(path: string): string {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(unified) ? unified.toLowerCase() : unified;
}

export function sessionCheckout(worktrees: readonly HistoryWorktree[], session: Pick<SessionMeta, "worktreePath">): HistoryWorktree | null {
  if (!session.worktreePath) return worktrees.find((worktree) => worktree.isMain) ?? null;
  const target = comparablePath(session.worktreePath);
  return worktrees.find((worktree) => comparablePath(worktree.path) === target) ?? null;
}

function inRepo(ref: PrRef, repo: GitHubRepo | null): boolean {
  return repo === null || (ref.owner.toLowerCase() === repo.owner.toLowerCase() && ref.repo.toLowerCase() === repo.repo.toLowerCase());
}

function dedupeKey(ref: PrRef): string {
  return prKey(ref).toLowerCase();
}

function sidebarPr(ref: PrRef, summary: PrSummary | undefined, owner: SessionRow | null, sessionId: string | null): SidebarPr {
  return {
    key: prKey(ref),
    ref,
    title: summary?.title ?? null,
    url: summary?.url ?? null,
    state: summary?.state ?? null,
    isDraft: summary?.isDraft ?? false,
    ci: summary?.ci ?? null,
    headRefName: summary?.headRefName ?? null,
    baseRefName: summary?.baseRefName ?? null,
    headRefOid: summary?.headRefOid ?? null,
    sessionId: owner?.session.id ?? null,
    sessionTitle: owner?.session.title ?? null,
    linkedHere: owner !== null && owner.session.id === sessionId
  };
}

export function sidebarPrOf(ref: PrRef): SidebarPr {
  return sidebarPr(ref, undefined, null, null);
}

export type PrTone = "merged" | "closed" | "draft" | "bad" | "warn" | "ok" | "neutral";

export function prTone(pr: Pick<SidebarPr, "state" | "isDraft" | "ci">): PrTone {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  if (pr.ci === "failing") return "bad";
  if (pr.ci === "pending") return "warn";
  if (pr.ci === "passing") return "ok";
  return "neutral";
}

export function unionPrs(
  sessions: readonly SessionRow[],
  sessionId: string | null,
  openPrs: readonly PrSummary[],
  summaries: ReadonlyMap<string, PrSummary>,
  repo: GitHubRepo | null = null
): SidebarPr[] {
  const openByKey = new Map(openPrs.map((pr) => [dedupeKey(pr.ref), pr]));
  const seen = new Set<string>();
  const result: SidebarPr[] = [];
  const ordered = [...sessions].sort((a, b) => Number(b.session.id === sessionId) - Number(a.session.id === sessionId));
  for (const row of ordered) {
    for (const link of row.session.prs ?? []) {
      if (!inRepo(link.ref, repo)) continue;
      const key = dedupeKey(link.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(sidebarPr(link.ref, summaries.get(prKey(link.ref)) ?? openByKey.get(key), row, sessionId));
    }
  }
  for (const pr of openPrs) {
    const key = dedupeKey(pr.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(sidebarPr(pr.ref, pr, null, sessionId));
  }
  return result;
}

export function prForBranch(prs: readonly SidebarPr[], ref: HistoryRef): SidebarPr | null {
  const names = new Set<string>();
  if (ref.kind === "remote") names.add(remoteBranchName(ref.name));
  else {
    names.add(ref.name);
    if (ref.upstream) names.add(remoteBranchName(ref.upstream));
  }
  // Summaries carry no head repository, so a fork PR from `contributor:main` would match the local
  // `main`. A PR whose head and base names are equal can only come from another repository, so skip it.
  const matches = prs.filter((pr) => pr.headRefName !== null && pr.headRefName !== pr.baseRefName && names.has(pr.headRefName));
  return matches.find((pr) => pr.state === "OPEN") ?? matches[0] ?? null;
}

export function stashBranch(subject: string): string | null {
  const match = /^(?:WIP on|On) ([^:]+):/.exec(subject);
  return match ? match[1]! : null;
}

export function defaultStash(stashes: readonly SidebarStash[], branch: string | null): SidebarStash | null {
  const own = branch === null ? undefined : stashes.find((stash) => stashBranch(stash.subject) === branch);
  return own ?? stashes[0] ?? null;
}

export function sessionRunningIn(sessions: readonly SessionRow[], worktrees: readonly HistoryWorktree[], path: string | null): SessionRow | null {
  if (path === null) return null;
  const target = comparablePath(path);
  return (
    sessions.find((row) => {
      if (!row.busy) return false;
      const checkout = sessionCheckout(worktrees, row.session);
      return checkout !== null && comparablePath(checkout.path) === target;
    }) ?? null
  );
}

function stashIndex(name: string): number {
  const match = /\{(\d+)\}/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function buildSidebarModel(input: SidebarInput): SidebarModel {
  const { log } = input;
  const sessions = projectSessions(input.rows, input.projectId, input.sessionId);
  const rowsById = new Map(input.rows.map((row) => [row.session.id, row]));
  const refs = log?.refs ?? [];
  const { local, remoteOnly } = groupBranches(refs);
  const subjects = new Map((log?.commits ?? []).map((commit) => [commit.sha, commit.subject]));
  const repo = log?.github ?? null;
  const prs = unionPrs(sessions, input.sessionId, input.openPrs, input.summaries, repo);
  return {
    sessions,
    prs,
    branches: local,
    remoteBranches: remoteOnly,
    worktrees: (log?.worktrees ?? []).map((worktree) => ({
      worktree,
      owner: worktree.sessionId ? (rowsById.get(worktree.sessionId) ?? null) : null,
      isHome: worktree.path === input.homePath
    })),
    tags: refs.filter((ref) => ref.kind === "tag").sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })),
    stashes: refs
      .filter((ref) => ref.kind === "stash")
      .sort((a, b) => stashIndex(a.name) - stashIndex(b.name))
      .map((ref) => ({ ref, subject: subjects.get(ref.target) ?? "" })),
    hiddenOpenPrs: hiddenOpenPrs(prs, input.openPrs, input.openCount)
  };
}

export function hiddenOpenPrs(prs: readonly SidebarPr[], openPrs: readonly PrSummary[], openCount: number | null): number {
  if (openCount === null) return 0;
  const loaded = new Set(openPrs.map((pr) => dedupeKey(pr.ref)));
  const linkedOpenElsewhere = prs.filter((pr) => pr.state === "OPEN" && !loaded.has(dedupeKey(pr.ref))).length;
  return Math.max(0, openCount - loaded.size - linkedOpenElsewhere);
}

export function filterSidebarModel(model: SidebarModel, filter: string): SidebarModel {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return model;
  const hit = (...fields: Array<string | null | undefined>): boolean => fields.some((field) => field?.toLowerCase().includes(needle) ?? false);
  return {
    sessions: model.sessions.filter((row) => hit(row.session.title, row.branch, row.session.branch, row.session.worktreePath)),
    prs: model.prs.filter((pr) => hit(pr.title, `#${pr.ref.number}`, pr.headRefName, pr.sessionTitle)),
    branches: model.branches.filter((ref) => hit(ref.name)),
    remoteBranches: model.remoteBranches.filter((ref) => hit(ref.name)),
    worktrees: model.worktrees.filter((entry) => hit(entry.worktree.name, entry.worktree.branch, entry.worktree.path, entry.owner?.session.title)),
    tags: model.tags.filter((ref) => hit(ref.name)),
    stashes: model.stashes.filter((stash) => hit(stash.ref.name, stash.subject)),
    hiddenOpenPrs: 0
  };
}

export function sectionCounts(model: SidebarModel): Record<SidebarCountedSection, number> {
  return {
    sessions: model.sessions.length,
    prs: model.prs.length + model.hiddenOpenPrs,
    branches: model.branches.length + model.remoteBranches.length,
    worktrees: model.worktrees.length,
    tags: model.tags.length,
    stashes: model.stashes.length
  };
}

export function sessionStatusText(row: SessionRow): string {
  const status = row.session.status;
  if (status === "input-required") return row.attention ? `Needs you · ${row.attention.line}` : "Needs you";
  if (row.busy || status === "working") return "Running a turn";
  if (status === "done") return "Turn finished";
  if (status === "holding") return "Holding";
  if (status === "babysit") return "Watching its pull request";
  if (status === "resolved") return "Resolved";
  if (status === "archived") return "Archived";
  return "Idle";
}

export function sessionDotStatus(row: SessionRow): SessionStatus {
  return row.busy && row.session.status !== "input-required" ? "working" : row.session.status;
}
