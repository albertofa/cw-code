import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CliDriver, HistoryMessage, ThreadEvent, TurnHandle } from "@cw-code/contracts";
import { SessionManager } from "./SessionManager.js";

class FakeDriver implements CliDriver {
  readonly kind = "claude" as const;
  seen: string[] = [];
  lastRequest: Record<string, unknown> | null = null;
  private pending = new Map<string, { sessionId: string; prompt: string }>();
  constructor(private emit: (event: ThreadEvent) => void) {}
  async listSessions(): Promise<[]> {
    return [];
  }
  async getHistory(): Promise<HistoryMessage[]> {
    return [];
  }
  startTurn(request: { sessionId: string; prompt: string }): TurnHandle {
    const turnId = randomUUID();
    this.seen.push(request.prompt);
    this.lastRequest = { ...(request as Record<string, unknown>) };
    this.pending.set(turnId, { sessionId: request.sessionId, prompt: request.prompt });
    queueMicrotask(() => {
      if (this.pending.has(turnId)) {
        this.emit({ type: "assistant.delta", turnId, text: `echo:${request.prompt}` });
      }
    });
    return { turnId, events: (async function* () {})() };
  }
  complete(turnId: string): void {
    const pending = this.pending.get(turnId);
    if (!pending) return;
    this.pending.delete(turnId);
    this.emit({
      type: "turn.done",
      turnId,
      sessionId: pending.sessionId,
      resumeCursor: `cursor-${turnId}`,
      resultText: `echo:${pending.prompt}`,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      numTurns: 1,
      isError: false
    });
  }
  completeAll(): void {
    for (const turnId of [...this.pending.keys()]) this.complete(turnId);
  }
  interrupt(): void {}
  async renameSession(): Promise<void> {}
  async *events(): AsyncIterable<never> {}
}

function makeManager() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "cw-test-")), "test.db");
  const received: Array<{ sessionId: string; event: ThreadEvent }> = [];
  const manager = new SessionManager({
    dbPath,
    onEvent: (sessionId, event) => received.push({ sessionId, event })
  });
  const fake = new FakeDriver((e) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(e));
  (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = {
    claude: fake,
    opencode: fake,
    codex: fake
  };
  return { manager, received, fake };
}

describe("SessionManager", () => {
  it("normalizes trailing separators on project roots", () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj\\");
    expect(project.rootPath).toBe("C:\\proj");
    expect(manager.addProject("C:\\proj").id).toBe(project.id);
    manager.dispose();
  });  it("runs parallel turns on different sessions without crossing streams", async () => {
    const { manager, received, fake } = makeManager();
    const project = manager.addProject("C:\\proj");
    const a = await manager.createSession(project.id, "claude");
    const b = await manager.createSession(project.id, "claude");
    const turnA = await manager.startTurn(a.id, "prompt-a");
    const turnB = await manager.startTurn(b.id, "prompt-b");
    expect(turnA).not.toBe(turnB);
    await new Promise((r) => setTimeout(r, 50));
    fake.completeAll();
    const forA = received.filter((r) => r.sessionId === a.id);
    const forB = received.filter((r) => r.sessionId === b.id);
    expect(forA.some((r) => r.event.type === "assistant.delta" && "text" in r.event && r.event.text.includes("prompt-a"))).toBe(true);
    expect(forB.some((r) => r.event.type === "assistant.delta" && "text" in r.event && r.event.text.includes("prompt-b"))).toBe(true);
    expect(forA.some((r) => r.event.type === "assistant.delta" && "text" in r.event && r.event.text.includes("prompt-b"))).toBe(false);
    manager.dispose();
  });

  it("rejects a second turn on a busy session", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj2");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "first");
    await expect(manager.startTurn(a.id, "second")).rejects.toThrow(/busy/);
    manager.dispose();
  });

  it("lists CLI-native sessions as discovered without storing them", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj4");
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.claude = {
      kind: "claude",
      listSessions: async () => [
        {
          id: "claude:abc",
          projectId: project.id,
          driver: "claude",
          title: "external work",
          status: "idle",
          resumeCursor: "abc",
          createdAt: 1,
          updatedAt: 2
        }
      ],
      getHistory: async () => [],
      startTurn: () => {
        throw new Error("not used");
      },
      interrupt: () => {},
      renameSession: async () => {},
      async *events() {}
    };
    const discovered = await manager.listDiscovered(project.id);
    expect(discovered.map((d) => d.id)).toEqual(["ext:claude:abc"]);
    expect((await manager.listSessions(project.id)).length).toBe(0);
    const imported = await manager.importSession(project.id, "claude", "abc", "external work");
    expect(imported.resumeCursor).toBe("abc");
    expect((await manager.listDiscovered(project.id)).length).toBe(0);
    expect((await manager.listSessions(project.id)).length).toBe(1);
    manager.dispose();
  });

  it("persists the resume cursor from turn.done", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj3");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "hello");
    fake.completeAll();
    await new Promise((r) => setTimeout(r, 20));
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.resumeCursor).toMatch(/^cursor-/);
    manager.dispose();
  });

  it("persists composer prefs per session with global defaults", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj5");
    const a = await manager.createSession(project.id, "claude");
    expect(manager.getComposer(a.id)).toMatchObject({ effort: "medium", permissionMode: "auto" });
    manager.setComposer(a.id, { model: "sonnet", effort: "high", permissionMode: "plan" });
    expect(manager.getComposer(a.id)).toMatchObject({ model: "sonnet", effort: "high", permissionMode: "plan" });
    const b = await manager.createSession(project.id, "claude");
    expect(manager.getComposer(b.id)).toMatchObject({ effort: "medium", permissionMode: "auto" });
    manager.dispose();
  });

  it("forwards stored prefs on startTurn and lets explicit opts override without mutating stored prefs", async () => {
    const { manager, fake } = makeManager();
    const root = mkdtempSync(join(tmpdir(), "cw-session-prefs-"));
    const project = manager.addProject(root);
    const a = await manager.createSession(project.id, "claude");
    manager.setComposer(a.id, { model: "sonnet", effort: "high", permissionMode: "plan" });
    await manager.startTurn(a.id, "stored");
    expect(fake.lastRequest).toMatchObject({ model: "sonnet", effort: "high", permissionMode: "plan" });
    fake.completeAll();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(root, "a.ts"), "x", "utf8");
    await manager.startTurn(a.id, "override", { prefs: { model: "opus" }, attachments: ["a.ts"] });
    expect(fake.lastRequest).toMatchObject({ model: "opus", effort: "high", attachments: ["a.ts"] });
    expect(manager.getComposer(a.id).model).toBe("sonnet");
    manager.dispose();
  });

  it("lists models and resolves roots per project without a session", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj7");
    const curated = await manager.listModelsFor(project.id, "claude");
    expect(curated.length).toBeGreaterThan(0);
    expect(curated[0]).toMatchObject({ id: expect.any(String), label: expect.any(String) });
    await expect(manager.listModelsFor(project.id, "opencode")).resolves.toEqual([]);
    expect(manager.rootForProject(project.id)).toBe("C:\\proj7");
    await expect(manager.listModelsFor("missing", "opencode")).rejects.toThrow("unknown project");
    expect(() => manager.rootForProject("missing")).toThrow("unknown project");
    manager.dispose();
  });

  it("creates Git sessions in isolated worktrees and routes turns there", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-session-worktree-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

    const manager = new SessionManager({
      dbPath: join(sandbox, "data", "test.db"),
      worktreesRoot: join(sandbox, "worktrees")
    });
    const fake = new FakeDriver((event) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event));
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
    const project = manager.addProject(repository);
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });

    expect(session.worktreePath).toBeTruthy();
    expect(session.branch).toMatch(/^cw\//);
    expect(manager.rootFor(session.id)).toBe(session.worktreePath);
    await manager.startTurn(session.id, "isolated");
    expect(fake.lastRequest?.cwd).toBe(session.worktreePath);
    manager.dispose();
  });

  it("recreates a deleted worktree at the same path on the next turn", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-session-recover-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

    const manager = new SessionManager({
      dbPath: join(sandbox, "data", "test.db"),
      worktreesRoot: join(sandbox, "worktrees")
    });
    const fake = new FakeDriver((event) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event));
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
    const project = manager.addProject(repository);
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const originalBranch = session.branch;
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    expect(originalBranch).toMatch(/^cw\//);

    rmSync(worktreePath, { recursive: true, force: true });
    expect(existsSync(worktreePath)).toBe(false);
    expect(() => manager.rootFor(session.id)).toThrow(/missing/);

    await manager.startTurn(session.id, "recovered");
    expect(existsSync(worktreePath)).toBe(true);
    expect(fake.lastRequest?.cwd).toBe(worktreePath);
    const sessions = await manager.listSessions(project.id);
    const stored = sessions.find((s) => s.id === session.id);
    expect(stored?.branch).toMatch(/^cw\//);
    const checkedOut = execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(checkedOut).toBe(stored?.branch);
    manager.dispose();
  });

  it("throws a descriptive error when worktree recovery fails because the branch is gone", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-session-recover-fail-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

    const manager = new SessionManager({
      dbPath: join(sandbox, "data", "test.db"),
      worktreesRoot: join(sandbox, "worktrees")
    });
    const fake = new FakeDriver((event) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event));
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
    const project = manager.addProject(repository);
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    const orphanBranch = session.branch;
    if (!worktreePath || !orphanBranch) throw new Error("expected a worktree-backed session with a branch");

    rmSync(worktreePath, { recursive: true, force: true });
    execFileSync("git", ["-C", repository, "worktree", "prune"]);
    execFileSync("git", ["-C", repository, "branch", "-D", orphanBranch]);

    await expect(manager.startTurn(session.id, "should fail")).rejects.toThrow(/could not recreate worktree/);
    expect(fake.seen).toHaveLength(0);
    manager.dispose();
  });

  it("does not recreate git state when ensureWorktree is called twice on an existing worktree", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-session-idempotent-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

    const manager = new SessionManager({
      dbPath: join(sandbox, "data", "test.db"),
      worktreesRoot: join(sandbox, "worktrees")
    });
    const project = manager.addProject(repository);
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    expect(session.branch).toMatch(/^cw\//);

    const rootA = await manager.ensureWorktree(session.id);
    const branchesBefore = execFileSync("git", ["-C", repository, "branch", "--list", `${session.branch}*`], { encoding: "utf8" });
    const rootB = await manager.ensureWorktree(session.id);
    const branchesAfter = execFileSync("git", ["-C", repository, "branch", "--list", `${session.branch}*`], { encoding: "utf8" });

    expect(rootA).toBe(worktreePath);
    expect(rootB).toBe(worktreePath);
    expect(branchesAfter).toBe(branchesBefore);
    manager.dispose();
  });

  it("tracks session status across the turn lifecycle", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-status");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");
    let sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("working");
    (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({
      type: "approval.request",
      turnId,
      request: { requestId: "req-1", kind: "command", title: "run?", decisions: ["accept", "decline"] }
    });
    sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("input-required");
    fake.completeAll();
    sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("done");
    manager.dispose();
  });
});
