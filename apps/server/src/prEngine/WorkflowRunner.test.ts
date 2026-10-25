import { describe, expect, it } from "bun:test";
import type {
  PrRef,
  PrSummary,
  PrWorkflow,
  SessionMeta,
  SessionPrLink,
  WorkflowPreview,
  WorkflowRunRequest,
  WorkflowSubject
} from "@cw-code/contracts";
import { WorkflowRunner, type WorkflowRunnerDeps } from "./WorkflowRunner.js";

const ref: PrRef = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
const subject: WorkflowSubject = { kind: "pr", ref };

const workflow: PrWorkflow = {
  id: "fix",
  label: "Fix",
  description: "",
  icon: "wrench",
  builtIn: false,
  enabled: true,
  target: "pr",
  suggestWhen: [],
  workspace: "worktree",
  harness: { driver: null, model: "", effort: null, permissionMode: null },
  startPrompt: "start",
  updatePrompt: "update"
};

const pr = {
  ref,
  headRefName: "fix",
  headRefOid: "sha1",
  viewerIsAuthor: true,
  updatedAt: 2_000
} as PrSummary;

function preview(overrides: Partial<WorkflowPreview> = {}): WorkflowPreview {
  return {
    activeWorkflowId: "fix",
    pickableWorkflowIds: ["fix"],
    babysitLocked: false,
    startsContinuous: false,
    adoptsLink: false,
    subject,
    subjectLabel: "#42",
    updateMode: false,
    linkedSessionIds: [],
    otherSessionIds: [],
    otherSessionsLabel: "Other sessions",
    projectId: "proj_1",
    needsClone: false,
    workspace: "worktree",
    linkedWorktreeSessionId: null,
    driverMissing: false,
    harness: {
      resolved: { driver: "codex", model: "gpt", effort: "high", permissionMode: "acceptEdits" },
      summary: { parts: [], title: "" },
      error: null
    },
    base: null,
    pr,
    issue: null,
    run: null,
    loaded: true,
    error: null,
    logsNeeded: false,
    logsReady: true,
    logsError: null,
    prompt: "start",
    revision: "r",
    ...overrides
  };
}

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id, projectId: "proj_1", driver: "claude", title: id, status: "idle", createdAt: 0, updatedAt: 0, ...overrides } as SessionMeta;
}

function request(overrides: Partial<WorkflowRunRequest> = {}): WorkflowRunRequest {
  return {
    workflowId: "fix",
    subject,
    continueSessionId: null,
    workspace: null,
    promptOverride: null,
    composerDriver: "claude",
    pendingPrefs: { variant: "v" },
    prompt: "do it",
    resume: null,
    ...overrides
  };
}

function harness(options: { preview?: WorkflowPreview; sessions?: SessionMeta[]; failTurn?: boolean; failClone?: boolean } = {}) {
  const calls: string[] = [];
  const links: Array<{ sessionId: string; link: SessionPrLink }> = [];
  const turns: Array<{ sessionId: string; prompt: string }> = [];
  const sessions = [...(options.sessions ?? [])];
  const state = { failTurn: options.failTurn ?? false };
  const deps: WorkflowRunnerDeps = {
    preview: async () => options.preview ?? preview(),
    resolveHarness: async () => ({
      resolved: { driver: "opencode", model: "m", effort: "low", permissionMode: "manual" },
      summary: { parts: [], title: "" },
      error: null
    }),
    workflows: () => [workflow],
    sessions: () => sessions,
    clone: async () => {
      calls.push("clone");
      if (options.failClone) throw new Error("clone failed");
      return { id: "proj_2", rootPath: "/r", name: "widgets" };
    },
    refreshProjectRepos: async () => {
      calls.push("refreshRepos");
    },
    createSession: async (projectId, driver, createOptions) => {
      calls.push(`create:${projectId}:${driver}:${createOptions.mode}`);
      const created = session(`sess_${sessions.length + 1}`, { projectId, driver, branch: "cw/new" });
      sessions.push(created);
      return created;
    },
    setComposer: (sessionId, prefs) => {
      calls.push(`composer:${sessionId}:${prefs.model}:${prefs.variant}`);
    },
    linkPr: (sessionId, link) => {
      calls.push(`link:${sessionId}`);
      links.push({ sessionId, link });
      const index = sessions.findIndex((s) => s.id === sessionId);
      sessions[index] = { ...sessions[index]!, prs: [link] };
    },
    linkIssue: () => calls.push("linkIssue"),
    linkRun: () => calls.push("linkRun"),
    markPrSeen: (sessionId, _ref, headSha) => {
      calls.push(`seen:${sessionId}:${headSha}`);
    },
    markIssueSeen: () => calls.push("seenIssue"),
    markRunSeen: () => calls.push("seenRun"),
    startTurn: async (sessionId, prompt) => {
      calls.push(`send:${sessionId}`);
      if (state.failTurn) throw new Error("session busy");
      turns.push({ sessionId, prompt });
      return "turn_1";
    },
    postNotice: (sessionId, _noticeId, text) => {
      calls.push(`notice:${sessionId}:${text}`);
    }
  };
  return { runner: new WorkflowRunner(deps), calls, links, turns, state };
}

describe("WorkflowRunner", () => {
  it("sends, then links an unlinked continue session once with deferred seen state, then marks it seen", async () => {
    const { runner, calls, links } = harness({ sessions: [session("sess_a")] });
    const result = await runner.run(request({ continueSessionId: "sess_a" }));
    expect(result).toEqual({ ok: true, sessionId: "sess_a" });
    expect(calls).toEqual(["send:sess_a", "link:sess_a", "seen:sess_a:sha1"]);
    expect(links).toEqual([
      { sessionId: "sess_a", link: { ref, origin: "workflow", workflowId: "fix", lastSeenSha: "", lastSeenAt: 0 } }
    ]);
  });

  it("adopts an existing link with the new workflow on the continue path", async () => {
    const opened: SessionPrLink = { ref, origin: "opened", lastSeenSha: "old", lastSeenAt: 1 };
    const { runner, calls, links } = harness({ preview: preview({ adoptsLink: true }), sessions: [session("sess_a", { prs: [opened] })] });
    expect(await runner.run(request({ continueSessionId: "sess_a" }))).toEqual({ ok: true, sessionId: "sess_a" });
    expect(calls.filter((call) => call.startsWith("link:"))).toEqual(["link:sess_a"]);
    expect(links[0]?.link).toEqual({ ...opened, workflowId: "fix" });
  });

  it("does not link an already linked continue session", async () => {
    const linked: SessionPrLink = { ref, origin: "workflow", workflowId: "fix", lastSeenSha: "old", lastSeenAt: 1 };
    const { runner, calls } = harness({ sessions: [session("sess_a", { prs: [linked] })] });
    await runner.run(request({ continueSessionId: "sess_a" }));
    expect(calls).toEqual(["send:sess_a", "seen:sess_a:sha1"]);
  });

  it("creates, links with the seen state, then sends with the push note on the new path", async () => {
    const { runner, calls, links, turns } = harness();
    const result = await runner.run(request());
    expect(result).toEqual({ ok: true, sessionId: "sess_1" });
    expect(calls).toEqual([
      "create:proj_1:codex:new",
      "composer:sess_1:gpt:v",
      "link:sess_1",
      "send:sess_1",
      "seen:sess_1:sha1"
    ]);
    expect(links[0]?.link).toEqual({ ref, origin: "workflow", workflowId: "fix", lastSeenSha: "sha1", lastSeenAt: 2_000 });
    expect(turns[0]?.prompt).toBe(
      "do it\n\nYou are on branch cw/new, not the PR head. To update PR #42, push with: git push origin HEAD:fix"
    );
  });

  it("resumes after a failed send without creating or linking again", async () => {
    const { runner, calls, state, turns } = harness({ failTurn: true });
    const failed = await runner.run(request());
    expect(failed).toMatchObject({ ok: false, stage: "send", message: "session busy" });
    const resume = failed.ok ? null : failed.resume;
    expect(resume).toEqual({ sessionId: "sess_1", linked: true, sent: false, note: expect.stringContaining("cw/new") });

    calls.length = 0;
    state.failTurn = false;
    expect(await runner.run(request({ resume }))).toEqual({ ok: true, sessionId: "sess_1" });
    expect(calls).toEqual(["send:sess_1", "seen:sess_1:sha1"]);
    expect(turns[0]?.prompt).toContain("git push origin HEAD:fix");
  });

  it("does not send again when a continue run is retried after the send", async () => {
    const { runner, calls } = harness({ sessions: [session("sess_a")] });
    const resume = { sessionId: "sess_a", linked: false, sent: true, note: null };
    await runner.run(request({ continueSessionId: "sess_a", resume }));
    expect(calls).toEqual(["link:sess_a", "seen:sess_a:sha1"]);
  });

  it("clones and resolves the harness for the cloned project before creating", async () => {
    const { runner, calls } = harness({ preview: preview({ projectId: null, needsClone: true }) });
    expect(await runner.run(request())).toEqual({ ok: true, sessionId: "sess_1" });
    expect(calls.slice(0, 3)).toEqual(["clone", "refreshRepos", "create:proj_2:opencode:new"]);
  });

  it("reports a clone failure at the clone stage with nothing to resume", async () => {
    const { runner, calls } = harness({ preview: preview({ projectId: null, needsClone: true }), failClone: true });
    expect(await runner.run(request())).toEqual({ ok: false, stage: "clone", message: "clone failed", resume: null });
    expect(calls).toEqual(["clone"]);
  });

  it("refuses to start when the pull request details are not loaded", async () => {
    const { runner, calls } = harness({ preview: preview({ error: "rate limited" }) });
    expect(await runner.run(request())).toEqual({
      ok: false,
      stage: "create",
      message: "pull request details are not loaded",
      resume: null
    });
    expect(calls).toEqual([]);
  });

  it("rejects a retry for an unknown session", async () => {
    const { runner } = harness();
    const result = await runner.run(request({ resume: { sessionId: "sess_gone", linked: true, sent: false, note: null } }));
    expect(result).toMatchObject({ ok: false, stage: "send", message: "unknown session sess_gone" });
  });
});
