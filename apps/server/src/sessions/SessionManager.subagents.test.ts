import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CliDriver, HistoryMessage, SessionMeta, ThreadEvent, TurnHandle } from "@cw-code/contracts";
import { SessionManager } from "./SessionManager.js";
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

function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), "cw-subagents-"));
  const repository = join(sandbox, "repo");
  execFileSync("git", ["init", "-b", "main", repository]);
  git(repository, "config", "core.autocrlf", "false");
  writeFileSync(join(repository, "README.md"), "base\n", "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  const dbPath = join(sandbox, "data", "test.db");
  const manager = new SessionManager({ dbPath, settingsPath: join(sandbox, "data", "settings.json"), worktreesRoot: join(sandbox, "worktrees") });
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

  it("refuses to recreate a missing shared worktree instead of branching", async () => {
    const { manager, repository, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude");
    const child = await manager.createSubagentSession(parent.id, "claude", { title: "Child", isolation: "shared" });
    git(repository, "worktree", "remove", "--force", parent.worktreePath ?? "");
    const branchesBefore = localBranches(repository);

    await expect(manager.ensureWorktree(child.id)).rejects.toThrow("shared with the parent");
    expect(localBranches(repository)).toEqual(branchesBefore);
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
    expect(store.getSession(idleChild.id)?.status).toBe("idle");
    expect(store.getSession(holdingChild.id)?.status).toBe("holding");
  });

  it("does not turn a titled child without a cursor into an import claim", async () => {
    const { manager, project } = makeSandbox();
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    await manager.createSubagentSession(parent.id, "claude", { title: "Never ran", isolation: "shared" });
    const claims = (manager as unknown as { pendingImportClaims(): unknown[] }).pendingImportClaims();

    expect(claims).toEqual([]);
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
});
