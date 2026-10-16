import { describe, expect, it } from "vitest";
import type { PrDetail, PrWorkflow, SessionPrLink } from "@cw-code/contracts";
import {
  AUTO_FOLLOW_UP_LIMIT,
  autoFollowUpRefs,
  autoFollowUps,
  autoFollowUpWorkflow,
  babysitState,
  babysitStatusText,
  defaultFollowUpWorkflowId,
  followUpPrompt,
  followUpWorkflow,
  needsFailedLogs,
  needsRunFailedLogs,
  whyLinkedText,
  type AutoFollowUpSession,
  type BabysitControl,
  type BabysitState
} from "./prSessionModel.js";

function link(overrides: Partial<SessionPrLink> = {}): SessionPrLink {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    origin: "opened",
    lastSeenSha: "old-sha",
    lastSeenAt: 1000,
    ...overrides
  };
}

function workflow(id: string, overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id,
    label: id === "review" ? "Review" : id === "babysit" ? "Babysit" : "Custom",
    description: "",
    icon: "eye",
    builtIn: id === "review" || id === "babysit",
    enabled: true,
    target: "pr",
    suggestWhen: [],
    workspace: "linked",
    startPrompt: "start",
    updatePrompt: `update ${id}`,
    ...overrides
  };
}

function detail(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add widget",
    state: "OPEN",
    isDraft: false,
    author: { login: "mbarros", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: "feature/widget",
    headRefOid: "new-sha",
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "passing",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 2000,
    body: "",
    createdAt: 0,
    timeline: [],
    threads: [],
    checkRuns: [],
    commits: [],
    viewerLogin: "",
    ...overrides
  };
}

const WORKFLOWS = [workflow("review"), workflow("babysit"), workflow("custom")];

describe("followUpWorkflow", () => {
  it("uses the link's own workflow when it exists", () => {
    const target = link({ origin: "workflow", workflowId: "custom" });
    expect(defaultFollowUpWorkflowId(target, { viewerIsAuthor: true })).toBe("custom");
    expect(followUpWorkflow(target, { viewerIsAuthor: true }, WORKFLOWS)?.id).toBe("custom");
  });

  it("falls back to babysit for authored PRs and review for others", () => {
    expect(followUpWorkflow(link({ origin: "opened" }), { viewerIsAuthor: true }, WORKFLOWS)?.id).toBe("babysit");
    expect(followUpWorkflow(link({ origin: "linked" }), { viewerIsAuthor: false }, WORKFLOWS)?.id).toBe("review");
    expect(followUpWorkflow(link({ origin: "linked" }), null, WORKFLOWS)?.id).toBe("babysit");
  });

  it("falls back when the link's workflow was deleted", () => {
    const target = link({ origin: "workflow", workflowId: "gone" });
    expect(followUpWorkflow(target, { viewerIsAuthor: false }, WORKFLOWS)?.id).toBe("review");
    expect(followUpWorkflow(target, { viewerIsAuthor: false }, [])).toBeNull();
  });
});

describe("needsFailedLogs", () => {
  it("detects the failed-logs variable", () => {
    expect(needsFailedLogs("logs:\n{{ checks.failedLogs }}")).toBe(true);
    expect(needsFailedLogs("{{checks.summary}}")).toBe(false);
  });
});

describe("needsRunFailedLogs", () => {
  it("detects the run failed-logs variable", () => {
    expect(needsRunFailedLogs("{{ run.failedLogs }}")).toBe(true);
    expect(needsRunFailedLogs("{{run.failedJobs}} {{checks.failedLogs}}")).toBe(false);
  });
});

describe("followUpPrompt", () => {
  it("resolves the update prompt with the delta, last seen sha, and attribution", () => {
    const wf = workflow("babysit", { updatePrompt: "#{{pr.number}} since {{session.lastSeenSha}}:\n{{pr.delta}}\n{{attribution}}" });
    const updates = [{ kind: "commits" as const, at: 1500, actor: "mbarros", summary: "mbarros pushed 2 commits", actionable: false }];
    const text = followUpPrompt(detail(), link(), wf, updates, { prAttributionEnabled: true, prAttributionText: "via {{harness}}" }, "Claude");
    expect(text).toBe("#42 since old-sha:\nmbarros pushed 2 commits\nvia Claude");
  });

  it("fills failed logs when they are given", () => {
    const wf = workflow("babysit", { updatePrompt: "logs:\n{{checks.failedLogs}}" });
    const text = followUpPrompt(detail(), link(), wf, [], { prAttributionEnabled: false, prAttributionText: "" }, "Claude", "boom");
    expect(text).toBe("logs:\nboom");
  });
});

describe("autoFollowUpWorkflow", () => {
  const auto = workflow("babysit", { autoFollowUp: true });

  it("returns the link's own workflow only when it is enabled, automatic and targets PRs", () => {
    expect(autoFollowUpWorkflow(link({ workflowId: "babysit" }), [auto])?.id).toBe("babysit");
    expect(autoFollowUpWorkflow(link({ workflowId: "babysit" }), [{ ...auto, enabled: false }])).toBeNull();
    expect(autoFollowUpWorkflow(link({ workflowId: "babysit" }), [{ ...auto, autoFollowUp: false }])).toBeNull();
    expect(autoFollowUpWorkflow(link({ workflowId: "babysit" }), [{ ...auto, target: "issue" }])).toBeNull();
  });

  it("does not fall back to babysit for links without a workflow", () => {
    expect(autoFollowUpWorkflow(link({ origin: "opened" }), [auto])).toBeNull();
  });
});

describe("autoFollowUps", () => {
  const workflows = [workflow("babysit", { autoFollowUp: true }), workflow("review")];
  const key = "github.com/acme/widgets#42";
  const failing = detail({
    ci: "failing",
    checkRuns: [{ name: "test", workflow: "ci", status: "failure", url: null, runId: 7, completedAt: 1_500 }]
  });
  const passing = detail({
    ci: "passing",
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    checkRuns: [{ name: "test", workflow: "ci", status: "success", url: null, runId: 7, completedAt: 1_500 }]
  });

  function entry(overrides: Partial<AutoFollowUpSession> = {}, linkOverrides: Partial<SessionPrLink> = {}): AutoFollowUpSession {
    return {
      session: { id: "s1", status: "done", prs: [link({ origin: "workflow", workflowId: "babysit", lastSeenSha: "new-sha", ...linkOverrides })] },
      busy: false,
      waitingOnUser: false,
      paused: false,
      autoTurns: 0,
      ...overrides
    };
  }

  function run(session: AutoFollowUpSession, pr: PrDetail) {
    return autoFollowUps([session], new Map([[key, pr]]), { [key]: pr }, workflows);
  }

  it("sends actionable updates for an idle babysit session", () => {
    const [followUp] = run(entry(), failing);
    expect(followUp).toMatchObject({ sessionId: "s1", workflow: { id: "babysit" } });
    expect(followUp.updates.map((update) => update.kind)).toEqual(["checks_failed"]);
    expect(followUp.signature).toBe(`s1:${key}@new-sha:2000`);
  });

  it("skips updates that are only informational", () => {
    expect(run(entry(), passing)).toEqual([]);
  });

  it("sends once the user has looked at the finished turn", () => {
    expect(run(entry({ session: { ...entry().session, status: "holding" } }), failing)).toHaveLength(1);
  });

  it("waits while the session is busy, needs the user, is paused, is not settled, or hit the limit", () => {
    expect(run(entry({ busy: true }), failing)).toEqual([]);
    expect(run(entry({ waitingOnUser: true }), failing)).toEqual([]);
    expect(run(entry({ paused: true }), failing)).toEqual([]);
    expect(run(entry({ session: { ...entry().session, status: "input-required" } }), failing)).toEqual([]);
    expect(run(entry({ autoTurns: AUTO_FOLLOW_UP_LIMIT }), failing)).toEqual([]);
    expect(run(entry({ autoTurns: AUTO_FOLLOW_UP_LIMIT - 1 }), failing)).toHaveLength(1);
  });

  it("stops once the PR is no longer open", () => {
    expect(run(entry(), { ...failing, state: "MERGED" })).toEqual([]);
  });

  it("skips links that are not on an automatic workflow", () => {
    expect(run(entry({}, { workflowId: "review" }), failing)).toEqual([]);
  });

  it("waits for a fresh detail when the summary is newer", () => {
    const summary = { ...failing, updatedAt: 3_000 };
    expect(autoFollowUps([entry()], new Map([[key, summary]]), { [key]: failing }, workflows)).toEqual([]);
  });
});

describe("babysitState", () => {
  const workflows = [workflow("babysit", { autoFollowUp: true }), workflow("review")];
  const session = { status: "holding" as const, prs: [link({ origin: "opened", workflowId: "babysit" })] };
  const idle: BabysitControl = { busy: false, paused: undefined, autoTurns: 0 };

  it("reports which PR is babysat and whether it is watching, working or paused", () => {
    const phase = (control: Partial<typeof idle>) => babysitState(session, new Map(), workflows, { ...idle, ...control })?.phase;
    expect(babysitState(session, new Map(), workflows, idle)).toMatchObject({ link: { workflowId: "babysit" }, workflow: { id: "babysit" } });
    expect(phase({})).toEqual({ kind: "watching" });
    expect(phase({ busy: true })).toEqual({ kind: "working" });
    expect(phase({ paused: "interrupted", busy: true })).toEqual({ kind: "paused", reason: "interrupted" });
    expect(phase({ autoTurns: AUTO_FOLLOW_UP_LIMIT })).toEqual({ kind: "paused", reason: "limit" });
  });

  it("is off for other workflows, finished PRs and resolved sessions", () => {
    expect(babysitState({ ...session, prs: [link({ workflowId: "review" })] }, new Map(), workflows, idle)).toBeNull();
    expect(babysitState(session, new Map([["github.com/acme/widgets#42", detail({ state: "MERGED" })]]), workflows, idle)).toBeNull();
    expect(babysitState({ ...session, status: "resolved" }, new Map(), workflows, idle)).toBeNull();
  });

  it("describes each phase", () => {
    const text = (phase: BabysitState["phase"]) => babysitStatusText({ link: link(), workflow: workflows[0], phase });
    expect(text({ kind: "watching" })).toBe("Watching for failed checks, change requests and comments");
    expect(text({ kind: "paused", reason: "error" })).toBe("Paused because the last turn failed");
    expect(text({ kind: "paused", reason: "limit" })).toBe(`Paused after ${AUTO_FOLLOW_UP_LIMIT} automatic turns in a row`);
  });
});

describe("autoFollowUpRefs", () => {
  const workflows = [workflow("babysit", { autoFollowUp: true }), workflow("review")];
  const babysitLink = link({ origin: "workflow", workflowId: "babysit" });

  it("watches open PRs linked through an automatic workflow in live sessions", () => {
    const sessions = [
      { status: "done" as const, prs: [babysitLink] },
      { status: "resolved" as const, prs: [link({ origin: "workflow", workflowId: "babysit", ref: { ...babysitLink.ref, number: 7 } })] },
      { status: "idle" as const, prs: [link({ origin: "workflow", workflowId: "review", ref: { ...babysitLink.ref, number: 8 } })] }
    ];
    expect(autoFollowUpRefs(sessions, new Map(), workflows)).toEqual([babysitLink.ref]);
  });

  it("stops watching a PR that is merged", () => {
    const merged = new Map([["github.com/acme/widgets#42", detail({ state: "MERGED" })]]);
    expect(autoFollowUpRefs([{ status: "done", prs: [babysitLink] }], merged, workflows)).toEqual([]);
  });
});

describe("whyLinkedText", () => {
  it("explains each origin", () => {
    expect(whyLinkedText(link({ origin: "opened" }), { headRefName: "feature/widget" }, WORKFLOWS)).toBe(
      "Branch feature/widget is the head of #42"
    );
    expect(whyLinkedText(link({ origin: "workflow", workflowId: "review" }), null, WORKFLOWS)).toBe("Started from the Review workflow");
    expect(whyLinkedText(link({ origin: "workflow", workflowId: "gone" }), null, WORKFLOWS)).toBe("Started from the gone workflow");
    expect(whyLinkedText(link({ origin: "linked" }), null, WORKFLOWS)).toBe("Linked manually");
  });
});
