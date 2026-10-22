import type { GitPullRequest } from "@cw-code/contracts";
import { ciFromRollup } from "../github/prParsers.js";

export interface BranchPullRequestCandidate extends GitPullRequest {
  headOwner: string | null;
}

interface GhCheck {
  conclusion?: string;
  status?: string;
  state?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function epochMs(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function headOwnerOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" && login ? login : null;
}

function parseCandidate(value: unknown): BranchPullRequestCandidate | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const number = typeof raw.number === "number" && Number.isSafeInteger(raw.number) ? raw.number : 0;
  const url = text(raw.url);
  if (number <= 0 || !url) return null;
  const rollup = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup as GhCheck[] : [];
  const { checks } = ciFromRollup(rollup.map((check) => check?.conclusion || check?.state || check?.status || ""));
  const state = raw.state === "MERGED" || raw.state === "CLOSED" ? raw.state : "OPEN";
  return {
    number,
    title: text(raw.title) || `Pull request #${number}`,
    url,
    state,
    isDraft: raw.isDraft === true,
    reviewDecision: text(raw.reviewDecision) || null,
    mergeStateStatus: text(raw.mergeStateStatus) || null,
    headRefName: text(raw.headRefName),
    baseRefName: text(raw.baseRefName),
    headRefOid: text(raw.headRefOid),
    updatedAt: epochMs(raw.updatedAt),
    checks,
    headOwner: headOwnerOf(raw.headRepositoryOwner)
  };
}

export function parsePullRequestList(stdout: string): BranchPullRequestCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parseCandidate).filter((candidate): candidate is BranchPullRequestCandidate => candidate !== null);
}

function newest(candidates: BranchPullRequestCandidate[]): BranchPullRequestCandidate | null {
  return candidates.reduce<BranchPullRequestCandidate | null>((best, item) => (!best || item.updatedAt > best.updatedAt ? item : best), null);
}

function withoutHeadOwner({ headOwner: _headOwner, ...pullRequest }: BranchPullRequestCandidate): GitPullRequest {
  return pullRequest;
}

export function pickBranchPullRequest(
  candidates: BranchPullRequestCandidate[],
  target: { branch: string; headSha: string | null; owner: string | null }
): GitPullRequest | null {
  const owner = target.owner?.toLowerCase() || null;
  const matching = candidates.filter((candidate) =>
    candidate.headRefName === target.branch && (!owner || !candidate.headOwner || candidate.headOwner.toLowerCase() === owner)
  );
  const open = newest(matching.filter((candidate) => candidate.state === "OPEN"));
  if (open) return withoutHeadOwner(open);
  if (!target.headSha) return null;
  const finished = newest(matching.filter((candidate) => candidate.state !== "OPEN" && candidate.headRefOid === target.headSha));
  return finished ? withoutHeadOwner(finished) : null;
}

export function pickComparisonBase(candidates: { requested: string | null; requestedExists: boolean; defaultBase: string | null; fallback: string | null }): string | null {
  if (candidates.requested && candidates.requestedExists) return candidates.requested;
  return candidates.defaultBase || candidates.fallback || null;
}
