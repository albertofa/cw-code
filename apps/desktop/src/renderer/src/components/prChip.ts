import type { GitPullRequest, PrSummary } from "../cw.js";

export type PrChipTone = "bad" | "ok" | "info" | "warn" | "neutral";

export type PrChipIcon = "x" | "message" | "check" | "draft" | "eye" | "clock" | "merge" | "pr";

export interface PrChip {
  tone: PrChipTone;
  icon: PrChipIcon;
  label: string;
  reason: string;
  title: string;
}

interface PrChipFacts {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  failing: boolean;
  pending: boolean;
  changesRequested: boolean;
  approved: boolean;
  reviewRequested: boolean;
}

function summaryFacts(pr: PrSummary): PrChipFacts {
  return {
    number: pr.ref.number,
    state: pr.state,
    isDraft: pr.isDraft,
    failing: pr.ci === "failing",
    pending: pr.ci === "pending",
    changesRequested: pr.review === "changes_requested",
    approved: pr.review === "approved",
    reviewRequested: !pr.viewerIsAuthor && pr.reviewRequestedFromViewer
  };
}

function gitFacts(pr: GitPullRequest): PrChipFacts {
  return {
    number: pr.number,
    state: pr.state,
    isDraft: pr.isDraft,
    failing: pr.checks.failed > 0,
    pending: pr.checks.pending > 0,
    changesRequested: pr.reviewDecision === "CHANGES_REQUESTED",
    approved: pr.reviewDecision === "APPROVED",
    reviewRequested: false
  };
}

function classify(facts: PrChipFacts): { tone: PrChipTone; icon: PrChipIcon; reason: string } {
  if (facts.state === "MERGED") return { tone: "neutral", icon: "merge", reason: "merged" };
  if (facts.state === "CLOSED") return { tone: "neutral", icon: "x", reason: "closed" };
  if (facts.failing) return { tone: "bad", icon: "x", reason: "checks failing" };
  if (facts.changesRequested) return { tone: "bad", icon: "message", reason: "changes requested" };
  if (facts.approved) return { tone: "ok", icon: "check", reason: "approved" };
  if (facts.isDraft) return { tone: "neutral", icon: "draft", reason: "draft" };
  if (facts.reviewRequested) return { tone: "info", icon: "eye", reason: "review requested" };
  if (facts.pending) return { tone: "warn", icon: "clock", reason: "checks pending" };
  return { tone: "warn", icon: "clock", reason: "awaiting review" };
}

export function prChip(input: { pr: PrSummary | null; git: GitPullRequest | null }): PrChip | null {
  const facts = input.pr ? summaryFacts(input.pr) : input.git ? gitFacts(input.git) : null;
  if (!facts) return null;
  const { tone, icon, reason } = classify(facts);
  return { tone, icon, label: `#${facts.number}`, reason, title: `PR #${facts.number} · ${reason}` };
}
