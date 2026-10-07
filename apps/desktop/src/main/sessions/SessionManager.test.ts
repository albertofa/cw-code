import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CliDriver, HistoryMessage, ModelOption, SessionMeta, ThreadEvent, TurnHandle, TurnSnapshot } from "@cw-code/contracts";
import { SessionManager, type SessionManagerOptions } from "./SessionManager.js";
import { SYNTHETIC_FULL_ACCESS_DESCRIPTION } from "../providers/permissions.js";
import type { SessionStore } from "./SessionStore.js";
import { initSessionStatusTrace, resetSessionStatusTraceForTests } from "../debug/sessionStatusTrace.js";

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
      usage: [],
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
        usage: [],
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
        usage: [],
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

async function waitForSessionPrSeen(
  manager: SessionManager,
  projectId: string,
  sessionId: string,
  sha: string,
  number = 42
): Promise<SessionMeta | undefined> {
  for (let i = 0; i < 100; i += 1) {
    const session = (await manager.listSessions(projectId)).find((s) => s.id === sessionId);
    if (session?.prs?.find((link) => link.ref.number === number)?.lastSeenSha === sha) return session;
    await new Promise((r) => setTimeout(r, 10));
  }
  return (await manager.listSessions(projectId)).find((s) => s.id === sessionId);
}

function makePrManager(opts: Pick<SessionManagerOptions, "prHead" | "prHeadRefresh" | "prState" | "prStateRefresh" | "onResolved">) {
  const dir = mkdtempSync(join(tmpdir(), "cw-test-"));
  const manager = new SessionManager({ dbPath: join(dir, "test.db"), settingsPath: join(dir, "settings.json"), ...opts });
  const fake = new FakeDriver((e) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(e));
  (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
  manager.setSettings({ autoTitleEnabled: false });
  const project = manager.addProject(join(dir, "proj"));
  return { manager, fake, project, dir };
}

function readStatusTransitions(path: string): Array<{ sessionId: string; to: string; reason: string }> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sessionId: string; to: string; reason: string });
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

function storedSnapshot(manager: SessionManager, sessionId: string): TurnSnapshot | undefined {
  return (manager as unknown as { store: SessionStore }).store.getSession(sessionId)?.lastTurnSnapshot;
}

async function endSnapshotsSettled(manager: SessionManager): Promise<void> {
  await Promise.all([...(manager as unknown as { endSnapshots: Map<string, Promise<void>> }).endSnapshots.values()]);
}

describe("SessionManager", () => {
  it("keeps settings and title generation next to an explicit dbPath instead of the real app home", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-data-dir-"));
    const appHome = join(sandbox, "app-home");
    vi.stubEnv("CW_CODE_HOME", appHome);
    try {
      const manager = new SessionManager({ dbPath: join(sandbox, "data", "test.db") });
      manager.setSettings({ autoTitleEnabled: false });
      const titleRoot = (manager as unknown as { titleGenRoot(): string }).titleGenRoot();
      manager.dispose();
      expect(existsSync(join(sandbox, "data", "cw-settings.json"))).toBe(true);
      expect(titleRoot).toBe(join(sandbox, "data", "title-gen"));
      expect(existsSync(appHome)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("flushes the pending settings last-good refresh on dispose", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-test-"));
    const settingsPath = join(dir, "settings.json");
    const manager = new SessionManager({ dbPath: join(dir, "test.db"), settingsPath });
    manager.setSettings({ holdingHours: 9 });
    expect(existsSync(`${settingsPath}.last-good.bak`)).toBe(false);

    manager.dispose();

    expect(readFileSync(`${settingsPath}.last-good.bak`, "utf8")).toBe(readFileSync(settingsPath, "utf8"));
  });

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

  it("records turn usage to the ledger for a known session, tagged with its project and driver", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-usage-known");
    const session = await manager.createSession(project.id, "claude");
    (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({
      type: "turn.done",
      turnId: "turn-usage-1",
      sessionId: session.id,
      resumeCursor: "cursor-1",
      resultText: "",
      usage: [
        { model: "claude-sonnet-5", inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0, costUsd: 0.02 }
      ],
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    const rows = manager.queryUsageLedger({ sessionId: session.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: session.id, projectId: project.id, driver: "claude", inputTokens: 10, costUsd: 0.02 });
    manager.dispose();
  });

  it("routes a late tool result from the session's settled turn to that session", async () => {
    const { manager, received } = makeManager();
    const project = manager.addProject("C:\\proj-late-result");
    const session = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(session.id, "start a background shell");
    const route = (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent.bind(manager);
    route({
      type: "turn.done",
      turnId,
      sessionId: session.id,
      resumeCursor: "cursor-1",
      resultText: "STARTED",
      usage: [],
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    route({ type: "tool.result", turnId, toolCallId: "call-bash", output: "Background command completed (exit code 0)", isError: false });

    expect(received).toContainEqual({
      sessionId: session.id,
      event: expect.objectContaining({ type: "tool.result", toolCallId: "call-bash" })
    });
    manager.dispose();
  });

  it("does not record usage for an unknown session id, including title-generation session ids", () => {
    const { manager } = makeManager();
    for (const sessionId of ["does-not-exist", "title:does-not-exist"]) {
      (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({
        type: "turn.done",
        turnId: `turn-${sessionId}`,
        sessionId,
        resumeCursor: "cursor-1",
        resultText: "",
        usage: [
          { model: "claude-sonnet-5", inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0, costUsd: null }
        ],
        numTurns: 1,
        isError: false,
        backgroundTasks: 0
      });
    }
    expect(manager.queryUsageLedger({ sessionId: "does-not-exist" })).toEqual([]);
    expect(manager.queryUsageLedger({ sessionId: "title:does-not-exist" })).toEqual([]);
    manager.dispose();
  });

  it("skips ledger recording when a turn.done carries no usage", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-usage-empty");
    const session = await manager.createSession(project.id, "claude");
    (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({
      type: "turn.done",
      turnId: "turn-empty",
      sessionId: session.id,
      resumeCursor: "cursor-1",
      resultText: "",
      usage: [],
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    expect(manager.queryUsageLedger({ sessionId: session.id })).toEqual([]);
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

  it("injects synthetic full access when a harness lacks a native bypass mode", async () => {
    const { manager } = makeManager();
    const drivers = (manager as unknown as { drivers: Record<string, CliDriver> }).drivers;
    drivers["opencode"] = {
      kind: "opencode",
      listSessions: async () => [],
      getHistory: async () => [],
      startTurn: () => ({ turnId: "t", events: (async function* () {})() }),
      interrupt: () => {},
      renameSession: async () => {},
      events: (async function* () {})(),
      listPermissionModes: async () => [
        { id: "manual", label: "Supervised", description: "Ask.", native: true },
        { id: "auto", label: "Auto", description: "Auto.", native: true }
      ]
    } as unknown as CliDriver;
    drivers["claude"] = {
      kind: "claude",
      listSessions: async () => [],
      getHistory: async () => [],
      startTurn: () => ({ turnId: "t", events: (async function* () {})() }),
      interrupt: () => {},
      renameSession: async () => {},
      events: (async function* () {})(),
      listPermissionModes: async () => [
        { id: "manual", label: "Supervised", description: "Ask.", native: true },
        { id: "bypassPermissions", label: "Full access", description: "Native.", native: true }
      ]
    } as unknown as CliDriver;
    const project = manager.addProject("C:\\proj-perms");
    const opencodeModes = await manager.listPermissionModesFor(project.id, "opencode");
    expect(opencodeModes.map((m) => m.id)).toEqual(["manual", "auto", "bypassPermissions"]);
    expect(opencodeModes.find((m) => m.id === "bypassPermissions")?.native).toBe(false);
    const claudeModes = await manager.listPermissionModesFor(project.id, "claude");
    expect(claudeModes).toHaveLength(2);
    expect(claudeModes.find((m) => m.id === "bypassPermissions")?.native).toBe(true);
    manager.dispose();
  });

  it("reports each real harness driver permission list with synthetic bypass for claude and opencode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-test-perms-"));
    const manager = new SessionManager({
      dbPath: join(dir, "test.db"),
      settingsPath: join(dir, "settings.json")
    });
    manager.setSettings({ autoTitleEnabled: false });
    try {
      const project = manager.addProject("C:\\proj-perms-real");
      const claudeModes = await manager.listPermissionModesFor(project.id, "claude");
      expect(claudeModes.map((m) => m.id)).toEqual(["manual", "acceptEdits", "auto", "bypassPermissions"]);
      expect(claudeModes.find((m) => m.id === "bypassPermissions")).toMatchObject({
        label: "Bypass permissions",
        native: false,
        description: SYNTHETIC_FULL_ACCESS_DESCRIPTION
      });
      const codexModes = await manager.listPermissionModesFor(project.id, "codex");
      expect(codexModes.map((m) => m.id)).toEqual(["manual", "auto", "bypassPermissions"]);
      expect(codexModes.find((m) => m.id === "bypassPermissions")).toMatchObject({
        label: "Full Access",
        native: true
      });
      const opencodeModes = await manager.listPermissionModesFor(project.id, "opencode");
      expect(opencodeModes.map((m) => m.id)).toEqual(["manual", "auto", "bypassPermissions"]);
      expect(opencodeModes.find((m) => m.id === "manual")).toMatchObject({ label: "Ask", native: true });
      expect(opencodeModes.find((m) => m.id === "bypassPermissions")).toMatchObject({
        label: "Full Access",
        native: false
      });
    } finally {
      manager.dispose();
    }
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

  it("stores a start snapshot for each turn and an end snapshot when the turn finishes", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-snapshot-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    const stored = () => storedSnapshot(manager, session.id);

    const firstTurn = await manager.startTurn(session.id, "first");
    const first = stored();
    expect(first).toMatchObject({ turnId: firstTurn, sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(first?.error).toBeUndefined();
    expect(first?.endSha).toBeUndefined();

    writeFileSync(join(worktreePath, "README.md"), "changed\n", "utf8");
    fake.complete(firstTurn, 1);
    await endSnapshotsSettled(manager);
    expect(stored()?.endSha).toBeUndefined();
    fake.complete(firstTurn);
    await endSnapshotsSettled(manager);
    const ended = stored();
    expect(ended).toMatchObject({ turnId: firstTurn, sha: first?.sha, endSha: expect.stringMatching(/^[0-9a-f]{40}$/), endedAt: expect.any(Number) });
    expect(execFileSync("git", ["-C", worktreePath, "show", `${ended?.endSha}:README.md`], { encoding: "utf8" }).replace(/\r\n/g, "\n")).toBe("changed\n");

    const secondTurn = await manager.startTurn(session.id, "second");
    const second = stored();
    expect(second?.turnId).toBe(secondTurn);
    expect(second?.sha).not.toBe(first?.sha);
    expect(second?.endSha).toBeUndefined();
    manager.dispose();
  });

  it("captures the end snapshot on turn errors and interrupts", async () => {
    const { manager, project } = makeGitSandboxManager("cw-turn-snapshot-end-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });

    const failed = await manager.startTurn(session.id, "fail");
    (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({ type: "turn.error", turnId: failed, message: "boom" });
    await endSnapshotsSettled(manager);
    expect(storedSnapshot(manager, session.id)).toMatchObject({ turnId: failed, endSha: expect.stringMatching(/^[0-9a-f]{40}$/) });

    const interrupted = await manager.startTurn(session.id, "stop");
    manager.interrupt(interrupted);
    await endSnapshotsSettled(manager);
    expect(storedSnapshot(manager, session.id)).toMatchObject({ turnId: interrupted, endSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    manager.dispose();
  });

  it("stores a start snapshot failure as an error and still runs the turn", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-snapshot-fail-");
    (manager as unknown as { git: { snapshotWorkingTree(root: string): Promise<string> } }).git.snapshotWorkingTree = async () => {
      throw new Error("snapshot boom");
    };
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const turnId = await manager.startTurn(session.id, "go");
    const snapshot = storedSnapshot(manager, session.id);
    expect(snapshot).toMatchObject({ turnId, error: "snapshot boom" });
    expect(snapshot?.sha).toBeUndefined();
    expect(fake.lastRequest?.prompt).toBe("go");
    fake.completeAll();
    expect(storedSnapshot(manager, session.id)?.endedAt).toEqual(expect.any(Number));
    expect(await manager.turnChanges(session.id)).toBeNull();
    await expect(manager.undoTurn(session.id, turnId, "0".repeat(40))).rejects.toThrow("No snapshot for the last turn");
    manager.dispose();
  });

  it("stores an end snapshot failure and refuses to undo that turn", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-snapshot-end-fail-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const turnId = await manager.startTurn(session.id, "go");
    (manager as unknown as { git: { snapshotWorkingTree(root: string): Promise<string> } }).git.snapshotWorkingTree = async () => {
      throw new Error("end boom");
    };
    fake.complete(turnId);
    await endSnapshotsSettled(manager);
    expect(storedSnapshot(manager, session.id)).toMatchObject({ turnId, endError: "end boom" });
    await expect(manager.undoTurn(session.id, turnId, "0".repeat(40))).rejects.toThrow("The end-of-turn snapshot failed: end boom");
    manager.dispose();
  });

  it("skips snapshots for projects outside a git repository", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-snapshot-nogit");
    const session = await manager.createSession(project.id, "claude");
    await manager.startTurn(session.id, "go");
    expect(storedSnapshot(manager, session.id)).toBeUndefined();
    manager.dispose();
  });

  it("scopes turn changes to start..end, refuses stale or conflicting undos and undoes once", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-undo-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    execFileSync("git", ["-C", worktreePath, "config", "core.autocrlf", "false"]);
    const original = readFileSync(join(worktreePath, "README.md"), "utf8");

    const turnId = await manager.startTurn(session.id, "edit");
    writeFileSync(join(worktreePath, "README.md"), "turn edit\n", "utf8");
    writeFileSync(join(worktreePath, "created.txt"), "created\n", "utf8");
    const running = await manager.turnChanges(session.id);
    expect(running).toMatchObject({ turnId, endSha: null, undoable: false, reason: "Cannot undo while a turn is running", conflicts: [] });
    expect(running?.files.map((file) => file.path)).toEqual(["README.md", "created.txt"]);
    await expect(manager.undoTurn(session.id, turnId, "0".repeat(40))).rejects.toThrow("Cannot undo while a turn is running");

    fake.completeAll();
    const ended = await manager.turnChanges(session.id);
    writeFileSync(join(worktreePath, "after.txt"), "user work after the turn\n", "utf8");
    const endSha = ended?.endSha;
    if (!endSha) throw new Error("expected an end snapshot");
    expect(ended).toEqual({
      turnId,
      endSha,
      undoable: true,
      conflicts: [],
      files: [
        { path: "README.md", change: "modified", added: 1, deleted: 1, binary: false },
        { path: "created.txt", change: "added", added: 1, deleted: 0, binary: false }
      ]
    });
    expect((await manager.turnChanges(session.id))?.files.map((file) => file.path)).toEqual(["README.md", "created.txt"]);
    const diff = await manager.turnDiffRange(session.id);
    expect(diff).toEqual({ base: storedSnapshot(manager, session.id)?.sha, head: endSha });

    await expect(manager.undoTurn(session.id, "stale-turn", endSha)).rejects.toThrow("Only the latest turn can be undone");
    await expect(manager.undoTurn(session.id, turnId, "f".repeat(40))).rejects.toThrow("end snapshot changed since it was reviewed");

    writeFileSync(join(worktreePath, "README.md"), "user edit after the turn\n", "utf8");
    expect(await manager.turnChanges(session.id)).toMatchObject({ undoable: false, conflicts: ["README.md"], reason: "Changed since the turn ended: README.md" });
    await expect(manager.undoTurn(session.id, turnId, endSha)).rejects.toThrow("Changed since the turn ended: README.md");
    expect(existsSync(join(worktreePath, "created.txt"))).toBe(true);
    expect(readFileSync(join(worktreePath, "README.md"), "utf8")).toBe("user edit after the turn\n");

    writeFileSync(join(worktreePath, "README.md"), "turn edit\n", "utf8");
    const undone = await manager.undoTurn(session.id, turnId, endSha);
    expect(undone).toMatchObject({ turnId, endSha, undoable: false, conflicts: [] });
    expect(undone.files.map((file) => file.path)).toEqual(["README.md", "created.txt"]);
    expect(readFileSync(join(worktreePath, "README.md"), "utf8")).toBe(original);
    expect(existsSync(join(worktreePath, "created.txt"))).toBe(false);
    expect(readFileSync(join(worktreePath, "after.txt"), "utf8")).toBe("user work after the turn\n");
    expect(storedSnapshot(manager, session.id)?.undoneAt).toEqual(expect.any(Number));

    await expect(manager.undoTurn(session.id, turnId, endSha)).rejects.toThrow("This turn was already undone");
    expect(await manager.turnChanges(session.id)).toMatchObject({ undoable: false, reason: "This turn was already undone" });
    manager.dispose();
  });

  it("guards undo across sessions that share a root", async () => {
    const { manager, fake, project, repository } = makeGitSandboxManager("cw-turn-shared-root-");
    const first = await manager.createSession(project.id, "claude", { mode: "current" });
    const second = await manager.createSession(project.id, "claude", { mode: "current" });

    const firstTurn = await manager.startTurn(first.id, "first");
    writeFileSync(join(repository, "first.txt"), "first\n", "utf8");
    fake.complete(firstTurn);
    const firstEnd = (await manager.turnChanges(first.id))?.endSha;
    if (!firstEnd) throw new Error("expected an end snapshot");

    const secondTurn = await manager.startTurn(second.id, "second");
    await expect(manager.undoTurn(first.id, firstTurn, firstEnd)).rejects.toThrow("Another session is running a turn in this folder");
    writeFileSync(join(repository, "second.txt"), "second\n", "utf8");
    fake.complete(secondTurn);
    const secondEnd = (await manager.turnChanges(second.id))?.endSha;
    if (!secondEnd) throw new Error("expected an end snapshot");
    await expect(manager.undoTurn(first.id, firstTurn, firstEnd)).rejects.toThrow("A later turn in another session changed this folder");
    expect(await manager.turnChanges(first.id)).toMatchObject({ undoable: false, reason: expect.stringContaining("A later turn in another session") });

    const git = (manager as unknown as { git: { restoreSnapshot: (...args: unknown[]) => Promise<unknown> } }).git;
    const realRestore = git.restoreSnapshot.bind(git);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    git.restoreSnapshot = async (...args: unknown[]) => {
      await gate;
      return realRestore(...args);
    };
    const pendingUndo = manager.undoTurn(second.id, secondTurn, secondEnd);
    await vi.waitFor(() => expect((manager as unknown as { pendingUndos: Set<string> }).pendingUndos.has(second.id)).toBe(true));
    await expect(manager.startTurn(first.id, "blocked")).rejects.toThrow("session busy (undo pending)");
    await expect(manager.startTurn(second.id, "blocked")).rejects.toThrow("session busy (undo pending)");
    await expect(manager.resolveSession(first.id, "resolved")).rejects.toThrow("session busy (undo pending)");
    await expect(manager.withBranchSwitch(first.id, async () => "switched")).rejects.toThrow("session busy (undo pending)");
    await expect(manager.undoTurn(second.id, secondTurn, secondEnd)).rejects.toThrow("Undo already in progress");
    release();
    await pendingUndo;
    expect(existsSync(join(repository, "second.txt"))).toBe(false);
    expect(existsSync(join(repository, "first.txt"))).toBe(true);
    expect(await manager.withBranchSwitch(first.id, async () => "switched")).toBe("switched");
    manager.dispose();
  });

  it("lets a failed undo be retried and marks the turn undone only once it succeeds", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-undo-retry-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    execFileSync("git", ["-C", worktreePath, "config", "core.autocrlf", "false"]);
    const original = readFileSync(join(worktreePath, "README.md"), "utf8");
    const statusBefore = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8" });

    const turnId = await manager.startTurn(session.id, "edit");
    writeFileSync(join(worktreePath, "README.md"), "turn edit\n", "utf8");
    writeFileSync(join(worktreePath, "created.txt"), "created\n", "utf8");
    fake.completeAll();
    const endSha = (await manager.turnChanges(session.id))?.endSha;
    if (!endSha) throw new Error("expected an end snapshot");

    const lockPath = execFileSync("git", ["-C", worktreePath, "rev-parse", "--git-path", "index.lock"], { encoding: "utf8" }).trim();
    const lock = resolve(worktreePath, lockPath);
    writeFileSync(lock, "", "utf8");
    try {
      await expect(manager.undoTurn(session.id, turnId, endSha)).rejects.toThrow(/Retrying Undo is safe/);
    } finally {
      rmSync(lock, { force: true });
    }
    expect(existsSync(join(worktreePath, "created.txt"))).toBe(false);
    expect(readFileSync(join(worktreePath, "README.md"), "utf8")).toBe("turn edit\n");
    expect(storedSnapshot(manager, session.id)?.undoneAt).toBeUndefined();
    expect(await manager.turnChanges(session.id)).toMatchObject({ undoable: true, conflicts: [] });

    await manager.undoTurn(session.id, turnId, endSha);
    expect(readFileSync(join(worktreePath, "README.md"), "utf8")).toBe(original);
    expect(existsSync(join(worktreePath, "created.txt"))).toBe(false);
    expect(execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8" })).toBe(statusBefore);
    expect(storedSnapshot(manager, session.id)?.undoneAt).toEqual(expect.any(Number));
    manager.dispose();
  });

  it("treats nested project roots as shared by the undo guard, but not sibling folders with a common prefix", async () => {
    const { manager, fake, project, repository } = makeGitSandboxManager("cw-turn-nested-root-");
    const nestedRoot = join(repository, "sub");
    mkdirSync(nestedRoot);
    writeFileSync(join(nestedRoot, "keep.txt"), "keep\n", "utf8");
    const siblingRoot = `${repository}2`;
    execFileSync("git", ["init", "-b", "main", siblingRoot]);
    const parent = await manager.createSession(project.id, "claude", { mode: "current" });
    const child = await manager.createSession(manager.addProject(nestedRoot).id, "claude", { mode: "current" });
    const sibling = await manager.createSession(manager.addProject(siblingRoot).id, "claude", { mode: "current" });
    const runTurn = async (sessionId: string, file: string) => {
      const turnId = await manager.startTurn(sessionId, "go");
      writeFileSync(file, "turn\n", "utf8");
      fake.complete(turnId);
      await endSnapshotsSettled(manager);
    };
    const laterTurn = { undoable: false, reason: expect.stringContaining("A later turn in another session") };

    await runTurn(parent.id, join(repository, "parent.txt"));
    await runTurn(sibling.id, join(siblingRoot, "sibling.txt"));
    expect(await manager.turnChanges(parent.id)).toMatchObject({ undoable: true });

    await runTurn(child.id, join(nestedRoot, "child.txt"));
    expect(await manager.turnChanges(parent.id)).toMatchObject(laterTurn);
    expect(await manager.turnChanges(child.id)).toMatchObject({ undoable: true });

    await runTurn(parent.id, join(repository, "parent-2.txt"));
    expect(await manager.turnChanges(child.id)).toMatchObject(laterTurn);
    expect(await manager.turnChanges(sibling.id)).toMatchObject({ undoable: true });
    manager.dispose();
  });

  it("blocks undo when another session on the root has a turn without a usable time range", async () => {
    const { manager, fake, project, repository } = makeGitSandboxManager("cw-turn-missing-end-");
    const first = await manager.createSession(project.id, "claude", { mode: "current" });
    const second = await manager.createSession(project.id, "claude", { mode: "current" });
    const store = (manager as unknown as { store: SessionStore }).store;
    const turnId = await manager.startTurn(first.id, "go");
    writeFileSync(join(repository, "first.txt"), "first\n", "utf8");
    fake.complete(turnId);
    const endSha = (await manager.turnChanges(first.id))?.endSha;
    const capturedAt = storedSnapshot(manager, first.id)?.capturedAt;
    if (!endSha || capturedAt === undefined) throw new Error("expected start and end snapshots");
    const otherTurn = (snapshot: Partial<TurnSnapshot>) =>
      store.updateSession(second.id, { lastTurnSnapshot: { turnId: "other", sha: "a".repeat(40), capturedAt: capturedAt - 60_000, ...snapshot } });

    otherTurn({ endedAt: capturedAt - 30_000 });
    expect(await manager.turnChanges(first.id)).toMatchObject({ undoable: true });

    otherTurn({});
    await expect(manager.undoTurn(first.id, turnId, endSha)).rejects.toThrow("A later turn in another session");

    otherTurn({ endedAt: Number.NaN });
    await expect(manager.undoTurn(first.id, turnId, endSha)).rejects.toThrow("A later turn in another session");

    otherTurn({ capturedAt: Number.NaN, endedAt: capturedAt - 30_000 });
    await expect(manager.undoTurn(first.id, turnId, endSha)).rejects.toThrow("A later turn in another session");
    expect(existsSync(join(repository, "first.txt"))).toBe(true);
    manager.dispose();
  });

  it("waits for the driver to settle an interrupted turn before capturing its end snapshot", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-interrupt-settle-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    let busy = true;
    (fake as CliDriver).activity = () => ({ busySessionIds: busy ? [session.id] : [], ownedProcesses: 1 });

    const turnId = await manager.startTurn(session.id, "stop");
    manager.interrupt(turnId);
    await new Promise((r) => setTimeout(r, 300));
    expect(storedSnapshot(manager, session.id)?.endSha).toBeUndefined();
    writeFileSync(join(worktreePath, "late.txt"), "written while stopping\n", "utf8");
    busy = false;
    await endSnapshotsSettled(manager);

    const endSha = storedSnapshot(manager, session.id)?.endSha;
    expect(endSha).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("git", ["-C", worktreePath, "show", `${endSha}:late.txt`], { encoding: "utf8" }).replace(/\r\n/g, "\n")).toBe("written while stopping\n");
    manager.dispose();
  });

  it("captures the end snapshot of an interrupted turn once the settle wait runs out", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-interrupt-timeout-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    (fake as CliDriver).activity = () => ({ busySessionIds: [session.id], ownedProcesses: 1 });

    const turnId = await manager.startTurn(session.id, "stop");
    const interruptedAt = Date.now();
    manager.interrupt(turnId);
    await endSnapshotsSettled(manager);

    expect(Date.now() - interruptedAt).toBeGreaterThanOrEqual(2_900);
    expect(storedSnapshot(manager, session.id)).toMatchObject({ turnId, endSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    manager.dispose();
  }, 20_000);

  it("reports a missing worktree from turnChanges without recreating it", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-changes-missing-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    const turnId = await manager.startTurn(session.id, "go");
    fake.complete(turnId);
    await endSnapshotsSettled(manager);

    rmSync(worktreePath, { recursive: true, force: true });
    await expect(manager.turnChanges(session.id)).rejects.toThrow(/session worktree is missing/);
    expect(existsSync(worktreePath)).toBe(false);
    expect((manager as unknown as { worktreeRecovery: Map<string, Promise<string>> }).worktreeRecovery.size).toBe(0);
    manager.dispose();
  });

  it("refuses undo while a resolve or worktree recovery is pending", async () => {
    const { manager, fake, project } = makeGitSandboxManager("cw-turn-undo-busy-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const turnId = await manager.startTurn(session.id, "go");
    fake.complete(turnId);
    const endSha = (await manager.turnChanges(session.id))?.endSha;
    if (!endSha) throw new Error("expected an end snapshot");
    const internals = manager as unknown as { pendingResolves: Set<string>; worktreeRecovery: Map<string, Promise<string>> };

    internals.pendingResolves.add(session.id);
    await expect(manager.undoTurn(session.id, turnId, endSha)).rejects.toThrow("session busy (resolve pending)");
    internals.pendingResolves.delete(session.id);

    internals.worktreeRecovery.set(session.id, new Promise<string>(() => {}));
    await expect(manager.undoTurn(session.id, turnId, endSha)).rejects.toThrow("session busy (recovery in progress)");
    internals.worktreeRecovery.delete(session.id);
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

    await endSnapshotsSettled(manager);
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
      usage: [],
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

  it("persists the harness-reported permission mode on the session", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-permission-mode");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");
    (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({
      type: "permission.mode.reported",
      turnId,
      mode: "acceptEdits"
    });
    let sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.effectivePermissionMode).toBe("acceptEdits");
    (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({
      type: "permission.mode.reported",
      turnId,
      mode: null
    });
    sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.effectivePermissionMode).toBeUndefined();
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

  it("keeps the active turn while background tasks run", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-active-bg");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");
    fake.complete(turnId, 2);
    const active = manager.listActiveTurns();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ sessionId: a.id, turnId });
    expect(typeof active[0].startedAt).toBe("number");
    fake.complete(turnId);
    expect(manager.listActiveTurns()).toEqual([]);
    manager.dispose();
  });

  it("marks a linked pull request seen with a freshly refreshed head instead of the cached one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-test-"));
    const ref = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const manager = new SessionManager({
      dbPath: join(dir, "test.db"),
      settingsPath: join(dir, "settings.json"),
      prHead: () => "sha-cached",
      prHeadRefresh: async () => "sha-fresh"
    });
    const fake = new FakeDriver((e) => (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent(e));
    (manager as unknown as { drivers: Record<string, CliDriver> }).drivers = { claude: fake, opencode: fake, codex: fake };
    manager.setSettings({ autoTitleEnabled: false });

    const project = manager.addProject(join(dir, "proj"));
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref, origin: "linked", lastSeenSha: "sha-old", lastSeenAt: 0 });

    const turnId = await manager.startTurn(session.id, "hello");
    fake.complete(turnId);

    const updated = await waitForSessionPrSeen(manager, project.id, session.id, "sha-fresh");
    expect(updated?.prs?.[0]?.lastSeenSha).toBe("sha-fresh");
    manager.dispose();
  });

  it("marks only the pull requests the turn covered, skips head refresh for merged ones, and emits once", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const gadgets = { host: "github.com", owner: "acme", repo: "gadgets", number: 7 };
    const merged = { host: "github.com", owner: "acme", repo: "legacy", number: 9 };
    const refreshed: number[] = [];
    const { manager, fake, project } = makePrManager({
      prHead: (ref) => `cached-${ref.number}`,
      prHeadRefresh: async (ref) => {
        refreshed.push(ref.number);
        return `fresh-${ref.number}`;
      },
      prState: (ref) => (ref.number === 9 ? "MERGED" : "OPEN")
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old-42", lastSeenAt: 0 });
    manager.linkPr(session.id, { ref: gadgets, origin: "linked", lastSeenSha: "old-7", lastSeenAt: 0 });
    manager.linkPr(session.id, { ref: merged, origin: "linked", lastSeenSha: "old-9", lastSeenAt: 0 });
    const emitted: SessionMeta[] = [];
    manager.setSessionEmitter((meta) => emitted.push(structuredClone(meta)));

    const turnId = await manager.startTurn(session.id, "hello", { prRefs: [widgets, merged] });
    fake.complete(turnId);

    const updated = await waitForSessionPrSeen(manager, project.id, session.id, "fresh-42", 42);
    expect(updated?.prs?.map((link) => [link.ref.number, link.lastSeenSha, link.lastSeenAt > 0])).toEqual([
      [42, "fresh-42", true],
      [7, "old-7", false],
      [9, "cached-9", true]
    ]);
    expect(refreshed.sort()).toEqual([42, 7].sort());
    expect(emitted.filter((meta) => meta.prs?.some((link) => link.lastSeenSha === "fresh-42"))).toHaveLength(1);
    manager.dispose();
  });

  it("marks the only link seen even when the turn names no pull request", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const { manager, fake, project } = makePrManager({ prHeadRefresh: async () => "fresh-42" });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old-42", lastSeenAt: 0 });

    const turnId = await manager.startTurn(session.id, "hello");
    fake.complete(turnId);

    const updated = await waitForSessionPrSeen(manager, project.id, session.id, "fresh-42");
    expect(updated?.prs?.[0]?.lastSeenAt).toBeGreaterThan(0);
    manager.dispose();
  });

  it("absorbs the session's own push on an uncovered link without advancing lastSeenAt", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const gadgets = { host: "github.com", owner: "acme", repo: "gadgets", number: 7 };
    const { manager, project, dir } = makePrManager({
      prHeadRefresh: async (ref) => (ref.number === 7 ? "own-head" : "remote-42")
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old-42", lastSeenAt: 5 });
    manager.linkPr(session.id, { ref: gadgets, origin: "opened", lastSeenSha: "old-7", lastSeenAt: 5 });
    (manager as unknown as { store: SessionStore }).store.updateSession(session.id, { worktreePath: dir });
    (manager as unknown as { git: { headSha(root: string): Promise<string> } }).git.headSha = async () => "own-head";

    (manager as unknown as { routeEvent(e: ThreadEvent): void }).routeEvent({
      type: "turn.done",
      turnId: "turn-unscoped",
      sessionId: session.id,
      resumeCursor: "cursor-1",
      resultText: "",
      usage: [],
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });

    const updated = await waitForSessionPrSeen(manager, project.id, session.id, "own-head", 7);
    expect(updated?.prs?.map((link) => [link.ref.number, link.lastSeenSha, link.lastSeenAt])).toEqual([
      [42, "old-42", 5],
      [7, "own-head", 5]
    ]);
    manager.dispose();
  });

  it("does not resurrect a link that was removed while its head was refreshing", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const gadgets = { host: "github.com", owner: "acme", repo: "gadgets", number: 7 };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, fake, project } = makePrManager({
      prHeadRefresh: async (ref) => {
        await gate;
        return `fresh-${ref.number}`;
      }
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old-42", lastSeenAt: 0 });
    manager.linkPr(session.id, { ref: gadgets, origin: "linked", lastSeenSha: "old-7", lastSeenAt: 0 });

    const turnId = await manager.startTurn(session.id, "hello", { prRefs: [widgets, gadgets] });
    fake.complete(turnId);
    manager.unlinkPr(session.id, gadgets);
    release();

    const updated = await waitForSessionPrSeen(manager, project.id, session.id, "fresh-42");
    expect(updated?.prs?.map((link) => link.ref.number)).toEqual([42]);
    manager.dispose();
  });

  it("marks a pull request seen through the snapshot it was given, not the local clock", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-seen-at");
    const session = await manager.createSession(project.id, "claude");
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "a", lastSeenAt: 0 });

    const meta = manager.markPrSeen(session.id, widgets, "a2", 12_345);
    expect(meta.prs?.[0]).toMatchObject({ lastSeenSha: "a2", lastSeenAt: 12_345 });
    manager.dispose();
  });

  it("links, marks seen and unlinks pull requests independently", async () => {
    const { manager } = makeManager();
    const project = manager.addProject("C:\\proj-multi-pr");
    const session = await manager.createSession(project.id, "claude");
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const gadgets = { host: "github.com", owner: "acme", repo: "gadgets", number: 7 };

    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "a", lastSeenAt: 0 });
    manager.linkPr(session.id, { ref: gadgets, origin: "workflow", workflowId: "review", lastSeenSha: "b", lastSeenAt: 0 });
    manager.linkPr(session.id, { ref: widgets, origin: "opened", lastSeenSha: "a2", lastSeenAt: 1 });
    let meta = manager.markPrSeen(session.id, gadgets, "b2", null);
    expect(meta.prs?.map((link) => [link.ref.number, link.origin, link.lastSeenSha])).toEqual([
      [42, "opened", "a2"],
      [7, "workflow", "b2"]
    ]);

    meta = manager.unlinkPr(session.id, widgets);
    expect(meta.prs?.map((link) => link.ref.number)).toEqual([7]);
    expect(meta.prUnlinked).toEqual(["github.com/acme/widgets#42"]);

    meta = manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "a3", lastSeenAt: 2 });
    expect(meta.prs?.map((link) => link.ref.number)).toEqual([7, 42]);
    expect(meta.prUnlinked).toBeUndefined();

    meta = manager.unlinkPr(session.id, widgets);
    meta = manager.unlinkPr(session.id, gadgets);
    expect(meta).not.toHaveProperty("prs");
    expect(meta.prUnlinked).toEqual(["github.com/acme/widgets#42", "github.com/acme/gadgets#7"]);
    manager.dispose();
  });

  it("settles a holding session with a merged linked PR to idle and traces pr-finished", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const { manager, project, dir } = makePrManager({ prState: () => "MERGED" });
    const tracePath = join(dir, "session-status.jsonl");
    initSessionStatusTrace({ filePath: tracePath });
    try {
      const session = await manager.createSession(project.id, "claude", { mode: "current" });
      manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
      const store = (manager as unknown as { store: SessionStore }).store;
      store.updateSession(session.id, { status: "holding" });
      manager.setSettings({ prFinishedSessionStatus: "idle" });

      const settled = await manager.settleFinishedPrSessions();

      expect(settled).toEqual([session.id]);
      expect(store.getSession(session.id)?.status).toBe("idle");
      const transitions = readStatusTransitions(tracePath);
      expect(transitions.some((entry) => entry.sessionId === session.id && entry.to === "idle" && entry.reason === "pr-finished")).toBe(true);
    } finally {
      resetSessionStatusTraceForTests();
      manager.dispose();
    }
  });

  it("settles a done session with a closed linked PR to idle and traces pr-finished", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };
    const { manager, project, dir } = makePrManager({ prState: () => "CLOSED" });
    const tracePath = join(dir, "session-status.jsonl");
    initSessionStatusTrace({ filePath: tracePath });
    try {
      const session = await manager.createSession(project.id, "claude", { mode: "current" });
      manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
      const store = (manager as unknown as { store: SessionStore }).store;
      store.updateSession(session.id, { status: "done" });
      manager.setSettings({ prFinishedSessionStatus: "idle" });

      const settled = await manager.settleFinishedPrSessions();

      expect(settled).toEqual([session.id]);
      expect(store.getSession(session.id)?.status).toBe("idle");
      const transitions = readStatusTransitions(tracePath);
      expect(transitions.some((entry) => entry.sessionId === session.id && entry.to === "idle" && entry.reason === "pr-finished")).toBe(true);
    } finally {
      resetSessionStatusTraceForTests();
      manager.dispose();
    }
  });

  it("settles when the refreshed state is finished even though the known state is stale", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const { manager, project } = makePrManager({ prState: () => "OPEN", prStateRefresh: async () => "MERGED" });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([session.id]);
    expect(store.getSession(session.id)?.status).toBe("idle");
    manager.dispose();
  });

  it("settles when a later linked PR is the finished one", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const gadgets = { host: "github.com", owner: "acme", repo: "gadgets", number: 7 };
    const { manager, project } = makePrManager({ prState: (ref) => (ref.number === 7 ? "MERGED" : "OPEN") });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    manager.linkPr(session.id, { ref: gadgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([session.id]);
    expect(store.getSession(session.id)?.status).toBe("idle");
    manager.dispose();
  });

  it("leaves an open PR session alone when the refresh reports it still open", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const { manager, project } = makePrManager({ prState: () => "OPEN", prStateRefresh: async () => "OPEN" });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([]);
    expect(store.getSession(session.id)?.status).toBe("holding");
    manager.dispose();
  });

  it("leaves an open PR session alone when the refresh throws", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    let refreshCalls = 0;
    const { manager, project } = makePrManager({
      prState: () => "OPEN",
      prStateRefresh: async () => {
        refreshCalls += 1;
        throw new Error("gh exploded");
      }
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([]);
    expect(refreshCalls).toBe(1);
    expect(store.getSession(session.id)?.status).toBe("holding");
    manager.dispose();
  });

  it("does nothing for a finished PR when the target status is none", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    let refreshCalls = 0;
    const { manager, project } = makePrManager({
      prState: () => "MERGED",
      prStateRefresh: async () => {
        refreshCalls += 1;
        return "MERGED";
      }
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "none" });

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([]);
    expect(refreshCalls).toBe(0);
    expect(store.getSession(session.id)?.status).toBe("holding");
    manager.dispose();
  });

  it("skips finished-PR settling while a turn is active", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const { manager, fake, project } = makePrManager({ prState: () => "MERGED" });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const turnId = await manager.startTurn(session.id, "hello");
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([]);
    expect(store.getSession(session.id)?.status).toBe("holding");
    fake.complete(turnId);
    manager.dispose();
  });

  it("leaves the session alone when its status changes during the refresh", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    let sessionId = "";
    const { manager, project } = makePrManager({
      prState: () => "OPEN",
      prStateRefresh: async () => {
        (manager as unknown as { store: SessionStore }).store.updateSession(sessionId, { status: "working" });
        return "MERGED";
      }
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    sessionId = session.id;
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([]);
    expect(store.getSession(session.id)?.status).toBe("working");
    manager.dispose();
  });

  it("leaves the session alone when the finished PR is unlinked during the refresh", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    let sessionId = "";
    const { manager, project } = makePrManager({
      prState: () => "OPEN",
      prStateRefresh: async () => {
        manager.unlinkPr(sessionId, widgets);
        return "MERGED";
      }
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    sessionId = session.id;
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([]);
    expect(store.getSession(session.id)?.status).toBe("holding");
    manager.dispose();
  });

  it("does not run overlapping sweeps concurrently", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshCalls = 0;
    const { manager, project } = makePrManager({
      prState: () => "OPEN",
      prStateRefresh: async () => {
        refreshCalls += 1;
        await gate;
        return "MERGED";
      }
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "idle" });

    const first = manager.settleFinishedPrSessions();
    const second = manager.settleFinishedPrSessions();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(refreshCalls).toBe(1);
    expect(a).toEqual([session.id]);
    expect(b).toEqual([session.id]);
    expect(store.getSession(session.id)?.status).toBe("idle");
    manager.dispose();
  });

  it("resolves a finished-PR session without a worktree and emits it", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const { manager, project } = makePrManager({ prState: () => "MERGED" });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "resolved" });
    const emitted: SessionMeta[] = [];
    manager.setSessionEmitter((meta) => emitted.push(meta));

    const settled = await manager.settleFinishedPrSessions();

    expect(settled).toEqual([session.id]);
    expect(store.getSession(session.id)?.status).toBe("resolved");
    expect(store.getSession(session.id)?.autoResolved).toBe(true);
    expect(emitted.some((meta) => meta.id === session.id && meta.status === "resolved")).toBe(true);
    manager.dispose();
  });

  it("marks a sweep-resolved session autoResolved but not a manual resolve", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const { manager, project } = makePrManager({ prState: () => "MERGED" });
    const swept = await manager.createSession(project.id, "claude", { mode: "current" });
    const manual = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(swept.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(swept.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "resolved" });

    await manager.settleFinishedPrSessions();
    await manager.resolveSession(manual.id, "resolved");

    expect(store.getSession(swept.id)?.status).toBe("resolved");
    expect(store.getSession(swept.id)?.autoResolved).toBe(true);
    expect(store.getSession(manual.id)?.status).toBe("resolved");
    expect(store.getSession(manual.id)).not.toHaveProperty("autoResolved");
    manager.dispose();
  });

  it("invokes onResolved for a sweep resolve and not for a direct status set", async () => {
    const widgets = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    const resolvedIds: string[] = [];
    const { manager, project } = makePrManager({
      prState: () => "MERGED",
      onResolved: (sessionId) => resolvedIds.push(sessionId)
    });
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    manager.linkPr(session.id, { ref: widgets, origin: "linked", lastSeenSha: "old", lastSeenAt: 0 });
    const store = (manager as unknown as { store: SessionStore }).store;
    store.updateSession(session.id, { status: "holding" });
    manager.setSettings({ prFinishedSessionStatus: "resolved" });

    await manager.settleFinishedPrSessions();
    expect(resolvedIds).toEqual([session.id]);

    manager.setSessionStatus(session.id, "idle", "user-set-status");
    expect(resolvedIds).toEqual([session.id]);
    manager.dispose();
  });

  it("resolves an idle session past the cutoff, traces idle-expired and emits it", async () => {
    const { manager, project, dir } = makePrManager({});
    const tracePath = join(dir, "session-status.jsonl");
    initSessionStatusTrace({ filePath: tracePath });
    try {
      const session = await manager.createSession(project.id, "claude", { mode: "current" });
      const store = (manager as unknown as { store: SessionStore }).store;
      const now = Date.now();
      const stored = store.getSession(session.id);
      if (!stored) throw new Error("expected session");
      stored.idleSince = now - 31 * 86_400_000;
      const emitted: SessionMeta[] = [];
      manager.setSessionEmitter((meta) => emitted.push(meta));

      const resolved = await manager.resolveExpiredIdleSessions(now);

      expect(resolved).toEqual([session.id]);
      expect(store.getSession(session.id)?.status).toBe("resolved");
      expect(store.getSession(session.id)?.autoResolved).toBe(true);
      expect(emitted.some((meta) => meta.id === session.id && meta.status === "resolved")).toBe(true);
      const transitions = readStatusTransitions(tracePath);
      expect(
        transitions.some((entry) => entry.sessionId === session.id && entry.to === "resolved" && entry.reason === "idle-expired")
      ).toBe(true);
    } finally {
      resetSessionStatusTraceForTests();
      manager.dispose();
    }
  });

  it("leaves idle sessions inside the configured window untouched", async () => {
    const { manager, project } = makePrManager({});
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    const store = (manager as unknown as { store: SessionStore }).store;
    const now = Date.now();
    const stored = store.getSession(session.id);
    if (!stored) throw new Error("expected session");
    stored.idleSince = now - 29 * 86_400_000;

    const resolved = await manager.resolveExpiredIdleSessions(now);

    expect(resolved).toEqual([]);
    expect(store.getSession(session.id)?.status).toBe("idle");
    manager.dispose();
  });

  it("does not resolve idle sessions when idleResolveAfterDays is disabled", async () => {
    const { manager, project } = makePrManager({});
    const session = await manager.createSession(project.id, "claude", { mode: "current" });
    const store = (manager as unknown as { store: SessionStore }).store;
    const now = Date.now();
    const stored = store.getSession(session.id);
    if (!stored) throw new Error("expected session");
    stored.idleSince = now - 365 * 86_400_000;
    manager.setSettings({ idleResolveAfterDays: 0 });

    const resolved = await manager.resolveExpiredIdleSessions(now);

    expect(resolved).toEqual([]);
    expect(store.getSession(session.id)?.status).toBe("idle");
    manager.dispose();
  });

  it("removes the worktree of an expired idle session", async () => {
    const { manager, project } = makeGitSandboxManager("cw-idle-worktree-");
    const session = await manager.createSession(project.id, "claude");
    if (!session.worktreePath) throw new Error("expected a worktree");
    const worktreePath = session.worktreePath;
    const store = (manager as unknown as { store: SessionStore }).store;
    const now = Date.now();
    const stored = store.getSession(session.id);
    if (!stored) throw new Error("expected session");
    stored.idleSince = now - 31 * 86_400_000;

    const resolved = await manager.resolveExpiredIdleSessions(now);

    expect(resolved).toEqual([session.id]);
    expect(store.getSession(session.id)?.status).toBe("resolved");
    expect(store.getSession(session.id)?.worktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
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

  it("keeps the session working while background tasks run and completes on the final turn.done", async () => {
    const { manager, fake } = makeManager();
    const project = manager.addProject("C:\\proj-background");
    const a = await manager.createSession(project.id, "claude");
    const turnId = await manager.startTurn(a.id, "hello");

    fake.complete(turnId, 2);
    let sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("working");
    expect(sessions.find((s) => s.id === a.id)?.resumeCursor).toMatch(/^cursor-/);
    await expect(manager.startTurn(a.id, "second")).rejects.toThrow(/busy/);

    fake.complete(turnId);
    sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.status).toBe("done");
    await expect(manager.startTurn(a.id, "second")).resolves.toEqual(expect.any(String));
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

  it("forwards a slash command and leaves the title for the first real prompt", async () => {
    const { manager, fake, titles } = makeManager();
    manager.setSettings({ autoTitleEnabled: true });
    const project = manager.addProject("C:\\proj-title-command");
    const a = await manager.createSession(project.id, "claude");
    await manager.startTurn(a.id, "/review focus on auth", { command: { name: "review", args: "focus on auth" } });
    expect(fake.seen).toHaveLength(1);
    expect(fake.lastRequest).toMatchObject({
      sessionId: a.id,
      prompt: "/review focus on auth",
      command: { name: "review", args: "focus on auth" }
    });
    const sessions = await manager.listSessions(project.id);
    expect(sessions.find((s) => s.id === a.id)?.title).toBe("New session");
    expect(titles).toEqual([]);
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
    expect(summary.clearedSessionIds).toEqual([session.id]);
    const pruned = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(pruned?.worktreePath).toBeUndefined();
    expect(manager.rootFor(session.id)).toBe(project.rootPath);
    manager.dispose();
  });

  it("clears resolved sessions' missing worktrees even when the worktrees root is gone", async () => {
    const { manager, project } = makeGitSandboxManager("cw-prune-noroot-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    await manager.resolveSession(session.id, "resolved");
    rmSync(join(worktreePath, "..", ".."), { recursive: true, force: true });

    const summary = await manager.pruneStaleWorktrees();

    expect(summary.clearedSessionIds).toEqual([session.id]);
    expect((await manager.listSessions(project.id)).find((s) => s.id === session.id)?.worktreePath).toBeUndefined();
    manager.dispose();
  });

  it("returns a resolved session to the project checkout when its worktree is already gone", async () => {
    const { manager, project } = makeGitSandboxManager("cw-resolve-gone-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    rmSync(worktreePath, { recursive: true, force: true });

    const result = await manager.resolveSession(session.id, "resolved", { removeWorktree: true });

    expect(result.error).toBeUndefined();
    expect(result.dirtyBlocked).toBeUndefined();
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.worktreePath).toBeUndefined();
    manager.dispose();
  });

  it("waits for the driver to stop the session before removing its worktree", async () => {
    const { manager, project, fake } = makeGitSandboxManager("cw-resolve-stop-await-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");

    let releaseStop: (() => void) | undefined;
    fake.stopSession = () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    let settled = false;
    const pending = manager.resolveSession(session.id, "resolved", { removeWorktree: true }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(releaseStop).toBeTypeOf("function");
    expect(settled).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);

    releaseStop!();
    const result = await pending;

    expect(result.worktreeRemoved).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    manager.dispose();
  });

  it("keeps the worktree when the driver cannot stop the session", async () => {
    const { manager, project, fake } = makeGitSandboxManager("cw-resolve-stop-fail-");
    const session = await manager.createSession(project.id, "claude", { baseBranch: "main" });
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    fake.stopSession = async () => {
      throw new Error("archive boom");
    };

    const result = await manager.resolveSession(session.id, "resolved", { removeWorktree: true });

    expect(result.error).toBe("could not stop claude session: archive boom");
    expect(result.worktreeRemoved).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);
    const stored = (await manager.listSessions(project.id)).find((s) => s.id === session.id);
    expect(stored?.worktreePath).toBe(worktreePath);
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

  it("attaches the author's matching PR branch and keeps it when the worktree is removed with force", async () => {
    const { manager, project, repository } = makeGitSandboxManager("cw-resolve-pr-branch-");
    execFileSync("git", ["-C", repository, "branch", "feature/pr"]);
    const headRefOid = execFileSync("git", ["-C", repository, "rev-parse", "feature/pr"], { encoding: "utf8" }).trim();
    const session = await manager.createSession(project.id, "claude", {
      mode: "new",
      prHead: { number: 7, headRefName: "feature/pr", headRefOid, viewerIsAuthor: true }
    });
    expect(session.branch).toBe("feature/pr");
    const worktreePath = session.worktreePath;
    if (!worktreePath) throw new Error("expected a worktree-backed session");
    writeFileSync(join(worktreePath, "pr.txt"), "work\n", "utf8");
    execFileSync("git", ["-C", worktreePath, "add", "pr.txt"]);
    execFileSync("git", ["-C", worktreePath, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "pr work"]);

    const result = await manager.resolveSession(session.id, "archived", { removeWorktree: true, forceBranch: true });

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
    const kept = execFileSync("git", ["-C", repository, "branch", "--list", "feature/pr"], { encoding: "utf8" });
    expect(kept.trim()).not.toBe("");
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
