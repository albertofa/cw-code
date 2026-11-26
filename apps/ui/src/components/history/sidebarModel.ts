import type { HistoryLog, HistoryRef, HistoryWorktree, PrCiState, PrRef, PrSummary, SessionRow, SessionStatus } from "@cw-code/contracts";
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
}

export interface SidebarInput {
  log: HistoryLog | null;
  rows: readonly SessionRow[];
  projectId: string | null;
  sessionId: string | null;
  homePath: string | null;
  openPrs: readonly PrSummary[];
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
  stashes: []
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
  summaries: ReadonlyMap<string, PrSummary>
): SidebarPr[] {
  const openByKey = new Map(openPrs.map((pr) => [dedupeKey(pr.ref), pr]));
  const seen = new Set<string>();
  const result: SidebarPr[] = [];
  const ordered = [...sessions].sort((a, b) => Number(b.session.id === sessionId) - Number(a.session.id === sessionId));
  for (const row of ordered) {
    for (const link of row.session.prs ?? []) {
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
  const matches = prs.filter((pr) => pr.headRefName !== null && names.has(pr.headRefName));
  return matches.find((pr) => pr.state === "OPEN") ?? matches[0] ?? null;
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
  return {
    sessions,
    prs: unionPrs(sessions, input.sessionId, input.openPrs, input.summaries),
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
      .map((ref) => ({ ref, subject: subjects.get(ref.target) ?? "" }))
  };
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
    stashes: model.stashes.filter((stash) => hit(stash.ref.name, stash.subject))
  };
}

export function sectionCounts(model: SidebarModel): Record<SidebarCountedSection, number> {
  return {
    sessions: model.sessions.length,
    prs: model.prs.length,
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
