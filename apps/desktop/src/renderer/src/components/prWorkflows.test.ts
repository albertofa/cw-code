import { describe, expect, it } from "vitest";
import type { PrCheck, PrDetail, PrRef, PrSummary, PrWorkflow, SessionMeta } from "@cw-code/contracts";
import { attributionText, loadFailedLogs, primaryAction, resolveTemplate, suggestedWorkflow, templateVars } from "./prWorkflows.js";

function prSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add feature",
    state: "OPEN",
    isDraft: false,
    author: { login: "author", isBot: false },
    viewerIsAuthor: false,
    reviewRequestedFromViewer: false,
    headRefName: "feature",
    headRefOid: "abc123",
    baseRefName: "main",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "passing",
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    labels: [],
    updatedAt: 1000,
    ...overrides
  };
}

function prDetail(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    ...prSummary(),
    body: "PR body",
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

function workflow(overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id: "review",
    label: "Review",
    description: "desc",
    icon: "eye",
    builtIn: true,
    enabled: true,
    suggestWhen: ["review-requested"],
    workspace: "checkout",
    startPrompt: "start",
    updatePrompt: "update",
    ...overrides
  };
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    projectId: "p1",
    driver: "claude",
    title: "Session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

describe("resolveTemplate", () => {
  it("substitutes known vars", () => {
    expect(resolveTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("leaves unknown vars in place", () => {
    expect(resolveTemplate("Hi {{unknown}}", { name: "World" })).toBe("Hi {{unknown}}");
  });

  it("substitutes repeated vars", () => {
    expect(resolveTemplate("{{x}} and {{x}} again", { x: "y" })).toBe("y and y again");
  });
});

describe("templateVars", () => {
  it("formats diff stat, repo, and checks summary", () => {
    const detail = prDetail({
      checkRuns: [
        { name: "test", workflow: "ci", status: "success", url: null, runId: null, completedAt: null },
        { name: "lint", workflow: "ci", status: "failure", url: null, runId: null, completedAt: null }
      ]
    });
    const vars = templateVars(detail, { attribution: "att", harness: "Claude" });
    expect(vars["pr.repo"]).toBe("acme/widgets");
    expect(vars["pr.diffStat"]).toBe("+10 −2, 3 files");
    expect(vars["checks.summary"]).toBe("1 passed, 1 failing (lint)");
    expect(vars.attribution).toBe("att");
    expect(vars.harness).toBe("Claude");
  });

  it("formats unresolved threads separately from all threads", () => {
    const detail = prDetail({
      threads: [
        { id: "t1", path: "a.ts", line: 5, isResolved: true, diffHunk: "", comments: [{ author: "bob", body: "ok", createdAt: 0 }] },
        { id: "t2", path: "b.ts", line: 9, isResolved: false, diffHunk: "", comments: [{ author: "amy", body: "fix this", createdAt: 0 }] }
      ]
    });
    const vars = templateVars(detail, { attribution: "", harness: "" });
    expect(vars["pr.threads"]).toBe("- a.ts:5 — bob: ok\n- b.ts:9 — amy: fix this");
    expect(vars["pr.unresolvedThreads"]).toBe("- b.ts:9 — amy: fix this");
  });
});

describe("attributionText", () => {
  it("is empty when disabled", () => {
    expect(attributionText({ prAttributionEnabled: false, prAttributionText: "— {{harness}}" }, "Claude")).toBe("");
  });

  it("resolves harness when enabled", () => {
    expect(attributionText({ prAttributionEnabled: true, prAttributionText: "drafted with {{harness}}" }, "Claude")).toBe("drafted with Claude");
  });
});

describe("suggestedWorkflow", () => {
  const review = workflow({ id: "review", suggestWhen: ["review-requested"] });
  const babysit = workflow({ id: "babysit", suggestWhen: ["author"] });
  const bot = workflow({ id: "bot-check", suggestWhen: ["bot-author"] });
  const workflows = [review, babysit, bot];

  it("suggests review when review requested from viewer", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: true });
    expect(suggestedWorkflow(pr, workflows)?.id).toBe("review");
  });

  it("suggests babysit when viewer is the author", () => {
    const pr = prSummary({ viewerIsAuthor: true });
    expect(suggestedWorkflow(pr, workflows)?.id).toBe("babysit");
  });

  it("suggests the bot workflow for a bot author", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: false, author: { login: "dependabot", isBot: true } });
    expect(suggestedWorkflow(pr, workflows)?.id).toBe("bot-check");
  });

  it("skips a disabled workflow even when its condition matches", () => {
    const disabledReview = workflow({ id: "review", suggestWhen: ["review-requested"], enabled: false });
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: true });
    expect(suggestedWorkflow(pr, [disabledReview, babysit])).toBeNull();
  });
});

describe("primaryAction", () => {
  const reviewWorkflow = workflow({ id: "review", suggestWhen: ["review-requested"] });

  it("returns none for a merged PR", () => {
    const pr = prSummary({ state: "MERGED" });
    expect(primaryAction(pr, [session()], [reviewWorkflow])).toEqual({ kind: "none" });
  });

  it("returns open when a main session has seen the current head", () => {
    const pr = prSummary({ headRefOid: "sha1" });
    const linked = [session({ prs: [{ ref: pr.ref, origin: "opened", lastSeenSha: "sha1", lastSeenAt: 0 }] })];
    expect(primaryAction(pr, linked, [])).toEqual({ kind: "open", sessionId: "s1" });
  });

  it("returns continue when the main session is a review link behind the head", () => {
    const pr = prSummary({ headRefOid: "sha2" });
    const linked = [session({ prs: [{ ref: pr.ref, origin: "workflow", workflowId: "review", lastSeenSha: "sha1", lastSeenAt: 0 }] })];
    expect(primaryAction(pr, linked, [])).toEqual({ kind: "continue", sessionId: "s1", workflowId: "review" });
  });

  it("returns open when the review session already saw the current head", () => {
    const pr = prSummary({ headRefOid: "sha1" });
    const linked = [session({ prs: [{ ref: pr.ref, origin: "workflow", workflowId: "review", lastSeenSha: "sha1", lastSeenAt: 0 }] })];
    expect(primaryAction(pr, linked, [])).toEqual({ kind: "open", sessionId: "s1" });
  });

  it("returns run for a suggested workflow when nothing is linked", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: true });
    expect(primaryAction(pr, [], [reviewWorkflow])).toEqual({ kind: "run", workflowId: "review" });
  });

  it("returns none when nothing is linked and no workflow is suggested", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: false });
    expect(primaryAction(pr, [], [reviewWorkflow])).toEqual({ kind: "none" });
  });
});

function check(overrides: Partial<PrCheck> = {}): PrCheck {
  return { name: "test", workflow: "ci", status: "failure", url: null, runId: 1, completedAt: null, ...overrides };
}

describe("loadFailedLogs", () => {
  it("fetches each failing run once, labels it with its checks and joins the sections", async () => {
    const calls: Array<{ ref: PrRef; runId: number }> = [];
    const detail = prDetail({
      checkRuns: [
        check({ name: "unit", runId: 7 }),
        check({ name: "lint", runId: 7 }),
        check({ name: "e2e", runId: 9 }),
        check({ name: "build", status: "success", runId: 11 }),
        check({ name: "external", runId: null })
      ]
    });
    const text = await loadFailedLogs(detail, async (ref, runId) => {
      calls.push({ ref, runId });
      return `  log ${runId}  \n`;
    });
    expect(calls.map((c) => c.runId)).toEqual([7, 9]);
    expect(calls[0].ref).toEqual(detail.ref);
    expect(text).toBe("### unit, lint (run 7)\nlog 7\n\n### e2e (run 9)\nlog 9");
  });

  it("keeps only the tail of a long run log", async () => {
    const detail = prDetail({ checkRuns: [check({ runId: 3 })] });
    const log = `${"a".repeat(100)}${"b".repeat(12_000)}`;
    const text = await loadFailedLogs(detail, async () => log);
    expect(text).toBe(`### test (run 3)\n[…truncated]\n${"b".repeat(12_000)}`);
  });

  it("caps the joined logs and marks the cut", async () => {
    const detail = prDetail({ checkRuns: [1, 2, 3].map((runId) => check({ name: `job${runId}`, runId })) });
    const text = await loadFailedLogs(detail, async () => "x".repeat(11_000));
    expect(text.endsWith("\n[…more logs truncated]")).toBe(true);
    expect(text.length).toBe(30_000 + "\n[…more logs truncated]".length);
  });

  it("returns an empty string when no run failed", async () => {
    const detail = prDetail({ checkRuns: [check({ status: "success" })] });
    expect(await loadFailedLogs(detail, async () => "unused")).toBe("");
  });
});
