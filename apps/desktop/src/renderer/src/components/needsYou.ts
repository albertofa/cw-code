import type { PrUpdate, PrUpdateKind } from "@cw-code/contracts";
import type { ApprovalRequest, PrDetail, PrSummary, QuestionRequest, Session } from "../cw.js";
import { prKey } from "./prInbox.js";
import { hasUnseen, updatesSince } from "./prUpdates.js";
import { sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export type AttentionKind = "approval" | "question" | "update";

export interface Attention {
  kind: AttentionKind;
  line: string;
}

export interface UnseenPr {
  number: number;
  summary?: PrSummary;
  updates?: PrUpdate[];
}

export const ATTENTION_RANK: Record<AttentionKind, number> = { approval: 0, question: 1, update: 2 };

const INPUT_FALLBACK = "Waiting for your input";
const APPROVAL_FALLBACK = "Approval needed";
const MAX_UPDATE_PARTS = 2;

const UPDATE_ORDER: PrUpdateKind[] = ["checks_failed", "review", "review_requested", "comment", "commits", "checks_passed"];

function firstLine(text: string | undefined): string {
  return (
    text
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function approvalLine(request: ApprovalRequest): string {
  return firstLine(request.title) || firstLine(request.details) || firstLine(request.reason) || APPROVAL_FALLBACK;
}

function questionLine(request: QuestionRequest): string {
  const first = request.questions[0];
  return firstLine(first?.question) || firstLine(first?.header) || INPUT_FALLBACK;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function failingChecks(summary: PrSummary | undefined): string {
  const failed = summary?.checks.failed ?? 0;
  return failed > 0 ? `${plural(failed, "check")} failing` : "checks failing";
}

function updatePart(kind: PrUpdateKind, count: number, summary: PrSummary | undefined): string {
  switch (kind) {
    case "checks_failed":
      return failingChecks(summary);
    case "review":
      return `${count} new ${count === 1 ? "review" : "reviews"}`;
    case "review_requested":
      return "review requested";
    case "comment":
      return `${count} new ${count === 1 ? "comment" : "comments"}`;
    case "commits":
      return "new commits";
    case "checks_passed":
      return "checks passed";
  }
}

function updateParts(unseen: UnseenPr): string[] {
  const updates = unseen.updates ?? [];
  if (updates.length === 0) {
    if (unseen.summary?.ci === "failing") return [failingChecks(unseen.summary)];
    if (unseen.summary?.review === "changes_requested") return ["changes requested"];
    return [];
  }
  const counts = new Map<PrUpdateKind, number>();
  for (const update of updates) counts.set(update.kind, (counts.get(update.kind) ?? 0) + 1);
  return UPDATE_ORDER.filter((kind) => counts.has(kind)).map((kind) => updatePart(kind, counts.get(kind) ?? 0, unseen.summary));
}

function updateLine(unseen: UnseenPr): string {
  const parts = updateParts(unseen).slice(0, MAX_UPDATE_PARTS);
  return parts.length > 0 ? `#${unseen.number} · ${parts.join(" · ")}` : `#${unseen.number} updated`;
}

export function firstUnseenPr(
  session: Session,
  summaryByKey: PrSummaryLookup,
  detailByKey: Record<string, PrDetail>
): UnseenPr | null {
  for (const link of sessionLinks(session)) {
    const key = prKey(link.ref);
    const summary = summaryByKey.get(key);
    if (!summary || !hasUnseen(summary, link)) continue;
    const detail = detailByKey[key];
    return { number: link.ref.number, summary, updates: detail ? updatesSince(detail, link) : undefined };
  }
  return null;
}

export function sessionAttention(input: {
  session: Session;
  approvals: ApprovalRequest[] | undefined;
  questions: QuestionRequest[] | undefined;
  unseenPr: UnseenPr | null;
}): Attention | null {
  const { session, approvals, questions, unseenPr } = input;
  if (session.status === "resolved" || session.status === "archived") return null;
  if (approvals && approvals.length > 0) return { kind: "approval", line: approvalLine(approvals[0]) };
  if (questions && questions.length > 0) return { kind: "question", line: questionLine(questions[0]) };
  if (session.status === "input-required") return { kind: "question", line: INPUT_FALLBACK };
  if (unseenPr) return { kind: "update", line: updateLine(unseenPr) };
  return null;
}

export function compareNeedsYou(
  a: { attention: Attention; updatedAt: number },
  b: { attention: Attention; updatedAt: number }
): number {
  const rank = ATTENTION_RANK[a.attention.kind] - ATTENTION_RANK[b.attention.kind];
  if (rank !== 0) return rank;
  return b.updatedAt - a.updatedAt;
}

export function needsYouCount(sessions: Session[], attentionOf: (session: Session) => Attention | null): number {
  return sessions.filter((session) => attentionOf(session) !== null).length;
}
