import { describe, expect, it } from "vitest";
import type { PrDetail, PrWorkflow, SessionPrLink } from "@cw-code/contracts";
import { defaultFollowUpWorkflowId, followUpPrompt, followUpWorkflow, needsFailedLogs, whyLinkedText } from "./prSessionModel.js";

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
    updatedAt: 2000,
    body: "",
    createdAt: 0,
    timeline: [],
    threads: [],
    checkRuns: [],
    commits: [],
    reviewers: [],
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

describe("followUpPrompt", () => {
  it("resolves the update prompt with the delta, last seen sha, and attribution", () => {
    const wf = workflow("babysit", { updatePrompt: "#{{pr.number}} since {{session.lastSeenSha}}:\n{{pr.delta}}\n{{attribution}}" });
    const updates = [{ kind: "commits" as const, at: 1500, actor: "mbarros", summary: "mbarros pushed 2 commits" }];
    const text = followUpPrompt(detail(), link(), wf, updates, { prAttributionEnabled: true, prAttributionText: "via {{harness}}" }, "Claude");
    expect(text).toBe("#42 since old-sha:\nmbarros pushed 2 commits\nvia Claude");
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
