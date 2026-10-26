import { describe, expect, it } from "bun:test";
import type {
  AppSettings,
  IssueDetail,
  PermissionOption,
  PrDetail,
  PrRef,
  PrWorkflow,
  SessionMeta,
  SessionPrLink,
  WorkflowPreviewRequest
} from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { WorkflowPreviewService, type WorkflowPreviewDeps } from "./WorkflowPreview.js";

const ref: PrRef = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
const issueRef = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };

function workflow(id: string, overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id,
    label: id,
    description: "",
    icon: "wrench",
    builtIn: false,
    enabled: true,
    target: "pr",
    suggestWhen: [],
    workspace: "worktree",
    harness: { driver: null, model: "", effort: null, permissionMode: null },
    startPrompt: "start {{pr.number}}",
    updatePrompt: "update {{pr.number}}",
    ...overrides
  };
}

function detail(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    ref,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Fix it",
    state: "OPEN",
    isDraft: false,
    author: { login: "alice", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: "fix",
    headRefOid: "new",
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 1,
    unresolvedThreads: 0,
    ci: "failing",
    checks: { total: 1, passed: 0, failed: 1, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 2_000,
    body: "",
    createdAt: 0,
    timeline: [{ kind: "comment", at: 1_500, actor: "bob", body: "please fix the test" }],
    threads: [],
    checkRuns: [{ name: "test", workflow: "ci", status: "failure", url: null, runId: 9, completedAt: 1_600 }],
    commits: [],
    viewerLogin: "alice",
    ...overrides
  };
}

function issue(): IssueDetail {
  return {
    ref: issueRef,
    url: "https://github.com/acme/widgets/issues/7",
    title: "Broken",
    state: "OPEN",
    stateReason: null,
    author: { login: "bob", isBot: false },
    assignees: [],
    labels: ["bug"],
    milestone: null,
    commentsCount: 0,
    linkedPrs: [],
    createdAt: 0,
    updatedAt: 100,
    body: "It breaks",
    comments: [],
    viewerLogin: "alice"
  };
}

function link(overrides: Partial<SessionPrLink> = {}): SessionPrLink {
  return { ref, origin: "workflow", workflowId: "fix", lastSeenSha: "old", lastSeenAt: 1_000, ...overrides };
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

interface HarnessOptions {
  workflows?: PrWorkflow[];
  sessions?: SessionMeta[];
  ownsWorktree?: (path: string) => boolean;
  permissions?: PermissionOption[];
  withDetail?: boolean;
  issueFails?: boolean;
  checkLog?: () => Promise<string>;
}

function harness(options: HarnessOptions = {}) {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, prAttributionEnabled: false, prWorkflows: options.workflows ?? [workflow("fix")] };
  const details = new Map<string, PrDetail>(options.withDetail === false ? [] : [[prKey(ref), detail()]]);
  const detailErrors = new Map<string, string>();
  const calls = { checkLogs: 0, issues: 0, detailLoads: 0, models: 0, permissions: 0 };
  const clock = { now: 10_000 };
  let releaseLog: (text: string) => void = () => {};
  const deps: WorkflowPreviewDeps = {
    settings: () => settings,
    sessions: () => options.sessions ?? [],
    projects: () => [{ id: "p1", name: "widgets" }],
    ownsWorktree: options.ownsWorktree ?? (() => true),
    projectRepos: async () => [{ projectId: "p1", host: "github.com", owner: "acme", repo: "widgets" }],
    installedHarnesses: () => ["claude"],
    recentModels: () => [],
    listModels: async () => {
      calls.models += 1;
      return [{ id: "opus", label: "Opus", source: "curated" }];
    },
    listPermissions: async () => {
      calls.permissions += 1;
      return options.permissions ?? [];
    },
    prSummary: () => undefined,
    prDetail: (key) => details.get(key),
    prDetailError: (key) => detailErrors.get(key) ?? null,
    loadPrDetail: async (target) => {
      calls.detailLoads += 1;
      const key = prKey(target);
      const found = details.get(key);
      if (found) return found;
      detailErrors.set(key, "rate limited");
      throw new Error("rate limited");
    },
    issueDetail: async () => {
      calls.issues += 1;
      if (options.issueFails) throw new Error("issue gone");
      return issue();
    },
    cachedRun: () => undefined,
    checkLog:
      options.checkLog ??
      (() => {
        calls.checkLogs += 1;
        return new Promise<string>((resolve) => {
          releaseLog = resolve;
        });
      }),
    runLog: async () => "run log",
    now: () => clock.now
  };
  return { service: new WorkflowPreviewService(deps), calls, clock, details, releaseLog: (text: string) => releaseLog(text) };
}

function request(overrides: Partial<WorkflowPreviewRequest> = {}): WorkflowPreviewRequest {
  return {
    workflowId: "fix",
    subject: { kind: "pr", ref },
    continueSessionId: null,
    workspace: null,
    promptOverride: null,
    composerDriver: "claude",
    pendingPrefs: {},
    ...overrides
  };
}

describe("WorkflowPreviewService.preview", () => {
  it("fills the update template for a linked session once the failed logs are ready", async () => {
    const fix = workflow("fix", { updatePrompt: "seen={{session.lastSeenSha}} delta=[{{pr.delta}}] logs=[{{checks.failedLogs}}]" });
    const h = harness({ workflows: [fix], sessions: [session({ prs: [link()] })] });

    const first = await h.service.preview(request({ continueSessionId: "s1" }));
    expect(first).toMatchObject({ updateMode: true, logsNeeded: true, logsReady: false, loaded: false, prompt: null, harness: null });
    expect(h.calls.checkLogs).toBe(1);

    const second = h.service.preview(request({ continueSessionId: "s1" }));
    h.releaseLog("boom");
    const ready = await second;
    expect(ready).toMatchObject({ logsReady: true, loaded: true, logsError: null });
    expect(ready.prompt).toContain("seen=old");
    expect(ready.prompt).toContain("logs=[### test (run 9)\nboom]");
    expect(ready.prompt).not.toContain("delta=[]");
    expect(ready.revision).not.toBe(first.revision);
    expect(h.calls.checkLogs).toBe(1);
  });

  it("uses the start template and resolves the harness for a new session", async () => {
    const h = harness();
    const preview = await h.service.preview(request());
    expect(preview).toMatchObject({ updateMode: false, logsNeeded: false, loaded: true, prompt: "start 42", projectId: "p1", needsClone: false });
    expect(preview.harness?.resolved).toMatchObject({ driver: "claude", model: "opus" });
    expect(preview.pr?.headRefOid).toBe("new");
  });

  it("only offers a linked worktree workspace when cw-code owns it", async () => {
    const linked = session({ prs: [link()], worktreePath: "/foreign/wt" });

    const foreign = harness({ sessions: [linked], ownsWorktree: () => false });
    const fallback = await foreign.service.preview(request({ workspace: "linked" }));
    expect(fallback).toMatchObject({ workspace: "worktree", linkedWorktreeSessionId: null });

    const owned = harness({ sessions: [linked], ownsWorktree: (path) => path === "/foreign/wt" });
    const preview = await owned.service.preview(request({ workspace: "linked" }));
    expect(preview).toMatchObject({ workspace: "linked", linkedWorktreeSessionId: "s1" });
  });

  it("gives an issue subject the default branch as its base", async () => {
    const implement = workflow("implement", { target: "issue", startPrompt: "issue {{issue.number}}: {{issue.title}}" });
    const h = harness({ workflows: [implement] });
    const preview = await h.service.preview(request({ workflowId: "implement", subject: { kind: "issue", ref: issueRef } }));
    expect(preview.base).toEqual({ baseBranch: null, label: "the default branch (fetched from origin)" });
    expect(preview).toMatchObject({ loaded: true, prompt: "issue 7: Broken", subjectLabel: "#7" });
    expect(preview.issue?.title).toBe("Broken");
  });

  it("locks the pickable workflows to the one babysitting the continued session", async () => {
    const babysit = workflow("babysit", { autoFollowUp: true });
    const review = workflow("review");
    const h = harness({ workflows: [review, babysit], sessions: [session({ prs: [link({ workflowId: "babysit" })] })] });

    const locked = await h.service.preview(request({ workflowId: "review", continueSessionId: "s1" }));
    expect(locked).toMatchObject({ activeWorkflowId: "babysit", pickableWorkflowIds: ["babysit"], babysitLocked: true, startsContinuous: false });

    const open = await h.service.preview(request({ workflowId: "review" }));
    expect(open).toMatchObject({ activeWorkflowId: "review", pickableWorkflowIds: ["review", "babysit"], babysitLocked: false });
  });
});

describe("WorkflowPreviewService.resolveHarness", () => {
  it("falls back to an offered permission mode", async () => {
    const h = harness({
      permissions: [
        { id: "manual", label: "Ask", description: "", native: true },
        { id: "acceptEdits", label: "Edits", description: "", native: true }
      ]
    });
    const result = await h.service.resolveHarness({
      config: { driver: "claude", model: "", effort: null, permissionMode: "bypassPermissions" },
      composerDriver: "claude",
      pendingPrefs: {},
      projectId: null
    });
    expect(result.resolved.permissionMode).toBe("acceptEdits");
    expect(result.summary.parts.find((part) => part.key === "permission")).toEqual({ key: "permission", label: "Edits", source: "fallback" });
    expect(result.error).toBeNull();
  });
});

describe("WorkflowPreviewService load throttling", () => {
  it("attempts a failing pull request detail load once per window across repeated previews", async () => {
    const h = harness({ withDetail: false });
    const first = await h.service.preview(request());
    expect(first).toMatchObject({ loaded: false, error: "rate limited", prompt: null });
    await h.service.preview(request());
    await h.service.preview(request());
    expect(h.calls.detailLoads).toBe(1);

    await h.service.preview(request({ retry: true }));
    expect(h.calls.detailLoads).toBe(2);

    h.clock.now += 61_000;
    await h.service.preview(request());
    expect(h.calls.detailLoads).toBe(3);
  });

  it("refreshes a loaded pull request detail in the background at most once a minute", async () => {
    const h = harness();
    await h.service.preview(request());
    await h.service.preview(request());
    expect(h.calls.detailLoads).toBe(1);
    h.clock.now += 61_000;
    await h.service.preview(request());
    expect(h.calls.detailLoads).toBe(2);
  });

  it("keeps a failed log fetch error until it expires or the user retries", async () => {
    let fetches = 0;
    const fix = workflow("fix", { startPrompt: "logs=[{{checks.failedLogs}}]" });
    const h = harness({
      workflows: [fix],
      checkLog: async () => {
        fetches += 1;
        throw new Error("logs unavailable");
      }
    });
    const pending = await h.service.preview(request());
    expect(pending).toMatchObject({ logsNeeded: true, logsReady: false });
    await Bun.sleep(0);

    const failed = await h.service.preview(request());
    expect(failed).toMatchObject({ logsReady: true, logsError: expect.any(String) });
    await h.service.preview(request());
    expect(fetches).toBe(1);

    const retried = await h.service.preview(request({ retry: true }));
    expect(retried.logsReady).toBe(false);
    expect(fetches).toBe(2);
  });

  it("keeps a failed issue load error until it expires or the user retries", async () => {
    const implement = workflow("implement", { target: "issue", startPrompt: "issue {{issue.number}}" });
    const h = harness({ workflows: [implement], issueFails: true });
    const issueRequest = request({ workflowId: "implement", subject: { kind: "issue", ref: issueRef } });
    expect(await h.service.preview(issueRequest)).toMatchObject({ loaded: false, error: "issue gone" });
    await h.service.preview(issueRequest);
    expect(h.calls.issues).toBe(1);
    await h.service.preview({ ...issueRequest, retry: true });
    expect(h.calls.issues).toBe(2);
    h.clock.now += 61_000;
    await h.service.preview(issueRequest);
    expect(h.calls.issues).toBe(3);
  });

  it("reuses model and permission lists for the same driver, project and settings", async () => {
    const h = harness();
    await h.service.preview(request());
    await h.service.preview(request());
    expect(h.calls).toMatchObject({ models: 1, permissions: 1 });
    h.clock.now += 31_000;
    await h.service.preview(request());
    expect(h.calls).toMatchObject({ models: 2, permissions: 2 });
  });
});

describe("WorkflowPreviewService.previewTemplate", () => {
  const templateRequest = { template: "fix #{{pr.number}} on {{pr.head}}", ref, driver: "claude" as const, attribution: "" };

  it("resolves a template against the pull request detail", async () => {
    const h = harness();
    expect(await h.service.previewTemplate(templateRequest)).toEqual({
      text: "fix #42 on fix",
      loaded: true,
      error: null,
      logsNeeded: false,
      logsReady: true,
      logsError: null
    });
  });

  it("reports a detail load failure without reloading until retried", async () => {
    const h = harness({ withDetail: false });
    expect(await h.service.previewTemplate(templateRequest)).toMatchObject({ text: null, loaded: false, error: "rate limited" });
    await h.service.previewTemplate(templateRequest);
    expect(h.calls.detailLoads).toBe(1);
    await h.service.previewTemplate({ ...templateRequest, retry: true });
    expect(h.calls.detailLoads).toBe(2);
  });
});
