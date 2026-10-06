import { describe, expect, it } from "vitest";
import type { PrDetail, PrRef, PrSummary, PrTimelineItem, PrUpdate, SessionPrLink } from "@cw-code/contracts";
import type { ApprovalRequest, QuestionRequest, Session, SessionStatus } from "../cw.js";
import { prKey } from "./prInbox.js";
import {
  compareNeedsYou,
  firstUnseenPr,
  NEEDS_YOU_RANK,
  needsYouCount,
  needsYouEntries,
  needsYouEntry,
  sessionAttention,
  unseenPrsNeedingDetail,
  type Attention
} from "./needsYou.js";

function detail(pr: PrSummary, timeline: PrTimelineItem[]): PrDetail {
  return {
    ...pr,
    body: "",
    createdAt: 0,
    timeline,
    threads: [],
    checkRuns: [],
    commits: [],
    reviewers: [],
    viewerLogin: "me"
  };
}

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

  it("skips a PR whose current detail only holds the viewer's own activity", () => {
    const changed = summary(1, { updatedAt: 2_000 });
    const ownApproval = detail(changed, [{ kind: "review", at: 2_000, actor: "me", state: "APPROVED", body: "", threadIds: [] }]);
    const lookup = new Map([[prKey(changed.ref), changed]]);
    expect(firstUnseenPr(session("idle", { prs: [link(1)] }), lookup, { [prKey(changed.ref)]: ownApproval })).toBeNull();
  });

  it("keeps flagging while the loaded detail is older than the summary", () => {
    const changed = summary(1, { updatedAt: 3_000 });
    const stale = detail({ ...changed, updatedAt: 2_000 }, []);
    const lookup = new Map([[prKey(changed.ref), changed]]);
    const result = firstUnseenPr(session("idle", { prs: [link(1)] }), lookup, { [prKey(changed.ref)]: stale });
    expect(result?.number).toBe(1);
  });

  it("flags a PR whose current detail has someone else's activity", () => {
    const changed = summary(1, { updatedAt: 2_000 });
    const comment = detail(changed, [{ kind: "comment", at: 2_000, actor: "rcosta", body: "" }]);
    const lookup = new Map([[prKey(changed.ref), changed]]);
    const result = firstUnseenPr(session("idle", { prs: [link(1)] }), lookup, { [prKey(changed.ref)]: comment });
    expect(result?.updates?.map((u) => u.kind)).toEqual(["comment"]);
  });
});

describe("unseenPrsNeedingDetail", () => {
  const link = (number: number): SessionPrLink => ({ ref: ref(number), origin: "linked", lastSeenSha: `sha-${number}`, lastSeenAt: 1_000 });

  it("lists unseen PRs of open sessions that lack a current detail, once each", () => {
    const missing = summary(1, { updatedAt: 2_000 });
    const stale = summary(2, { updatedAt: 3_000 });
    const current = summary(3, { updatedAt: 2_000 });
    const seen = summary(4, { updatedAt: 500 });
    const lookup = new Map([missing, stale, current, seen].map((item) => [prKey(item.ref), item]));
    const details = { [prKey(stale.ref)]: detail({ ...stale, updatedAt: 2_000 }, []), [prKey(current.ref)]: detail(current, []) };
    const sessions = [
      session("idle", { id: "a", prs: [link(1), link(2), link(3), link(4)] }),
      session("holding", { id: "b", prs: [link(1)] }),
      session("resolved", { id: "c", prs: [link(5)] })
    ];
    lookup.set(prKey(ref(5)), summary(5, { updatedAt: 2_000 }));
    expect(unseenPrsNeedingDetail(sessions, lookup, details).map((pr) => pr.ref.number)).toEqual([1, 2]);
  });
});

describe("needsYouEntry", () => {
  it("prefers the attention over the status", () => {
    const attention: Attention = { kind: "approval", line: "x" };
    expect(needsYouEntry(session("working"), attention)?.slot).toBe("approval");
  });

  it("holds running sessions and turns that ended unseen", () => {
    expect(needsYouEntry(session("working"), null)?.slot).toBe("running");
    expect(needsYouEntry(session("done"), null)?.slot).toBe("done");
  });

  it("leaves out seen, idle, resolved and archived sessions", () => {
    for (const status of ["holding", "idle", "resolved", "archived"] as SessionStatus[]) {
      expect(needsYouEntry(session(status), null)).toBeNull();
    }
  });
});

describe("compareNeedsYou", () => {
  it("ranks approval, question, done, update, running", () => {
    expect(NEEDS_YOU_RANK).toEqual({ approval: 0, question: 1, done: 2, update: 3, running: 4 });
  });

  it("orders by slot, then most recent first", () => {
    const item = (status: SessionStatus, updatedAt: number, kind?: Attention["kind"]) =>
      needsYouEntry(session(status, { id: `${kind ?? status}:${updatedAt}`, updatedAt }), kind ? { kind, line: "" } : null)!;
    const sorted = [
      item("working", 9),
      item("idle", 9, "update"),
      item("done", 1),
      item("idle", 1, "question"),
      item("idle", 1, "approval"),
      item("idle", 5, "question"),
      item("done", 7)
    ].sort(compareNeedsYou);
    expect(sorted.map((s) => s.session.id)).toEqual(["approval:1", "question:5", "question:1", "done:7", "done:1", "update:9", "working:9"]);
  });
});

describe("needsYouEntries", () => {
  it("keeps only sessions that need the user, sorted", () => {
    const sessions = [session("working", { id: "run" }), session("holding", { id: "seen" }), session("done", { id: "ended" })];
    expect(needsYouEntries(sessions, () => null).map((entry) => entry.session.id)).toEqual(["ended", "run"]);
  });
});

describe("needsYouCount", () => {
  it("counts sessions waiting on the user, not running ones", () => {
    const sessions = [
      session("working", { id: "a" }),
      session("idle", { id: "b" }),
      session("resolved", { id: "c" }),
      session("done", { id: "d" }),
      session("working", { id: "e" })
    ];
    const attentionOf = (s: Session): Attention | null => (s.id === "a" || s.id === "b" ? { kind: "update", line: "" } : null);
    expect(needsYouCount(sessions, attentionOf)).toBe(3);
    expect(needsYouCount([], attentionOf)).toBe(0);
  });
});
