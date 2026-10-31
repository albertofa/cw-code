import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CliDriver, GitStatus, HistoryMessage, PrRef, SessionMeta, SubagentLink, ThreadEvent, TurnHandle } from "@cw-code/contracts";
import { waitFor } from "../../tests/testing.js";
import { SessionManager, type SessionManagerOptions } from "./SessionManager.js";
import { SessionStore } from "./SessionStore.js";
import { NEW_SESSION_TITLE } from "./sessionRestore.js";
import { sameWorktreePath } from "./worktreeCleanup.js";

class FakeDriver implements CliDriver {
  readonly kind = "claude" as const;
  requests: Array<{ sessionId: string; prompt: string; cwd: string }> = [];
  private turns = new Map<string, string>();
  constructor(private emit: (event: ThreadEvent) => void) {}
  async listSessions(): Promise<[]> {
    return [];
  }
  async getHistory(): Promise<HistoryMessage[]> {
    return [];
  }
  startTurn(request: { sessionId: string; prompt: string; cwd: string }): TurnHandle {
    const turnId = randomUUID();
    this.requests.push({ sessionId: request.sessionId, prompt: request.prompt, cwd: request.cwd });
    this.turns.set(turnId, request.sessionId);
    return { turnId, events: (async function* () {})() };
  }
  complete(turnId: string, resultText: string, isError = false): void {
    const sessionId = this.turns.get(turnId);
    if (!sessionId) return;
    this.turns.delete(turnId);
    this.emit({ type: "turn.done", turnId, sessionId, resumeCursor: `cursor-${turnId}`, resultText, usage: [], numTurns: 1, isError, backgroundTasks: 0 });
  }
  fail(turnId: string, message: string): void {
    this.turns.delete(turnId);
    this.emit({ type: "turn.error", turnId, message });
  }
  interrupt(): void {}
  async stopSession(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async *events(): AsyncIterable<never> {}
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", ...args], { encoding: "utf8" }).trim();
}

const managers: SessionManager[] = [];

function makeSandbox(options: Pick<SessionManagerOptions, "prState"> = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "cw-subagents-"));
  const repository = join(sandbox, "repo");
  execFileSync("git", ["init", "-b", "main", repository]);
  git(repository, "config", "core.autocrlf", "false");
  writeFileSync(join(repository, "README.md"), "base\n", "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  const dbPath = join(sandbox, "data", "test.db");
  const manager = new SessionManager({ dbPath, settingsPath: join(sandbox, "data", "settings.json"), worktreesRoot: join(sandbox, "worktrees"), ...options });
  managers.push(manager);
  const fake = new FakeDriver((event) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event));
  (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
  manager.setSettings({ autoTitleEnabled: false });
  const project = manager.addProject(repository);
  const store = (manager as unknown as { store: SessionStore }).store;
  return { manager, fake, project, repository, store, dbPath };
}

function localBranches(repository: string): string[] {
  return git(repository, "branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
}

const widgets: PrRef = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };

function statusOf(overrides: Partial<GitStatus>): GitStatus {
  return {
    available: true,
    branch: "main",
    dirtyCount: 0,
    addedLines: 0,
    deletedLines: 0,
    stagedCount: 0,
    ahead: 0,
    behind: 0,
    baseRef: "main",
    baseAhead: 0,
    baseBehind: 0,
    isWorktree: true,
    worktreeName: "wt",
    worktreePath: "",
    repositoryRoot: "",
    prNumber: widgets.number,
    pullRequest: null,
    githubError: null,
    githubHost: "github.com",
    githubAccount: null,
    githubAccountSource: "none",
    clean: true,
    ...overrides
  };
}

function openPullRequest(branch: string): NonNullable<GitStatus["pullRequest"]> {
  return {
    number: widgets.number,
    title: "Feature",
    url: "https://github.com/acme/widgets/pull/42",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: null,
    headRefName: branch,
    baseRefName: "main",
    headRefOid: "",
    updatedAt: 0,
    checks: { total: 0, passed: 0, failed: 0, pending: 0 }
  };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

describe("createSubagentSession", () => {
  it("shares the parent's worktree without creating a branch or worktree", async () => {
    const { manager, repository, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude");
    const branchesBefore = localBranches(repository);

    const child = await manager.createSubagentSession(parent.id, "codex", { title: "Review the diff", isolation: "shared" });

    expect(child.worktreePath).toBe(parent.worktreePath);
    expect(child.branch).toBeUndefined();
    expect(child.title).toBe("Review the diff");
    expect(child.driver).toBe("codex");
    expect(child.subagent).toEqual({ parentSessionId: parent.id, isolation: "shared" });
    expect(localBranches(repository)).toEqual(branchesBefore);
    expect(manager.listSubagents(parent.id).map((session) => session.id)).toEqual([child.id]);
  });

  it("runs a child of a root-checkout parent at the root while the parent is working", async () => {
    const { manager, fake, repository, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    await manager.startTurn(parent.id, "dispatch");
    const headBefore = git(repository, "rev-parse", "--abbrev-ref", "HEAD");

    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child task", isolation: "shared" });
    await manager.startTurn(child.id, "work");

    expect(child.worktreePath).toBeUndefined();
    expect(child.branch).toBeUndefined();
    expect(fake.requests.find((request) => request.sessionId === child.id)?.cwd).toBe(repository);
    expect(git(repository, "rev-parse", "--abbrev-ref", "HEAD")).toBe(headBefore);
    expect(headBefore).toBe(parent.branch ?? "");
  });

  it("starts an isolated child on its own worktree and branch from the parent's current HEAD", async () => {
    const { manager, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude");
    const parentPath = parent.worktreePath ?? "";
    writeFileSync(join(parentPath, "parent.txt"), "parent\n", "utf8");
    git(parentPath, "add", "parent.txt");
    git(parentPath, "commit", "-m", "parent work");

    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Isolated", isolation: "worktree" });

    expect(child.subagent).toEqual({ parentSessionId: parent.id, isolation: "worktree" });
    expect(child.worktreePath).toBeDefined();
    expect(sameWorktreePath(child.worktreePath ?? "", parentPath)).toBe(false);
    expect(child.branch).toBeDefined();
    expect(child.branch).not.toBe(parent.branch);
    expect(existsSync(join(child.worktreePath ?? "", "parent.txt"))).toBe(true);
    expect(git(child.worktreePath ?? "", "rev-parse", "HEAD")).toBe(git(parentPath, "rev-parse", "HEAD"));
  });

  it("rejects unknown, nested, resolved and untitled requests", async () => {
    const { manager, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });

    await expect(manager.createSubagentSession("sess_missing", "claude", { title: "x", isolation: "shared" })).rejects.toThrow("unknown session");
    await expect(manager.createSubagentSession(child.id, "claude", { title: "x", isolation: "shared" })).rejects.toThrow("subagents cannot dispatch subagents");
    await expect(manager.createSubagentSession(parent.id, "claude", { title: "  ", isolation: "shared" })).rejects.toThrow("title");
    manager.setSessionStatus(parent.id, "resolved");
    await expect(manager.createSubagentSession(parent.id, "claude", { title: "x", isolation: "shared" })).rejects.toThrow("resolved");
  });

  it("recovers a missing shared worktree through the parent without a new branch", async () => {
    const { manager, repository, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude");
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    git(repository, "worktree", "remove", "--force", parent.worktreePath ?? "");
    const branchesBefore = localBranches(repository);

    const path = await manager.ensureWorktree(child.id);

    expect(sameWorktreePath(path, parent.worktreePath ?? "")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(localBranches(repository)).toEqual(branchesBefore);
  });

  it("refuses to recreate a missing shared worktree the parent no longer uses", async () => {
    const { manager, repository, project, store } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude");
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    git(repository, "worktree", "remove", "--force", parent.worktreePath ?? "");
    store.updateSession(parent.id, { worktreePath: undefined });
    const branchesBefore = localBranches(repository);

    await expect(manager.ensureWorktree(child.id)).rejects.toThrow("shared with the parent");
    expect(localBranches(repository)).toEqual(branchesBefore);
  });

  it("never takes the parent's branch or PR from a git status sync", async () => {
    const { manager, project, store } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude");
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    const parentStatus = statusOf({
      branch: parent.branch ?? "",
      worktreePath: parent.worktreePath ?? "",
      pullRequest: openPullRequest(parent.branch ?? "")
    });

    expect(manager.syncFromStatus(child.id, parentStatus)).toBeNull();
    expect(store.getSession(child.id)?.branch).toBeUndefined();
    expect(store.getSession(child.id)?.prs).toBeUndefined();
    expect(manager.syncFromStatus(parent.id, parentStatus)?.prs?.length).toBe(1);
  });

  it("starts an isolated child's diffs from the parent's branch and keeps title-based branch renaming", async () => {
    const { manager, fake, project, store } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude");
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Fix the flaky login test", isolation: "worktree" });
    const originalBranch = child.branch;

    expect(child.baseRef).toBe(parent.branch);
    fake.complete(await manager.startTurn(child.id, "go"), "done");

    await waitFor(() => expect(store.getSession(child.id)?.branch).not.toBe(originalBranch));
  });

  it("does not let a shared child with a linked PR enter babysit", async () => {
    const { manager, fake, project, store } = makeSandbox({ prState: () => "OPEN" });
    const link = { ref: widgets, origin: "workflow" as const, workflowId: "babysit", lastSeenSha: "old", lastSeenAt: 0 };
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    const control = await manager.createSession(project.id, "claude", { mode: "current" });
    for (const id of [child.id, control.id]) manager.linkPr(id, link);

    fake.complete(await manager.startTurn(child.id, "go"), "done");
    fake.complete(await manager.startTurn(control.id, "go"), "done");

    expect(store.getSession(control.id)?.status).toBe("babysit");
    expect(store.getSession(child.id)?.status).toBe("done");
  });

  it("does not let a live child block the parent's branch rename", async () => {
    const { manager, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude");
    await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    const shared = (manager as unknown as { branchShared(id: string, path: string, branch: string): boolean }).branchShared(
      parent.id,
      parent.worktreePath ?? "",
      parent.branch ?? ""
    );

    expect(shared).toBe(false);
  });
});

describe("subagent sessions in turns and sweeps", () => {
  it("never launches a title turn for a child", async () => {
    const { manager, fake, project } = makeSandbox();
    manager.setSettings({ autoTitleEnabled: true });
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: NEW_SESSION_TITLE, isolation: "shared" });
    const control = await manager.createSession(project.id, "claude", { mode: "current" });
    await manager.startTurn(control.id, "name me");
    const titleTurnsForControl = fake.requests.filter((request) => request.sessionId === `title:${control.id}`).length;

    await manager.startTurn(child.id, "do not name me");

    expect(titleTurnsForControl).toBe(1);
    expect(fake.requests.filter((request) => request.sessionId === `title:${child.id}`)).toEqual([]);
    expect((await manager.listSessions(project.id)).find((session) => session.id === child.id)?.title).toBe(NEW_SESSION_TITLE);
  });

  it("skips children in the idle, holding and import-claim sweeps", async () => {
    const { manager, project, store } = makeSandbox();
    manager.setSettings({ idleResolveAfterDays: 1, holdingAutoExpireEnabled: true, holdingHours: 1 });
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const idleChild = await manager.createSubagentSession(parent.id, "claude", { title: "Idle child", isolation: "shared" });
    const holdingChild = await manager.createSubagentSession(parent.id, "claude", { title: "Holding child", isolation: "shared" });
    const idleControl = await manager.createSession(project.id, "claude", { mode: "current" });
    const holdingControl = await manager.createSession(project.id, "claude", { mode: "current" });
    const longAgo = Date.now() - 10 * 86_400_000;
    for (const id of [idleChild.id, idleControl.id]) {
      const session = store.getSession(id) as SessionMeta;
      session.idleSince = longAgo;
    }
    for (const id of [holdingChild.id, holdingControl.id]) {
      store.updateSession(id, { status: "holding" }, "turn-seen");
      (store.getSession(id) as SessionMeta).updatedAt = longAgo;
    }

    const resolved = await manager.resolveExpiredIdleSessions();
    const expired = manager.expireDueHoldingSessions().map((session) => session.id);

    expect(resolved).toEqual([idleControl.id]);
    expect(expired).toEqual([holdingControl.id]);
    expect(manager.expireHoldingSessions([holdingChild.id])).toEqual([]);
    expect(store.getSession(idleChild.id)?.status).toBe("idle");
    expect(store.getSession(holdingChild.id)?.status).toBe("holding");
  });

  it("skips children in the finished-PR sweep", async () => {
    const { manager, project, store } = makeSandbox({ prState: () => "MERGED" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });
    const link = { ref: widgets, origin: "workflow" as const, workflowId: "babysit", lastSeenSha: "old", lastSeenAt: 0 };
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    const control = await manager.createSession(project.id, "claude", { mode: "current" });
    for (const id of [child.id, control.id]) {
      manager.linkPr(id, link);
      store.updateSession(id, { status: "holding" }, "turn-seen");
    }

    expect(await manager.settleFinishedPrSessions()).toEqual([control.id]);
    expect(store.getSession(child.id)?.status).toBe("holding");
  });

  it("does not turn a titled child that never ran into an import claim", async () => {
    const { manager, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    await manager.createSubagentSession(parent.id, "claude", { title: "Never ran", isolation: "shared" });
    const claims = (manager as unknown as { pendingImportClaims(): unknown[] }).pendingImportClaims();

    expect(claims).toEqual([]);
  });

  it("keeps import claims for a child that has a turn in flight or ran without a cursor", async () => {
    const { manager, project, repository, store } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    const claims = () => (manager as unknown as { pendingImportClaims(): Array<{ driver: string; root: string; since: number }> }).pendingImportClaims();

    const turnId = await manager.startTurn(child.id, "work");
    expect(claims().map((claim) => claim.driver)).toEqual(["claude"]);

    manager.interrupt(turnId);
    const snapshot = store.getSession(child.id)?.lastTurnSnapshot;
    expect(snapshot).toBeDefined();
    expect(claims()).toEqual([{ driver: "claude", root: repository, since: snapshot?.capturedAt ?? 0 }]);
  });
});

describe("subagent results", () => {
  it("records the settled turn and resets delivery on every settle", async () => {
    const { manager, fake, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });

    const first = await manager.startTurn(child.id, "one");
    fake.complete(first, "first answer");
    const afterFirst = manager.listSubagents(parent.id)[0]?.subagent;
    expect(afterFirst?.result?.turnId).toBe(first);
    expect(afterFirst?.result?.outcome).toBe("done");
    expect(afterFirst?.result?.text).toBe("first answer");
    expect(afterFirst?.delivered).toBe(false);

    manager.markSubagentDelivered(child.id, "another-turn");
    expect(manager.listSubagents(parent.id)[0]?.subagent?.delivered).toBe(false);
    manager.markSubagentDelivered(child.id, first);
    expect(manager.listSubagents(parent.id)[0]?.subagent?.delivered).toBe(true);

    const second = await manager.startTurn(child.id, "two");
    fake.fail(second, "boom");
    const afterSecond = manager.listSubagents(parent.id)[0]?.subagent;
    expect(afterSecond?.result?.turnId).toBe(second);
    expect(afterSecond?.result?.outcome).toBe("error");
    expect(afterSecond?.result?.text).toBe("boom");
    expect(afterSecond?.delivered).toBe(false);

    const third = await manager.startTurn(child.id, "three");
    manager.interrupt(third);
    const afterThird = manager.listSubagents(parent.id)[0]?.subagent;
    expect(afterThird?.result?.turnId).toBe(third);
    expect(afterThird?.result?.outcome).toBe("interrupted");
    expect(afterThird?.result?.text).toBeNull();
    expect(afterThird?.delivered).toBe(false);
  });

  it("leaves non-child sessions without a subagent link", async () => {
    const { manager, fake, project, store } = makeSandbox();
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    fake.complete(await manager.startTurn(session.id, "go"), "done");

    expect(store.getSession(session.id)?.subagent).toBeUndefined();
  });

  it("maps a child that was working at restart to an interrupted, undelivered result", async () => {
    const { manager, project, store, dbPath } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    const turnId = await manager.startTurn(child.id, "long task");
    expect(store.getSession(child.id)?.status).toBe("working");

    const reloaded = new SessionStore(dbPath).getSession(child.id);

    expect(reloaded?.status).toBe("holding");
    expect(reloaded?.subagent?.result?.turnId).toBe(turnId);
    expect(reloaded?.subagent?.result?.outcome).toBe("interrupted");
    expect(reloaded?.subagent?.result?.text).toBeNull();
    expect(reloaded?.subagent?.delivered).toBe(false);
  });

  it("uses a synthetic restart turn id when the working turn already settled", async () => {
    const { manager, fake, project, store, dbPath } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    const settledTurn = await manager.startTurn(child.id, "task");
    fake.complete(settledTurn, "answer");
    manager.markSubagentDelivered(child.id, settledTurn);
    store.updateSession(child.id, { status: "working" }, "turn-start");

    const result = new SessionStore(dbPath).getSession(child.id)?.subagent?.result;

    expect(result?.outcome).toBe("interrupted");
    expect(result?.turnId).not.toBe(settledTurn);
    expect(result?.turnId.startsWith("restart:")).toBe(true);
  });

  it("drops a malformed subagent link on load", async () => {
    const { manager, project, store, dbPath } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    const valid = await manager.createSubagentSession(parent.id, "claude", { title: "Valid", isolation: "shared" });
    const broken = store.getSession(child.id) as SessionMeta;
    broken.subagent = { parentSessionId: "", isolation: "shared" } satisfies SubagentLink;
    store.updateSession(child.id, { title: "Child" });

    const reloaded = new SessionStore(dbPath);

    expect(reloaded.getSession(child.id)?.subagent).toBeUndefined();
    expect(reloaded.getSession(valid.id)?.subagent).toEqual({ parentSessionId: parent.id, isolation: "shared" });
  });
});
