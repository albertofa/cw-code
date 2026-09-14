import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CliDriver, HistoryMessage, ThreadEvent, TurnHandle } from "@cw-code/contracts";
import { SessionManager } from "./SessionManager.js";

class FakeDriver implements CliDriver {
  readonly kind = "claude" as const;
  seen: string[] = [];
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
        isError: false
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
        isError: true
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
});
