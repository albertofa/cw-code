import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest, PrDetail, PrRef, PrWorkflow, SessionPrLink } from "@cw-code/contracts";
import { SessionBusyError } from "../sessions/SessionBusyError.js";
import { SessionStore } from "../sessions/SessionStore.js";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import type { SettledTurnEvent, ThreadNotice } from "../threads/ThreadService.js";
import { AUTO_FOLLOW_UP_LIMIT } from "./babysit.js";
import { AUTO_FOLLOW_UP_NOTICE_ID, AutoFollowUpEngine, type AutoFollowUpTurnInput } from "./AutoFollowUpEngine.js";

const REF: PrRef = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
const KEY = "github.com/acme/widgets#42";

function workflow(id: string, overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id,
    label: id === "babysit" ? "Babysit" : "Review",
    description: "",
    icon: "eye",
    builtIn: true,
    enabled: true,
    target: "pr",
    suggestWhen: [],
    workspace: "linked",
    harness: { driver: null, model: "", effort: null, permissionMode: null },
    startPrompt: "start",
    updatePrompt: `update ${id}`,
    ...overrides
  };
}

function detail(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    ref: REF,
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
    ci: "failing",
    checks: { total: 1, passed: 0, failed: 1, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 2000,
    body: "",
    createdAt: 0,
    timeline: [],
    threads: [],
    checkRuns: [{ name: "test", workflow: "ci", status: "failure", url: null, runId: 7, completedAt: 1_500 }],
    commits: [],
    viewerLogin: "",
    ...overrides
  };
}

const PASSING = detail({
  ci: "passing",
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  mergeStateStatus: "CLEAN",
  checkRuns: [{ name: "test", workflow: "ci", status: "success", url: null, runId: 7, completedAt: 1_500 }]
});

const LINK: SessionPrLink = { ref: REF, origin: "workflow", workflowId: "babysit", lastSeenSha: "new-sha", lastSeenAt: 1000 };

interface FakeRuntime {
  busy: boolean;
  approvals: ApprovalRequest[];
  questions: [];
}

interface Sent {
  sessionId: string;
  prompt: string;
  input: AutoFollowUpTurnInput;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(options: { enabled?: boolean; pr?: PrDetail; workflows?: PrWorkflow[] } = {}) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "cw-auto-")), "test.db");
  const store = new SessionStore(dbPath);
  const project = store.addProject("C:/proj");
  const sessionId = store.createSession(project.id, "claude", "babysat").id;
  store.updateSession(sessionId, { status: "done", prs: [LINK] }, "turn-done");
  const runtime: FakeRuntime = { busy: false, approvals: [], questions: [] };
  let pr = options.pr ?? detail();
  const sent: Sent[] = [];
  const seen: Array<{ sessionId: string; headSha: string | null; seenAt: number | null }> = [];
  const notices: Array<{ sessionId: string; notice: ThreadNotice }> = [];
  const changed: string[] = [];
  let startTurn = async (_sessionId: string): Promise<string> => "turn-1";
  const engine = new AutoFollowUpEngine({
    sessions: () => store.listAllSessions(),
    settings: () => ({ ...DEFAULT_SETTINGS, prWorkflows: options.workflows ?? [workflow("babysit", { autoFollowUp: true }), workflow("review")] }),
    runtime: () => runtime,
    summaryLookup: () => new Map([[KEY, pr]]),
    detail: (key) => (key === KEY ? pr : undefined),
    failedCheckLog: async () => "log",
    startTurn: (id, prompt, input) => {
      sent.push({ sessionId: id, prompt, input });
      return startTurn(id);
    },
    markPrSeen: (id, _ref, headSha, seenAt) => {
      seen.push({ sessionId: id, headSha, seenAt });
    },
    updateAutoFollowUp: (id, update) => {
      const known = store.getSession(id) !== undefined;
      if (store.updateAutoFollowUp(id, update)) engine.reevaluate();
      return known;
    },
    postNotice: (id, notice) => notices.push({ sessionId: id, notice }),
    enabled: options.enabled ?? true
  });
  engine.onChanged((id) => changed.push(id));
  return {
    engine,
    store,
    dbPath,
    sessionId,
    runtime,
    sent,
    seen,
    notices,
    changed,
    setPr(next: PrDetail) {
      pr = next;
      engine.reevaluate();
    },
    failStartWith(error: Error) {
      startTurn = async () => {
        throw error;
      };
    },
    autoFollowUp: () => store.getSession(sessionId)?.autoFollowUp
  };
}

const done = (isError: boolean): SettledTurnEvent => ({
  type: "turn.done",
  turnId: "t1",
  sessionId: "s",
  resumeCursor: "c",
  resultText: "",
  usage: [],
  numTurns: 1,
  isError,
  backgroundTasks: 0
});

describe("AutoFollowUpEngine sends", () => {
  it("fires once per signature and marks the PR seen", async () => {
    const h = harness();
    await flush();
    h.engine.reevaluate();
    await flush();
    h.engine.reevaluate();
    await flush();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].sessionId).toBe(h.sessionId);
    expect(h.sent[0].input).toEqual({ auto: true, prRefs: [REF] });
    expect(h.sent[0].prompt).toContain("update babysit");
    expect(h.seen).toEqual([{ sessionId: h.sessionId, headSha: "new-sha", seenAt: 2000 }]);

    h.setPr(detail({ headRefOid: "pushed" }));
    await flush();
    expect(h.sent).toHaveLength(2);
  });

  it("skips busy, waiting and paused sessions and stops at the turn cap", async () => {
    const h = harness();
    h.runtime.busy = true;
    await flush();
    expect(h.sent).toHaveLength(0);

    h.runtime.busy = false;
    h.runtime.approvals = [{ requestId: "r1" } as ApprovalRequest];
    h.engine.reevaluate();
    await flush();
    expect(h.sent).toHaveLength(0);

    h.runtime.approvals = [];
    h.engine.pause(h.sessionId);
    await flush();
    expect(h.sent).toHaveLength(0);

    h.engine.resume(h.sessionId);
    h.store.updateAutoFollowUp(h.sessionId, () => ({ turns: AUTO_FOLLOW_UP_LIMIT }));
    h.engine.reevaluate();
    await flush();
    expect(h.sent).toHaveLength(0);
    expect(h.engine.babysit(h.sessionId)?.phase).toEqual({ kind: "paused", reason: "limit" });

    h.store.updateAutoFollowUp(h.sessionId, () => ({ turns: AUTO_FOLLOW_UP_LIMIT - 1 }));
    h.engine.reevaluate();
    await flush();
    expect(h.sent).toHaveLength(1);
  });

  it("sends a final review once the PR is merge-ready", async () => {
    const h = harness({ pr: PASSING });
    await flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].input).toEqual({ auto: true, prRefs: [REF], finalReview: { ref: REF, sha: "new-sha" } });
    expect(h.sent[0].prompt).toContain("final review pass");
  });

  it("pauses with an error and posts a thread notice when the send fails", async () => {
    const h = harness();
    h.failStartWith(new Error("[cw-branch-mismatch] proj is on main, not this session's branch cw/x."));
    await flush();

    expect(h.autoFollowUp()).toEqual({ turns: 0, paused: "error" });
    expect(h.seen).toEqual([]);
    expect(h.notices).toEqual([
      {
        sessionId: h.sessionId,
        notice: {
          noticeId: AUTO_FOLLOW_UP_NOTICE_ID,
          text: "Babysit could not send the acme/widgets#42 update: proj is on main, not this session's branch cw/x.. Resume Babysit in the session's dock to retry.",
          severity: "error"
        }
      }
    ]);
  });

  it("retries a send that lost the race to another turn", async () => {
    const h = harness();
    h.failStartWith(new SessionBusyError("turn pending"));
    await flush();
    expect(h.sent).toHaveLength(1);
    expect(h.autoFollowUp()).toBeUndefined();
    expect(h.notices).toEqual([]);

    h.engine.reevaluate();
    await flush();
    expect(h.sent).toHaveLength(2);
  });

  it("sends nothing while disabled but still tracks babysit state", async () => {
    const h = harness({ enabled: false });
    await flush();
    expect(h.sent).toHaveLength(0);
    expect(h.engine.babysit(h.sessionId)).toMatchObject({ workflow: { id: "babysit" }, phase: { kind: "watching" }, autoTurns: 0 });
    expect(h.changed).toEqual([h.sessionId]);

    h.engine.turnStarted(h.sessionId, true);
    await flush();
    expect(h.engine.babysit(h.sessionId)?.autoTurns).toBe(1);
    expect(h.changed).toEqual([h.sessionId, h.sessionId]);
    expect(h.sent).toHaveLength(0);

    h.engine.setEnabled(true);
    await flush();
    expect(h.sent).toHaveLength(1);
  });

  it("allows the same signature again after a resume", async () => {
    const h = harness();
    await flush();
    expect(h.sent).toHaveLength(1);
    h.engine.pause(h.sessionId);
    await flush();
    h.engine.resume(h.sessionId);
    await flush();
    expect(h.sent).toHaveLength(2);
  });
});

describe("AutoFollowUpEngine pause rules", () => {
  it("counts automatic turns and resets on a manual turn", async () => {
    const h = harness({ enabled: false });
    h.engine.turnStarted(h.sessionId, true);
    h.engine.turnStarted(h.sessionId, true);
    expect(h.autoFollowUp()).toEqual({ turns: 2 });
    h.engine.turnStopped(h.sessionId);
    expect(h.autoFollowUp()).toEqual({ turns: 2, paused: "interrupted" });
    h.engine.turnStarted(h.sessionId, true);
    expect(h.autoFollowUp()).toEqual({ turns: 3, paused: "interrupted" });
    h.engine.turnStarted(h.sessionId, false);
    expect(h.autoFollowUp()).toBeUndefined();
  });

  it("pauses on errors unless the user paused", async () => {
    const h = harness({ enabled: false });
    h.engine.turnSettled(h.sessionId, done(false));
    expect(h.autoFollowUp()).toBeUndefined();
    h.engine.turnSettled(h.sessionId, done(true));
    expect(h.autoFollowUp()).toEqual({ turns: 0, paused: "error" });
    h.engine.resume(h.sessionId);
    h.engine.turnSettled(h.sessionId, { type: "turn.error", turnId: "t1", sessionId: "s", message: "boom" } as SettledTurnEvent);
    expect(h.autoFollowUp()).toEqual({ turns: 0, paused: "error" });
  });

  it("keeps a user pause through stops, errors and manual turns until resumed", async () => {
    const h = harness({ enabled: false });
    h.engine.turnStarted(h.sessionId, true);
    h.engine.pause(h.sessionId);
    expect(h.autoFollowUp()).toEqual({ turns: 1, paused: "user" });
    h.engine.turnStopped(h.sessionId);
    h.engine.turnSettled(h.sessionId, done(true));
    expect(h.autoFollowUp()).toEqual({ turns: 1, paused: "user" });
    h.engine.turnStarted(h.sessionId, false);
    expect(h.autoFollowUp()).toEqual({ turns: 0, paused: "user" });
    h.engine.resume(h.sessionId);
    expect(h.autoFollowUp()).toBeUndefined();
    expect(h.engine.pause("sess_missing")).toBe(false);
  });

  it("persists counters and pauses across a store reload", async () => {
    const h = harness({ enabled: false });
    h.engine.turnStarted(h.sessionId, true);
    h.engine.turnStarted(h.sessionId, true);
    h.engine.turnStarted(h.sessionId, true);
    h.engine.turnStopped(h.sessionId);
    expect(new SessionStore(h.dbPath).getSession(h.sessionId)?.autoFollowUp).toEqual({ turns: 3, paused: "interrupted" });
  });
});
