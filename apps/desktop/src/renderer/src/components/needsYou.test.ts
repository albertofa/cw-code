import { describe, expect, it } from "vitest";
import type { PrRef, PrSummary, PrUpdate, SessionPrLink } from "@cw-code/contracts";
import type { ApprovalRequest, QuestionRequest, Session, SessionStatus } from "../cw.js";
import { prKey } from "./prInbox.js";
import {
  ATTENTION_RANK,
  compareNeedsYou,
  firstUnseenPr,
  needsYouCount,
  sessionAttention,
  type Attention
} from "./needsYou.js";

function session(status: SessionStatus, overrides: Partial<Session> = {}): Session {
  return {
    id: "s",
    projectId: "p",
    driver: "claude",
    title: "Session",
    status,
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { requestId: "a1", kind: "command", title: "Run dotnet test", decisions: ["accept", "decline"], ...overrides };
}

function question(text: string): QuestionRequest {
  return {
    requestId: "q1",
    turnId: "t1",
    questions: [{ question: text, options: [], multiSelect: false, allowCustom: true }]
  };
}

function ref(number: number): PrRef {
  return { host: "github.com", owner: "acme", repo: "widgets", number };
}

function summary(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: ref(number),
    url: `https://github.com/acme/widgets/pull/${number}`,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "mbarros", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: `feature/${number}`,
    headRefOid: `sha-${number}`,
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "none",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    labels: [],
    updatedAt: 500,
    ...overrides
  };
}

function update(kind: PrUpdate["kind"]): PrUpdate {
  return { kind, at: 1, actor: null, summary: kind };
}

const noAttention = { approvals: undefined, questions: undefined, unseenPr: null };

describe("sessionAttention", () => {
  it("prioritises approval over question over update", () => {
    const unseenPr = { number: 7 };
    const all = { approvals: [approval()], questions: [question("Which branch?")], unseenPr };
    expect(sessionAttention({ session: session("working"), ...all })?.kind).toBe("approval");
    expect(sessionAttention({ session: session("working"), ...all, approvals: [] })?.kind).toBe("question");
    expect(sessionAttention({ session: session("idle"), ...all, approvals: [], questions: [] })?.kind).toBe("update");
  });

  it("keeps input-required as a question even when a linked PR has unseen changes", () => {
    const attention = sessionAttention({
      session: session("input-required"),
      ...noAttention,
      unseenPr: { number: 7 }
    });
    expect(attention).toEqual({ kind: "question", line: "Waiting for your input" });
  });

  it("uses the first line of the approval title, then its details or reason", () => {
    const line = (request: ApprovalRequest) =>
      sessionAttention({ session: session("working"), ...noAttention, approvals: [request] })?.line;
    expect(line(approval({ title: "  Run dotnet test\nsecond line" }))).toBe("Run dotnet test");
    expect(line(approval({ title: "", details: "\n  npm run build\nmore" }))).toBe("npm run build");
    expect(line(approval({ title: "", reason: "needs network" }))).toBe("needs network");
    expect(line(approval({ title: "" }))).toBe("Approval needed");
  });

  it("uses the first question text", () => {
    const attention = sessionAttention({
      session: session("input-required"),
      ...noAttention,
      questions: [question("Which base branch?"), question("Second?")]
    });
    expect(attention).toEqual({ kind: "question", line: "Which base branch?" });
  });

  it("falls back to a waiting line for input-required with no pending request", () => {
    expect(sessionAttention({ session: session("input-required"), ...noAttention })).toEqual({
      kind: "question",
      line: "Waiting for your input"
    });
    expect(sessionAttention({ session: session("input-required"), ...noAttention, approvals: [], questions: [] })?.kind).toBe(
      "question"
    );
  });

  it("builds the update line from the updates and the summary", () => {
    const line = (unseenPr: Parameters<typeof sessionAttention>[0]["unseenPr"]) =>
      sessionAttention({ session: session("idle"), ...noAttention, unseenPr })?.line;
    expect(
      line({
        number: 118,
        summary: summary(118, { ci: "failing", checks: { total: 5, passed: 3, failed: 2, pending: 0 } }),
        updates: [update("review"), update("checks_failed")]
      })
    ).toBe("#118 · 2 checks failing · 1 new review");
    expect(line({ number: 5, updates: [update("comment"), update("comment"), update("commits")] })).toBe(
      "#5 · 2 new comments · new commits"
    );
    expect(
      line({ number: 9, updates: [update("checks_failed"), update("review"), update("comment"), update("commits")] })
    ).toBe("#9 · checks failing · 1 new review");
  });

  it("derives the update line from the summary when no updates are loaded", () => {
    const line = (unseenPr: Parameters<typeof sessionAttention>[0]["unseenPr"]) =>
      sessionAttention({ session: session("idle"), ...noAttention, unseenPr })?.line;
    expect(
      line({ number: 3, summary: summary(3, { ci: "failing", checks: { total: 2, passed: 1, failed: 1, pending: 0 } }) })
    ).toBe("#3 · 1 check failing");
    expect(line({ number: 3, summary: summary(3, { review: "changes_requested" }) })).toBe("#3 · changes requested");
    expect(line({ number: 3, summary: summary(3) })).toBe("#3 updated");
    expect(line({ number: 3 })).toBe("#3 updated");
    expect(line({ number: 3, updates: [] })).toBe("#3 updated");
  });

  it("never flags resolved or archived sessions", () => {
    const full = { approvals: [approval()], questions: [question("Q?")], unseenPr: { number: 1 } };
    expect(sessionAttention({ session: session("resolved"), ...full })).toBeNull();
    expect(sessionAttention({ session: session("archived"), ...full })).toBeNull();
  });

  it("returns null when nothing needs the user", () => {
    for (const status of ["idle", "working", "done", "holding"] as SessionStatus[]) {
      expect(sessionAttention({ session: session(status), ...noAttention })).toBeNull();
    }
  });
});

describe("firstUnseenPr", () => {
  const link = (number: number, overrides: Partial<SessionPrLink> = {}): SessionPrLink => ({
    ref: ref(number),
    origin: "linked",
    lastSeenSha: `sha-${number}`,
    lastSeenAt: 1_000,
    ...overrides
  });

  it("returns the first linked PR that changed since it was seen", () => {
    const seen = summary(1, { updatedAt: 500 });
    const changed = summary(2, { updatedAt: 2_000 });
    const lookup = new Map([seen, changed].map((item) => [prKey(item.ref), item]));
    const result = firstUnseenPr(session("idle", { prs: [link(1), link(2)] }), lookup, {});
    expect(result).toEqual({ number: 2, summary: changed, updates: undefined });
  });

  it("returns null when every linked PR is seen or unknown", () => {
    const lookup = new Map([[prKey(ref(1)), summary(1, { updatedAt: 500 })]]);
    expect(firstUnseenPr(session("idle", { prs: [link(1), link(2)] }), lookup, {})).toBeNull();
    expect(firstUnseenPr(session("idle"), lookup, {})).toBeNull();
  });
});

describe("compareNeedsYou", () => {
  const item = (kind: Attention["kind"], updatedAt: number) => ({ attention: { kind, line: "" }, updatedAt });

  it("has rank 0, 1, 2 for approval, question, update", () => {
    expect(ATTENTION_RANK).toEqual({ approval: 0, question: 1, update: 2 });
  });

  it("orders by kind, then most recent first", () => {
    const sorted = [item("update", 9), item("question", 1), item("approval", 1), item("question", 5), item("approval", 8)].sort(
      compareNeedsYou
    );
    expect(sorted.map((s) => `${s.attention.kind}:${s.updatedAt}`)).toEqual([
      "approval:8",
      "approval:1",
      "question:5",
      "question:1",
      "update:9"
    ]);
  });
});

describe("needsYouCount", () => {
  it("counts the sessions that have an attention", () => {
    const sessions = [session("working", { id: "a" }), session("idle", { id: "b" }), session("resolved", { id: "c" })];
    const attentionOf = (s: Session): Attention | null => (s.id === "c" ? null : { kind: "update", line: "" });
    expect(needsYouCount(sessions, attentionOf)).toBe(2);
    expect(needsYouCount([], attentionOf)).toBe(0);
  });
});
