import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CliDriver, HistoryMessage, ModelOption, ThreadEvent, TurnHandle } from "@cw-code/contracts";
import { SessionManager } from "./SessionManager.js";
import type { SessionStore } from "./SessionStore.js";

class FakeDriver implements CliDriver {
  readonly kind = "claude" as const;
  seen: string[] = [];
  stoppedSessions: string[] = [];
  lastRequest: Record<string, unknown> | null = null;
  history: HistoryMessage[] = [];
  private pending = new Map<string, { sessionId: string; prompt: string }>();
  constructor(private emit: (event: ThreadEvent) => void) {}
  async listSessions(): Promise<[]> {
    return [];
  }
  async getHistory(): Promise<HistoryMessage[]> {
    return this.history;
  }
  subagentCalls: Array<{ rootPath: string; resumeCursor: string; agentId: string }> = [];
  async getSubagentTools(rootPath: string, resumeCursor: string, agentId: string) {
    this.subagentCalls.push({ rootPath, resumeCursor, agentId });
    return { items: [{ id: "tu1", name: "Read", input: null, output: "file" }], model: "claude-sonnet-5" };
  }
  startTurn(request: { sessionId: string; prompt: string }): TurnHandle {
    const turnId = randomUUID();
    this.seen.push(request.prompt);
    this.lastRequest = { ...(request as Record<string, unknown>) };
    this.pending.set(turnId, { sessionId: request.sessionId, prompt: request.prompt });
    queueMicrotask(() => {
      if (this.pending.has(turnId) && !request.sessionId.startsWith("title:")) {
        this.emit({ type: "assistant.delta", turnId, text: `echo:${request.prompt}` });
      }
    });
    return { turnId, events: (async function* () {})() };
  }
  complete(turnId: string, backgroundTasks = 0): void {
    const pending = this.pending.get(turnId);
    if (!pending) return;
    if (backgroundTasks === 0) this.pending.delete(turnId);
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
      isError: false,
      backgroundTasks
    });
  }
  completeTitle(text: string): void {
    for (const [turnId, pending] of [...this.pending]) {
      if (!pending.sessionId.startsWith("title:")) continue;
      this.pending.delete(turnId);
      this.emit({ type: "assistant.delta", turnId, text });
      this.emit({
        type: "turn.done",
        turnId,
        sessionId: pending.sessionId,
        resumeCursor: `cursor-${turnId}`,
        resultText: text,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        numTurns: 1,
        isError: false,
        backgroundTasks: 0
      });
    }
  }
  completeTitleError(resultText: string): void {
    for (const [turnId, pending] of [...this.pending]) {
      if (!pending.sessionId.startsWith("title:")) continue;
      this.pending.delete(turnId);
      this.emit({
        type: "turn.done",
        turnId,
        sessionId: pending.sessionId,
        resumeCursor: `cursor-${turnId}`,
        resultText,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        numTurns: 1,
        isError: true,
        backgroundTasks: 0
      });
    }
  }
  failTitle(partial: string): void {
    for (const [turnId, pending] of [...this.pending]) {
      if (!pending.sessionId.startsWith("title:")) continue;
      this.pending.delete(turnId);
      this.emit({ type: "assistant.delta", turnId, text: partial });
      this.emit({ type: "turn.error", turnId, message: "title turn failed" });
    }
  }
  completeAll(): void {
    for (const turnId of [...this.pending.keys()]) this.complete(turnId);
  }
  interrupt(): void {}
  stopSession(sessionId: string): void {
    this.stoppedSessions.push(sessionId);
  }
  async renameSession(): Promise<void> {}
  async *events(): AsyncIterable<never> {}
}

class ModelRecordingDriver implements CliDriver {
  readonly kind = "opencode" as const;
  modelCwds: string[] = [];
  stoppedSessions: string[] = [];
  constructor(private emit: (event: ThreadEvent) => void) {}
  async listSessions(): Promise<[]> {
    return [];
  }
  async getHistory(): Promise<HistoryMessage[]> {
    return [];
  }
  async listModels(cwd: string): Promise<ModelOption[]> {
    this.modelCwds.push(cwd);
    return [];
  }
  startTurn(): TurnHandle {
    const turnId = randomUUID();
    return { turnId, events: (async function* () {})() };
  }
  interrupt(): void {}
  stopSession(sessionId: string): void {
    this.stoppedSessions.push(sessionId);
  }
  async renameSession(): Promise<void> {}
  async *events(): AsyncIterable<never> {}
}

function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), "cw-test-"));
  const received: Array<{ sessionId: string; event: ThreadEvent }> = [];
  const titles: Array<{ sessionId: string; title: string }> = [];
  const manager = new SessionManager({
    dbPath: join(dir, "test.db"),
    settingsPath: join(dir, "settings.json"),
    onEvent: (sessionId, event) => received.push({ sessionId, event }),
    onTitle: (sessionId, title) => titles.push({ sessionId, title })
  });
  const fake = new FakeDriver((e) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(e));
  (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = {
    claude: fake,
    opencode: fake,
    codex: fake
  };
  manager.setSettings({ autoTitleEnabled: false });
  return { manager, received, fake, titles };
}

async function waitForBranch(manager: SessionManager, projectId: string, sessionId: string, predicate: (branch: string | undefined) => boolean): Promise<string | undefined> {
  for (let i = 0; i < 100; i += 1) {
    const branch = (await manager.listSessions(projectId)).find((s) => s.id === sessionId)?.branch;
    if (predicate(branch)) return branch;
    await new Promise((r) => setTimeout(r, 50));
  }
  return (await manager.listSessions(projectId)).find((s) => s.id === sessionId)?.branch;
}

function makeGitSandboxManager(prefix: string) {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  const repository = join(sandbox, "repo");
  execFileSync("git", ["init", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "base\n", "utf8");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

  const received: Array<{ sessionId: string; event: ThreadEvent }> = [];
  const manager = new SessionManager({
    dbPath: join(sandbox, "data", "test.db"),
    settingsPath: join(sandbox, "data", "settings.json"),
    worktreesRoot: join(sandbox, "worktrees"),
    onEvent: (sessionId, event) => received.push({ sessionId, event })
  });
  const fake = new FakeDriver((event) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event));
  (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
  manager.setSettings({ autoTitleEnabled: false });
  const project = manager.addProject(repository);
  return { manager, fake, project, repository, received };
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

  it("rejects a concurrent second startTurn on the same session", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-busy");
    const a = await manager.createSession(project.id, "claude");
    const results = await Promise.allSettled([
      manager.startTurn(a.id, "first"),
      manager.startTurn(a.id, "second")
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(Error);
    expect(rejected[0].reason.message).toMatch(/busy/);
    expect(fake.seen).toEqual(["first"]);
    manager.dispose();
  });

  it("returns the project root for sessions without a worktree", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-nowt");
    const a = await manager.createSession(project.id, "claude");
    expect(a.worktreePath).toBeFalsy();
    await expect(manager.ensureWorktree(a.id)).resolves.toBe("C:\\proj-nowt");
    manager.dispose();
  });

  it("routes subagent tool lookups through the session driver", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-subagents");
    const a = await manager.createSession(project.id, "claude");
    const result = await manager.getSubagentTools(a.id, "agent-1");
    expect(result.model).toBe("claude-sonnet-5");
    expect(fake.subagentCalls).toEqual([{ rootPath: "C:\\proj-subagents", resumeCursor: "", agentId: "agent-1" }]);
    manager.dispose();
  });

  it("returns an empty result when the driver has no subagent source", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-subagents-none");
    const a = await manager.createSession(project.id, "claude");
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.claude = {
      kind: "claude",
      listSessions: async () => [],
      getHistory: async () => [],
      startTurn: () => {
        throw new Error("not used");
      },
      interrupt: () => {},
      renameSession: async () => {},
      async *events() {}
    };
    await expect(manager.getSubagentTools(a.id, "agent-1")).resolves.toEqual({ items: [] });
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
    manager.setComposer(a.id, { model: "sonnet", effort: "high", permissionMode: "manual" });
    expect(manager.getComposer(a.id)).toMatchObject({ model: "sonnet", effort: "high", permissionMode: "manual" });
    const b = await manager.createSession(project.id, "claude");
    expect(manager.getComposer(b.id)).toMatchObject({ effort: "medium", permissionMode: "auto" });
    manager.dispose();
  });

  it("returns undefined model when unset without falling back to the claude default", async () => {
    const { manager } = makeManager();
    manager.setSettings({ claudeDefaultModel: "should-not-appear" });
    const project = manager.addProject("C:\\proj5-unset-model");
    const a = await manager.createSession(project.id, "claude");
    expect(manager.getComposer(a.id).model).toBeUndefined();
    manager.dispose();
  });

  it("maps a retired stored plan permission to manual", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-plan-legacy");
    const session = await manager.createSession(project.id, "claude");
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { permissionMode: "plan" as never });
    expect(manager.getComposer(session.id)).toMatchObject({ permissionMode: "manual" });
    manager.dispose();
  });

  it("forwards stored prefs on startTurn and lets explicit opts override without mutating stored prefs", async () => {
    const { manager, fake } = makeManager();
    const root = mkdtempSync(join(tmpdir(), "cw-session-prefs-"));
    const project = manager.addProject(root);
    const a = await manager.createSession(project.id, "claude");
    manager.setComposer(a.id, { model: "sonnet", effort: "high", permissionMode: "manual" });
    await manager.startTurn(a.id, "stored");
    expect(fake.lastRequest).toMatchObject({ model: "sonnet", effort: "high", permissionMode: "manual" });
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
      settingsPath: join(sandbox, "data", "settings.json"),
      worktreesRoot: join(sandbox, "worktrees")
    });
    const fake = new FakeDriver((event) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event));
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
    manager.setSettings({ autoTitleEnabled: false });
    const project = manager.addProject(repository);
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });

    expect(session.worktreePath).toBeTruthy();
    expect(session.branch).toMatch(/^cw\//);
    expect(manager.rootFor(session.id)).toBe(session.worktreePath);
    await manager.startTurn(session.id, "isolated");
    expect(fake.lastRequest?.cwd).toBe(session.worktreePath);
    manager.dispose();
  });

  it("reuses a previous worktree without creating a new branch", async () => {
    const { manager, project, repository } = makeGitSandboxManager("cw-session-reuse-");
    const a = await manager.createSession(project.id, "claude", { mode: "new", baseBranch: "main" });
    if (!a.worktreePath) throw new Error("expected a worktree-backed session");
    const branchCount = () =>
      execFileSync("git", ["-C", repository, "for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding: "utf8" })
        .split("\n").filter(Boolean).length;
    const before = branchCount();

    const b = await manager.createSession(project.id, "claude", { mode: "previous", reuseWorktreePath: a.worktreePath });

    expect(b.worktreePath).toBe(a.worktreePath);
    expect(b.branch).toBe(a.branch);
    expect(manager.rootFor(b.id)).toBe(a.worktreePath);
    expect(branchCount()).toBe(before);
    manager.dispose();
  });

  it("falls back to a new worktree when the reuse path does not exist", async () => {
    const { manager, project } = makeGitSandboxManager("cw-session-reuse-missing-");
    const session = await manager.createSession(project.id, "claude", {
      mode: "previous",
      reuseWorktreePath: join(project.rootPath, "..", "does-not-exist")
    });
    expect(session.worktreePath).toBeTruthy();
    expect(session.worktreePath).not.toContain("does-not-exist");
    expect(session.branch).toMatch(/^cw\//);
    manager.dispose();
  });

  it("falls back to a new worktree when the reuse path is outside the app worktrees root", async () => {
    const { manager, project, repository } = makeGitSandboxManager("cw-session-reuse-outside-");
    const session = await manager.createSession(project.id, "claude", {
      mode: "previous",
      reuseWorktreePath: repository
    });
    expect(session.worktreePath).toBeTruthy();
    expect(session.worktreePath).not.toBe(repository);
    expect(session.branch).toMatch(/^cw\//);
    manager.dispose();
  });

  it("creates sessions without a worktree in current mode", async () => {
    const { manager, project } = makeGitSandboxManager("cw-session-current-");
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    expect(session.worktreePath).toBeUndefined();
    expect(manager.rootFor(session.id)).toBe(project.rootPath);
    manager.dispose();
  });

  it("treats a missing mode with useWorktree false as current checkout", async () => {
    const { manager, project } = makeGitSandboxManager("cw-session-compat-");
    const session = await manager.createSession(project.id, "claude", { useWorktree: false });
    expect(session.worktreePath).toBeUndefined();
    expect(manager.rootFor(session.id)).toBe(project.rootPath);
    manager.dispose();
  });

  it("injects cw-code env vars into the TurnRequest of worktree sessions", async () => {
    const { manager, fake, project, repository } = makeGitSandboxManager("cw-session-env-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    await manager.startTurn(session.id, "env");
    expect(fake.lastRequest?.env).toMatchObject({
      CW_WORKTREE_PATH: session.worktreePath,
      CW_PROJECT_ROOT: repository,
      CW_SESSION_ID: session.id
    });
    manager.dispose();
  });

  it("records the worktree HEAD as the turn base sha and replaces it on the next turn", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-base-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    const headOf = () => execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    await manager.startTurn(session.id, "first");
    const firstBase = manager.turnBaseSha(session.id);
    expect(firstBase).toBe(headOf());

    fake.completeAll();
    writeFileSync(join(worktreePath, "README.md"), "changed\n", "utf8");
    execFileSync("git", ["-C", worktreePath, "add", "-A"]);
    execFileSync("git", ["-C", worktreePath, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "mid-turn"]);

    await manager.startTurn(session.id, "second");
    expect(manager.turnBaseSha(session.id)).toBe(headOf());
    expect(manager.turnBaseSha(session.id)).not.toBe(firstBase);
    manager.dispose();
  });

  it("falls back CW_WORKTREE_PATH to the project root for sessions without a worktree", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-env-nowt");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "env");
    expect(fake.lastRequest?.env).toMatchObject({
      CW_WORKTREE_PATH: "C:\\proj-env-nowt",
      CW_PROJECT_ROOT: "C:\\proj-env-nowt",
      CW_SESSION_ID: a.id
    });
    manager.dispose();
  });

  it("lists models from the session worktree when one exists", async () => {
    const { manager, project } = makeGitSandboxManager("cw-session-models-");
    const modelDriver = new ModelRecordingDriver((event) =>
      (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event)
    );
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.opencode = modelDriver;
    const session = await manager.createSession(project.id, "opencode", { baseBranch: "main" });
    await manager.listModels(session.id);
    expect(modelDriver.modelCwds).toEqual([session.worktreePath]);
    manager.dispose();
  });

  it("lists models from the project root for sessions without a worktree", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-models-nowt");
    const modelDriver = new ModelRecordingDriver((event) =>
      (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event)
    );
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.opencode = modelDriver;
    const session = await manager.createSession(project.id, "opencode");
    await manager.listModels(session.id);
    expect(modelDriver.modelCwds).toEqual(["C:\\proj-models-nowt"]);
    manager.dispose();
  });

  it("lists models from the project root without recreating a missing worktree", async () => {
    const { manager, project } = makeGitSandboxManager("cw-session-models-missing-");
    const modelDriver = new ModelRecordingDriver((event) =>
      (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event)
    );
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.opencode = modelDriver;
    const session = await manager.createSession(project.id, "opencode", { baseBranch: "main" });
    if (!session.worktreePath) throw new Error("session has no worktree");
    rmSync(session.worktreePath, { recursive: true, force: true });
    await manager.listModels(session.id);
    expect(modelDriver.modelCwds).toEqual([project.rootPath]);
    expect(existsSync(session.worktreePath)).toBe(false);
    manager.dispose();
  });

  it("builds a complete fallback env for unknown sessions instead of throwing", () => {
    const { manager } = makeManager();
    const env = manager.turnEnv("missing-session", "C:\\somewhere");
    expect(env["CW_WORKTREE_PATH"]).toBe("C:\\somewhere");
    expect(env["CW_PROJECT_ROOT"]).toBe("C:\\somewhere");
    expect(env["CW_SESSION_ID"]).toBe("missing-session");
    manager.dispose();
  });

  it("overrides stale CW_* values inherited from the process env", () => {
    const { manager } = makeManager();
    vi.stubEnv("CW_WORKTREE_PATH", "C:\\stale-worktree");
    vi.stubEnv("CW_PROJECT_ROOT", "C:\\stale-root");
    vi.stubEnv("CW_SESSION_ID", "stale-session");
    try {
      const env = manager.turnEnv("missing-session", "C:\\somewhere");
      expect(env["CW_WORKTREE_PATH"]).toBe("C:\\somewhere");
      expect(env["CW_PROJECT_ROOT"]).toBe("C:\\somewhere");
      expect(env["CW_SESSION_ID"]).toBe("missing-session");
    } finally {
      vi.unstubAllEnvs();
      manager.dispose();
    }
  });

  it("keeps every CW_* var when the session's project is gone", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-env-orphan");
    const session = await manager.createSession(project.id, "claude");
    const store = (manager as unknown as { store: { data: { projects: unknown[] } } }).store;
    store.data.projects = [];
    const env = manager.turnEnv(session.id, "C:\\proj-env-orphan");
    expect(env["CW_WORKTREE_PATH"]).toBe("C:\\proj-env-orphan");
    expect(env["CW_PROJECT_ROOT"]).toBe("C:\\proj-env-orphan");
    expect(env["CW_SESSION_ID"]).toBe(session.id);
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
      settingsPath: join(sandbox, "data", "settings.json"),
      worktreesRoot: join(sandbox, "worktrees")
    });
    const fake = new FakeDriver((event) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(event));
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
    manager.setSettings({ autoTitleEnabled: false });
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
    const after = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(after?.title).toBe("New session");
    manager.dispose();
  });

  it("coalesces concurrent ensureWorktree recovery into a single recovery", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-session-coalesce-"));
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
    if (!worktreePath || !session.branch) throw new Error("expected a worktree-backed session with a branch");
    expect(session.branch).toMatch(/^cw\//);
    const originalBranch = session.branch;

    rmSync(worktreePath, { recursive: true, force: true });
    const [rootA, rootB] = await Promise.all([
      manager.ensureWorktree(session.id),
      manager.ensureWorktree(session.id)
    ]);
    expect(rootA).toBe(worktreePath);
    expect(rootB).toBe(worktreePath);

    const branches = execFileSync("git", ["-C", repository, "branch", "--list", "cw/*"], { encoding: "utf8" });
    const branchCount = branches.trim() ? branches.trim().split(/\r?\n/).length : 0;
    expect(branchCount).toBe(1);
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.branch).toBe(originalBranch);
    const checkedOut = execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(checkedOut).toBe(originalBranch);
    manager.dispose();
  });

  it("recovery reuses a slug-renamed branch instead of creating a temp-pattern one", async () => {
    const { manager, fake, project, repository } = makeGitSandboxManager("cw-recover-slug-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");

    await manager.startTurn(session.id, "fix the login flow");
    fake.completeAll();
    const branch = await waitForBranch(manager, project.id, session.id, (b) => b === "cw/fix-the-login-flow");
    expect(branch).toBe("cw/fix-the-login-flow");

    rmSync(worktreePath, { recursive: true, force: true });
    const root = await manager.ensureWorktree(session.id);
    expect(root).toBe(worktreePath);
    const cwBranches = execFileSync("git", ["-C", repository, "branch", "--list", "cw/*"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .map((line) => line.replace(/^\+\s+/, ""));
    expect(cwBranches).toEqual(["cw/fix-the-login-flow"]);
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.branch).toBe("cw/fix-the-login-flow");
    const checkedOut = execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(checkedOut).toBe("cw/fix-the-login-flow");
    manager.dispose();
  });

  it("recovery falls back to a fresh branch when the stored branch cannot be attached", async () => {
    const { manager, fake, project, repository } = makeGitSandboxManager("cw-recover-fallback-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    const originalBranch = session.branch;
    if (!worktreePath || !originalBranch) throw new Error("expected a worktree-backed session with a branch");

    rmSync(worktreePath, { recursive: true, force: true });
    execFileSync("git", ["-C", repository, "worktree", "prune"]);
    const elsewhere = join(worktreePath, "..", `${session.id}-elsewhere`);
    execFileSync("git", ["-C", repository, "worktree", "add", elsewhere, originalBranch]);

    const root = await manager.ensureWorktree(session.id);
    expect(root).toBe(worktreePath);
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.branch).toBe(`${originalBranch}-1`);
    const checkedOut = execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(checkedOut).toBe(`${originalBranch}-1`);
    await manager.startTurn(session.id, "recovered");
    expect(fake.lastRequest?.cwd).toBe(worktreePath);
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

  it("renames the worktree branch from the CLI title on the first turn.done", async () => {
    const { manager, fake, project, received } = makeGitSandboxManager("cw-session-branch-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    if (!session.branch) throw new Error("expected a worktree-backed session with a branch");

    await manager.startTurn(session.id, "fix the login flow");
    fake.completeAll();
    const branch = await waitForBranch(manager, project.id, session.id, (b) => b === "cw/fix-the-login-flow");

    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(branch).toBe("cw/fix-the-login-flow");
    expect(stored?.branch).toBe("cw/fix-the-login-flow");
    const checkedOut = execFileSync("git", ["-C", session.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(checkedOut).toBe("cw/fix-the-login-flow");
    expect(received.some((r) => r.sessionId === session.id && r.event.type === "session.branch.updated" && r.event.branch === "cw/fix-the-login-flow")).toBe(true);
    manager.dispose();
  });

  it("suffixes the renamed branch on collision", async () => {
    const { manager, fake, project, repository } = makeGitSandboxManager("cw-session-branch-collision-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    if (!session.branch) throw new Error("expected a worktree-backed session with a branch");
    execFileSync("git", ["-C", repository, "branch", "cw/collision-target"]);

    await manager.startTurn(session.id, "collision-target");
    fake.completeAll();
    const branch = await waitForBranch(manager, project.id, session.id, (b) => b === "cw/collision-target-1");

    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(branch).toBe("cw/collision-target-1");
    expect(stored?.branch).toBe("cw/collision-target-1");
    const checkedOut = execFileSync("git", ["-C", session.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(checkedOut).toBe("cw/collision-target-1");
    manager.dispose();
  });

  it("keeps the temporary branch when the title is still the generic fallback", async () => {
    const { manager, project } = makeGitSandboxManager("cw-session-branch-notitle-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const tempBranch = session.branch;
    if (!tempBranch) throw new Error("expected a worktree-backed session with a branch");
    expect((await manager.listSessions(project.id)).find((s) => s.id === session.id)?.title).toBe("New session");

    (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({
      type: "turn.done",
      turnId: "turn-no-title",
      sessionId: session.id,
      resumeCursor: "cursor-1",
      resultText: "",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    await new Promise((r) => setTimeout(r, 50));

    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.branch).toBe(tempBranch);
    manager.dispose();
  });

  it("does not rename again on subsequent turn.done events", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-session-branch-once-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    if (!session.branch) throw new Error("expected a worktree-backed session with a branch");

    await manager.startTurn(session.id, "first title");
    fake.completeAll();
    const renamed = await waitForBranch(manager, project.id, session.id, (b) => b === "cw/first-title");
    expect(renamed).toBe("cw/first-title");

    await manager.renameSession(session.id, "second title");
    await manager.startTurn(session.id, "again");
    fake.completeAll();
    await new Promise((r) => setTimeout(r, 150));

    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.branch).toBe("cw/first-title");
    manager.dispose();
  });

  it("skips the title branch rename while another session shares the worktree and retries once it is gone", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-session-branch-shared-");
    const a = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    if (!a.worktreePath || !a.branch) throw new Error("expected a worktree-backed session with a branch");
    const b = await manager.createSession(project.id, "claude", { mode: "previous", reuseWorktreePath: a.worktreePath });
    expect(b.worktreePath).toBe(a.worktreePath);
    expect(b.branch).toBe(a.branch);

    await manager.startTurn(b.id, "fix the login flow");
    fake.completeAll();
    await new Promise((r) => setTimeout(r, 200));

    const stillShared = (await manager.listSessions(project.id)).find((s) => s.id === b.id);
    expect(stillShared?.branch).toBe(a.branch);
    const checkedOut = execFileSync("git", ["-C", a.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(checkedOut).toBe(a.branch);

    (manager as unknown as { store: SessionStore }).store.updateSession(a.id, { worktreePath: undefined, branch: undefined });
    await manager.startTurn(b.id, "retry rename");
    fake.completeAll();
    const renamed = await waitForBranch(manager, project.id, b.id, (br) => br === "cw/fix-the-login-flow");
    expect(renamed).toBe("cw/fix-the-login-flow");
    manager.dispose();
  });

  it("renames the title branch once the only co-tenant is resolved", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-session-branch-resolved-");
    const a = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    if (!a.worktreePath || !a.branch) throw new Error("expected a worktree-backed session with a branch");
    const b = await manager.createSession(project.id, "claude", { mode: "previous", reuseWorktreePath: a.worktreePath });
    expect(b.worktreePath).toBe(a.worktreePath);
    expect(b.branch).toBe(a.branch);

    const aResult = await manager.resolveSession(a.id, "resolved");
    expect(aResult.worktreeOrphaned).toBe(false);

    await manager.startTurn(b.id, "fix the login flow");
    fake.completeAll();
    const renamed = await waitForBranch(manager, project.id, b.id, (br) => br === "cw/fix-the-login-flow");

    expect(renamed).toBe("cw/fix-the-login-flow");
    manager.dispose();
  });

  it("falls back to a new worktree when the reuse path is in detached HEAD state", async () => {
    const { manager, project } = makeGitSandboxManager("cw-session-reuse-detached-");
    const a = await manager.createSession(project.id, "claude", { mode: "new", baseBranch: "main" });
    if (!a.worktreePath) throw new Error("expected a worktree-backed session");
    execFileSync("git", ["-C", a.worktreePath, "checkout", "--detach"]);

    const b = await manager.createSession(project.id, "claude", { mode: "previous", reuseWorktreePath: a.worktreePath });

    expect(b.worktreePath).toBeTruthy();
    expect(b.worktreePath).not.toBe(a.worktreePath);
    expect(b.branch).toMatch(/^cw\//);
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

  it("reports the active turn with its start time while it runs", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-active-list");
    const a = await manager.createSession(project.id, "claude");
    const before = Date.now();
    const turnId = await manager.startTurn(a.id, "hello");
    const active = manager.listActiveTurns();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ sessionId: a.id, turnId });
    expect(active[0].startedAt).toBeGreaterThanOrEqual(before);
    manager.dispose();
  });

  it("drops the active turn when turn.done completes without background tasks", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-active-done");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");
    fake.complete(turnId);
    expect(manager.listActiveTurns()).toEqual([]);
    manager.dispose();
  });

  it("drops the active turn on interrupt and on turn.error", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-active-drop");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");
    manager.interrupt(turnId);
    expect(manager.listActiveTurns()).toEqual([]);

    const b = await manager.createSession(project.id, "claude");
    const errorTurnId = await manager.startTurn(b.id, "boom");
    const routeEvent = (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent.bind(manager);
    routeEvent({ type: "turn.error", turnId: errorTurnId, message: "boom" });
    expect(manager.listActiveTurns()).toEqual([]);
    manager.dispose();
  });

  it("drops the active turn on the first turn.done even while background tasks run", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-active-bg");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");
    fake.complete(turnId, 2);
    expect(manager.listActiveTurns()).toEqual([]);
    manager.dispose();
  });

  it("moves interrupted and errored sessions into holding", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-holding");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");
    manager.interrupt(turnId);
    let sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("holding");

    const b = await manager.createSession(project.id, "claude");
    const errorTurnId = await manager.startTurn(b.id, "boom");
    const routeEvent = (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent.bind(manager);
    routeEvent({ type: "turn.error", turnId: errorTurnId, message: "boom" });
    sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === b.id)?.status).toBe("holding");
    manager.dispose();
  });

  it("expires holding sessions and reports only the changed records", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-expire");
    const a = await manager.createSession(project.id, "claude");
    const b = await manager.createSession(project.id, "claude");
    const c = await manager.createSession(project.id, "claude");
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(a.id, { status: "holding" });
    store.updateSession(b.id, { status: "done" });
    const before = (await manager.listSessions(project.id)).find((s) => s.id === a.id);
    if (!before) throw new Error("expected the holding session");

    const expired = manager.expireHoldingSessions([a.id, b.id, c.id, "missing"]);

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ id: a.id, status: "idle", updatedAt: before.updatedAt });
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("idle");
    expect(sessions.find((s) => s.id === b.id)?.status).toBe("done");
    expect(sessions.find((s) => s.id === c.id)?.status).toBe("idle");
    manager.dispose();
  });

  it("frees the session on the first turn.done so background work never blocks the next prompt", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-background");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");

    fake.complete(turnId, 2);
    let sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("done");
    expect(sessions.find((s) => s.id === a.id)?.resumeCursor).toMatch(/^cursor-/);
    const secondId = await manager.startTurn(a.id, "second");
    sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("working");

    fake.complete(turnId);
    sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("working");
    fake.complete(secondId);
    sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("done");
    manager.dispose();
  });

  it("generates a title for the first message and emits it", async () => {
    const { manager, received, fake, titles } = makeManager();
    manager.setSettings({ autoTitleEnabled: true });
    const project = manager.addProject("C:\\proj-title");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "Fix the login redirect loop");
    expect(String(fake.lastRequest?.sessionId).startsWith("title:")).toBe(true);
    expect(fake.lastRequest).toMatchObject({ model: "claude-sonnet-5", effort: "low" });
    expect(String(fake.lastRequest?.prompt)).toContain("Fix the login redirect loop");
    const titleCwd = String(fake.lastRequest?.cwd);
    expect(titleCwd.length).toBeGreaterThan(0);
    expect(titleCwd).not.toBe("C:\\proj-title");
    fake.completeTitle('"Fix login redirect loop"');
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.title).toBe("Fix login redirect loop");
    expect(titles).toEqual([
      { sessionId: a.id, title: "Fix the login redirect loop" },
      { sessionId: a.id, title: "Fix login redirect loop" }
    ]);
    expect(received.some((r) => r.sessionId.startsWith("title:"))).toBe(false);
    manager.dispose();
  });

  it("keeps a manual rename that lands before the title turn completes", async () => {
    const { manager, fake, titles } = makeManager();
    manager.setSettings({ autoTitleEnabled: true });
    const project = manager.addProject("C:\\proj-title-rename");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "Fix the login redirect loop");
    await manager.renameSession(a.id, "Manual name");
    fake.completeTitle("Generated name");
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.title).toBe("Manual name");
    expect(titles).toEqual([{ sessionId: a.id, title: "Fix the login redirect loop" }]);
    manager.dispose();
  });

  it("keeps the placeholder when the title turn ends with an error result", async () => {
    const { manager, fake, titles } = makeManager();
    manager.setSettings({ autoTitleEnabled: true });
    const project = manager.addProject("C:\\proj-title-error-done");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "Fix the login redirect loop");
    fake.completeTitleError("API Error: 500 Internal Server Error");
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.title).toBe("Fix the login redirect loop");
    expect(titles).toEqual([{ sessionId: a.id, title: "Fix the login redirect loop" }]);
    manager.dispose();
  });

  it("keeps the placeholder when the title turn errors after a partial delta", async () => {
    const { manager, fake, titles } = makeManager();
    manager.setSettings({ autoTitleEnabled: true });
    const project = manager.addProject("C:\\proj-title-error-partial");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "Fix the login redirect loop");
    fake.failTitle("Fix login");
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.title).toBe("Fix the login redirect loop");
    expect(titles).toEqual([{ sessionId: a.id, title: "Fix the login redirect loop" }]);
    manager.dispose();
  });

  it("does not start a title turn when auto-title is disabled", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-title-off");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "Fix the login redirect loop");
    expect(fake.seen).toHaveLength(1);
    expect(fake.lastRequest?.sessionId).toBe(a.id);
    expect(fake.lastRequest?.prompt).toBe("Fix the login redirect loop");
    manager.dispose();
  });

  it("regenerates a title from the stored first prompt on demand", async () => {
    const { manager, fake, titles } = makeManager();
    const project = manager.addProject("C:\\proj-regen-prompt");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "Add a dark mode toggle to the settings panel");
    expect(fake.seen).toHaveLength(1);
    const promise = manager.regenerateTitle(a.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.lastRequest?.sessionId).toBe(`title:${a.id}`);
    expect(String(fake.lastRequest?.prompt)).toContain("Add a dark mode toggle to the settings panel");
    fake.completeTitle("Dark mode settings toggle");
    await expect(promise).resolves.toBe("Dark mode settings toggle");
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.title).toBe("Dark mode settings toggle");
    expect(titles).toEqual([
      { sessionId: a.id, title: "Add a dark mode toggle to the settings panel" },
      { sessionId: a.id, title: "Dark mode settings toggle" }
    ]);
    manager.dispose();
  });

  it("regenerates from the first user history message when the session has a cursor", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-regen-history");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "First prompt");
    fake.completeAll();
    await new Promise((r) => setTimeout(r, 20));
    fake.history = [{ id: "m1", role: "user", text: "Use the history message instead", turnId: "t1" }];
    const promise = manager.regenerateTitle(a.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(String(fake.lastRequest?.prompt)).toContain("Use the history message instead");
    fake.completeTitle("History based title");
    await expect(promise).resolves.toBe("History based title");
    manager.dispose();
  });

  it("rejects regeneration when the title turn fails and keeps the current title", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-regen-fail");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "Fix the login redirect loop");
    const promise = manager.regenerateTitle(a.id);
    await new Promise((r) => setTimeout(r, 20));
    fake.failTitle("Fix login");
    await expect(promise).rejects.toThrow(/generation failed/);
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.title).toBe("Fix the login redirect loop");
    manager.dispose();
  });

  it("rejects regeneration that produces the current title", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-regen-same");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "Fix the login redirect loop");
    const promise = manager.regenerateTitle(a.id);
    await new Promise((r) => setTimeout(r, 20));
    fake.completeTitle("Fix the login redirect loop");
    await expect(promise).rejects.toThrow(/generation failed/);
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.title).toBe("Fix the login redirect loop");
    manager.dispose();
  });

  it("rejects regeneration before any message exists", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-regen-empty");
    const a = await manager.createSession(project.id, "claude");
    await expect(manager.regenerateTitle(a.id)).rejects.toThrow(/No session message/);
    manager.dispose();
  });

  it("removes an orphaned worktree and deletes its branch when resolving with removal", async () => {
    const { manager, project, repository } = makeGitSandboxManager("cw-resolve-orphan-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    const branch = session.branch;
    if (!worktreePath || !branch) throw new Error("expected a worktree-backed session with a branch");

    const result = await manager.resolveSession(session.id, "archived", { removeWorktree: true });

    expect(result.worktreeOrphaned).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.unmergedCommits).toBeUndefined();
    expect(result.dirtyBlocked).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    const branches = execFileSync("git", ["-C", repository, "branch", "--list", branch], { encoding: "utf8" });
    expect(branches.trim()).toBe("");
    manager.dispose();
  });

  it("clears stored worktree and branch references after removal so polling cannot resurrect them", async () => {
    const { manager, project } = makeGitSandboxManager("cw-resolve-clear-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    const branch = session.branch;
    if (!worktreePath || !branch) throw new Error("expected a worktree-backed session with a branch");

    await manager.resolveSession(session.id, "archived", { removeWorktree: true });

    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.worktreePath).toBeUndefined();
    expect(stored?.branch).toBeUndefined();
    await expect(manager.ensureWorktree(session.id)).resolves.toBe(project.rootPath);
    expect(existsSync(worktreePath)).toBe(false);
    manager.dispose();
  });

  it("never triggers recovery for resolved sessions with a missing worktree", async () => {
    const { manager, project, repository } = makeGitSandboxManager("cw-resolve-gate-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    const branch = session.branch;
    if (!worktreePath || !branch) throw new Error("expected a worktree-backed session with a branch");

    await manager.resolveSession(session.id, "resolved");
    rmSync(worktreePath, { recursive: true, force: true });
    execFileSync("git", ["-C", repository, "worktree", "prune"]);

    await expect(manager.ensureWorktree(session.id)).rejects.toThrow("session is resolved");
    expect(existsSync(worktreePath)).toBe(false);
    const cwBranches = execFileSync("git", ["-C", repository, "branch", "--list", "cw/*"], { encoding: "utf8" }).trim();
    expect(cwBranches).toBe(branch);
    manager.dispose();
  });

  it("reports unmerged commit counts when preparing worktree removal", async () => {
    const { manager, project } = makeGitSandboxManager("cw-resolve-count-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath || !session.branch) throw new Error("expected a worktree-backed session with a branch");
    writeFileSync(join(worktreePath, "unmerged.txt"), "work\n", "utf8");
    execFileSync("git", ["-C", worktreePath, "add", "unmerged.txt"]);
    execFileSync("git", ["-C", worktreePath, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "unmerged work"]);

    const check = await manager.resolveSession(session.id, "resolved");

    expect(check.worktreeOrphaned).toBe(true);
    expect(check.unmergedCommitCount).toBe(1);
    expect(existsSync(worktreePath)).toBe(true);
    const clean = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const cleanCheck = await manager.resolveSession(clean.id, "resolved");
    expect(cleanCheck.unmergedCommitCount).toBeUndefined();
    manager.dispose();
  });

  it("waits for in-flight worktree recovery before resolving", async () => {
    const { manager, project } = makeGitSandboxManager("cw-resolve-recovery-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");

    rmSync(worktreePath, { recursive: true, force: true });
    const recovered = manager.ensureWorktree(session.id);
    const result = await manager.resolveSession(session.id, "archived", { removeWorktree: true });

    expect(result.worktreeRemoved).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    await expect(recovered).resolves.toBe(worktreePath);
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.worktreePath).toBeUndefined();
    manager.dispose();
  });

  it("keeps a dirty worktree and reports dirtyBlocked when resolving", async () => {
    const { manager, project, repository } = makeGitSandboxManager("cw-resolve-dirty-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    const branch = session.branch;
    if (!worktreePath || !branch) throw new Error("expected a worktree-backed session with a branch");
    writeFileSync(join(worktreePath, "dirty.txt"), "wip\n", "utf8");

    const result = await manager.resolveSession(session.id, "archived", { removeWorktree: true });

    expect(result.worktreeRemoved).toBe(false);
    expect(result.dirtyBlocked).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
    const branches = execFileSync("git", ["-C", repository, "branch", "--list", branch], { encoding: "utf8" });
    expect(branches.trim()).not.toBe("");
    manager.dispose();
  });

  it("keeps a worktree that another session still references", async () => {
    const { manager, project } = makeGitSandboxManager("cw-resolve-shared-");
    const a = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const b = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = a.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    (manager as unknown as { store: SessionStore }).store.updateSession(b.id, { worktreePath });

    const result = await manager.resolveSession(a.id, "archived", { removeWorktree: true });

    expect(result.worktreeOrphaned).toBe(false);
    expect(result.worktreeRemoved).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);
    const storedA = (await manager.listSessions(project.id)).find((s) => s.id === a.id);
    expect(storedA?.worktreePath).toBeUndefined();
    expect(storedA?.branch).toBe(a.branch);
    manager.dispose();
  });

  it("gives the last live session of a reused worktree the orphan removal path", async () => {
    const { manager, project } = makeGitSandboxManager("cw-resolve-reuse-last-");
    const a = await manager.createSession(project.id, "claude", { mode: "new", baseBranch: "main" });
    const worktreePath = a.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    const b = await manager.createSession(project.id, "claude", { mode: "previous", reuseWorktreePath: worktreePath });
    expect(b.worktreePath).toBe(worktreePath);

    const aResult = await manager.resolveSession(a.id, "archived", { removeWorktree: true });

    expect(aResult.worktreeOrphaned).toBe(false);
    expect(aResult.worktreeRemoved).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);
    const storedA = (await manager.listSessions(project.id)).find((s) => s.id === a.id);
    expect(storedA?.worktreePath).toBeUndefined();
    expect(storedA?.branch).toBe(a.branch);

    const bCheck = await manager.resolveSession(b.id, "archived");

    expect(bCheck.worktreeOrphaned).toBe(true);
    expect(bCheck.worktreeRemoved).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);

    const bResult = await manager.resolveSession(b.id, "archived", { removeWorktree: true });

    expect(bResult.worktreeRemoved).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    manager.dispose();
  });

  it("reports non-orphaned cleanup for sessions without a worktree", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-resolve-plain");
    const a = await manager.createSession(project.id, "claude");
    const result = await manager.resolveSession(a.id, "resolved");
    expect(result.worktreeOrphaned).toBe(false);
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    manager.dispose();
  });

  it("stops the driver process when resolving a session", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-resolve-stop");
    const a = await manager.createSession(project.id, "claude");
    await manager.resolveSession(a.id, "resolved");
    expect(fake.stoppedSessions).toEqual([a.id]);
    manager.dispose();
  });

  it("prunes stale worktrees, keeps live session worktrees, skips non-worktree dirs", async () => {
    const { manager, project, repository } = makeGitSandboxManager("cw-prune-");
    const live = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    if (!live.worktreePath) throw new Error("expected a worktree-backed session");
    const worktreesRoot = join(dirname(repository), "worktrees");
    const stalePath = join(worktreesRoot, project.id, "sess_stale");
    mkdirSync(dirname(stalePath), { recursive: true });
    execFileSync("git", ["-C", repository, "worktree", "add", "-b", "cw/stale", stalePath, "main"]);
    const junkPath = join(worktreesRoot, project.id, "sess_junk");
    mkdirSync(junkPath, { recursive: true });
    writeFileSync(join(junkPath, "precious.txt"), "not a worktree\n", "utf8");

    const summary = await manager.pruneStaleWorktrees();

    expect(summary.scanned).toBe(3);
    expect(summary.removed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(existsSync(live.worktreePath)).toBe(true);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(junkPath)).toBe(true);
    expect(readFileSync(join(junkPath, "precious.txt"), "utf8")).toBe("not a worktree\n");
    manager.dispose();
  });

  it("removes unreferenced dirs that carry a .git worktree marker", async () => {
    const { manager, project } = makeGitSandboxManager("cw-prune-orphan-");
    const worktreesRoot = join(dirname(join(project.rootPath)), "worktrees");
    const orphanPath = join(worktreesRoot, "proj_unknown", "sess_orphan");
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(join(orphanPath, ".git"), "gitdir: ../repo/.git/worktrees/sess_orphan\n", "utf8");
    writeFileSync(join(orphanPath, "tracked.txt"), "data\n", "utf8");

    const summary = await manager.pruneStaleWorktrees();

    expect(summary.scanned).toBe(1);
    expect(summary.removed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(existsSync(orphanPath)).toBe(false);
    manager.dispose();
  });

  it("prunes worktrees referenced only by resolved sessions", async () => {
    const { manager, project } = makeGitSandboxManager("cw-prune-resolved-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");

    const kept = await manager.resolveSession(session.id, "resolved");
    expect(kept.worktreeOrphaned).toBe(true);
    expect(kept.worktreeRemoved).toBe(false);
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.worktreePath).toBe(worktreePath);

    const summary = await manager.pruneStaleWorktrees();

    expect(summary.removed).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);
    manager.dispose();
  });

  it("rejects startTurn on resolved or archived sessions", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-resolve-reject");
    const a = await manager.createSession(project.id, "claude");
    await manager.resolveSession(a.id, "resolved");
    await expect(manager.startTurn(a.id, "hello")).rejects.toThrow("session is resolved");
    await manager.resolveSession(a.id, "archived");
    await expect(manager.startTurn(a.id, "hello")).rejects.toThrow("session is archived");
    manager.dispose();
  });

  it("refuses to resolve while a turn start is pending for the session", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-resolve-busy");
    const a = await manager.createSession(project.id, "claude");
    const internals = manager as unknown as { ensureWorktree(sessionId: string): Promise<string> };
    internals.ensureWorktree = () => new Promise<string>(() => {});
    manager.startTurn(a.id, "slow").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    await expect(manager.resolveSession(a.id, "archived")).rejects.toThrow("session busy (turn pending)");
    manager.dispose();
  });

  it("refuses to resolve while a turn is active", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-resolve-active");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "hello");
    await expect(manager.resolveSession(a.id, "archived")).rejects.toThrow("session busy (turn active)");
    fake.completeAll();
    manager.dispose();
  });

  it("keeps an unmerged orphan branch without force and discards it when forced", async () => {
    const { manager, project } = makeGitSandboxManager("cw-resolve-unmerged-");
    const gentle = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const forced = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    for (const session of [gentle, forced]) {
      const worktreePath = session.worktreePath;
      if (!worktreePath) throw new Error("expected a worktree-backed session with a branch");
      writeFileSync(join(worktreePath, "unmerged.txt"), "work\n", "utf8");
      execFileSync("git", ["-C", worktreePath, "add", "unmerged.txt"]);
      execFileSync("git", ["-C", worktreePath, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "unmerged work"]);
    }
    if (!gentle.branch || !forced.branch) throw new Error("expected branches on worktree-backed sessions");

    const gentleResult = await manager.resolveSession(gentle.id, "archived", { removeWorktree: true });

    expect(gentleResult.worktreeRemoved).toBe(true);
    expect(gentleResult.branchDeleted).toBe(false);
    expect(gentleResult.unmergedCommits).toBeUndefined();
    expect(existsSync(gentle.worktreePath!)).toBe(false);
    const keptBranches = execFileSync("git", ["-C", project.rootPath, "branch", "--list", gentle.branch], { encoding: "utf8" });
    expect(keptBranches.trim()).not.toBe("");

    const forcedResult = await manager.resolveSession(forced.id, "archived", { removeWorktree: true, forceBranch: true });

    expect(forcedResult.branchDeleted).toBe(true);
    expect(forcedResult.unmergedCommits).toBe(true);
    const goneBranches = execFileSync("git", ["-C", project.rootPath, "branch", "--list", forced.branch], { encoding: "utf8" });
    expect(goneBranches.trim()).toBe("");
    manager.dispose();
  });

  it("surfaces driver history failures instead of returning a silent empty list", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-history-fail");
    const a = await manager.createSession(project.id, "claude");
    (manager as unknown as { store: { updateSession(id: string, patch: unknown): void } }).store.updateSession(a.id, {
      resumeCursor: "cursor-1"
    });
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.claude.getHistory = async () => {
      throw new Error("fetch failed");
    };
    await expect(manager.getHistory(a.id)).rejects.toThrow(/Could not load history/);
    manager.dispose();
  });

  function historyDriver(listed: Array<{ cursor: string; title: string; createdAt: number; updatedAt: number }>, history: HistoryMessage[] | Record<string, HistoryMessage[]>) {
    const calls: string[] = [];
    return {
      calls,
      driver: {
        kind: "claude",
        listSessions: async (projectRoot: string, projectId = "") => {
          calls.push(`list:${projectRoot}`);
          return listed.map((s, i) => ({
            id: `claude:${s.cursor}`,
            projectId,
            driver: "claude",
            title: s.title,
            status: "idle",
            resumeCursor: s.cursor,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt
          }));
        },
        getHistory: async (_projectRoot: string, resumeCursor: string) =>
          Array.isArray(history) ? history : (history[resumeCursor] ?? []),
        startTurn: () => {
          throw new Error("not used");
        },
        interrupt: () => {},
        renameSession: async () => {},
        async *events() {}
      } as unknown as CliDriver
    };
  }

  it("returns empty history without a server round-trip for brand-new sessions", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-history-new");
    const a = await manager.createSession(project.id, "claude");
    const { calls, driver } = historyDriver([], []);
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.claude = driver;
    await expect(manager.getHistory(a.id)).resolves.toEqual([]);
    expect(calls).toEqual([]);
    manager.dispose();
  });

  it("adopts an unclaimed native session when the cursor is missing after a failed first turn", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-history-heal");
    const a = await manager.createSession(project.id, "claude");
    (manager as unknown as { store: { updateSession(id: string, patch: unknown): void } }).store.updateSession(a.id, {
      title: "fix the login flow"
    });
    const history: HistoryMessage[] = [{ id: "m1", role: "user", text: "fix the login flow", turnId: "t1" }];
    const { driver } = historyDriver(
      [{ cursor: "native-1", title: "fix the login flow", createdAt: 1, updatedAt: 2 }],
      history
    );
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.claude = driver;
    await expect(manager.getHistory(a.id)).resolves.toEqual(history);
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === a.id);
    expect(stored?.resumeCursor).toBe("native-1");
    manager.dispose();
  });

  it("re-links by title when the stored cursor vanished but the native session remains", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-history-relink");
    const a = await manager.createSession(project.id, "claude");
    const store = (manager as unknown as { store: { updateSession(id: string, patch: unknown): void } }).store;
    store.updateSession(a.id, { title: "fix the login flow", resumeCursor: "stale-cursor" });
    const history: HistoryMessage[] = [{ id: "m1", role: "user", text: "fix the login flow", turnId: "t1" }];
    const { driver } = historyDriver(
      [{ cursor: "native-2", title: "fix the login flow", createdAt: 1, updatedAt: 5 }],
      { "native-2": history }
    );
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.claude = driver;
    await expect(manager.getHistory(a.id)).resolves.toEqual(history);
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === a.id);
    expect(stored?.resumeCursor).toBe("native-2");
    manager.dispose();
  });

  it("throws a transient error when the native session shows activity but history is empty", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-history-active");
    const a = await manager.createSession(project.id, "claude");
    (manager as unknown as { store: { updateSession(id: string, patch: unknown): void } }).store.updateSession(a.id, {
      resumeCursor: "cursor-1"
    });
    const { driver } = historyDriver(
      [{ cursor: "cursor-1", title: "work", createdAt: 1, updatedAt: 9 }],
      []
    );
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.claude = driver;
    await expect(manager.getHistory(a.id)).rejects.toThrow(/transient/);
    manager.dispose();
  });

  it("throws a missing-session error when the cursor is gone and nothing can be adopted", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-history-gone");
    const a = await manager.createSession(project.id, "claude");
    (manager as unknown as { store: { updateSession(id: string, patch: unknown): void } }).store.updateSession(a.id, {
      title: "fix the login flow",
      resumeCursor: "deleted-cursor"
    });
    const { driver } = historyDriver([], []);
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers.claude = driver;
    await expect(manager.getHistory(a.id)).rejects.toThrow(/not found/);
    manager.dispose();
  });
});
