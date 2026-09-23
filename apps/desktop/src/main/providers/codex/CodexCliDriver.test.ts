import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import type { CodexAppServerLike } from "./codexAppServer.js";
import { CodexCliDriver } from "./CodexCliDriver.js";

const SETTINGS: AppSettings = {
  claudeBinaryPath: "claude",
  opencodeBinaryPath: "opencode",
  codexBinaryPath: "codex",
  claudeExtraArgs: "",
  opencodeExtraArgs: "",
  codexExtraArgs: "",
  claudeDefaultModel: "",
  claudeEnabledModels: [],
  claudeCustomModel: { id: "", name: "" },
  claudeReasoningExpanded: false,
  opencodeReasoningExpanded: false,
  codexReasoningExpanded: false,
  gitBinaryPath: "git",
  githubCliBinaryPath: "gh",
  sourceControlRefreshIntervalSeconds: 30,
  defaultUseWorktree: true,
  holdingHours: 6,
  autoTitleEnabled: true,
  autoTitleDriver: "claude",
  autoTitleModel: "claude-sonnet-5",
  autoTitleEffort: "low"
};

class FakeClient implements CodexAppServerLike {
  requests: Array<{ method: string; params?: unknown }> = [];
  responses: Array<{ id: string | number; result: unknown }> = [];
  spawnEnvs: Array<Record<string, string> | undefined> = [];
  running = false;
  private pendingEnv: Record<string, string> | undefined;
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private serverRequestHandler: ((method: string, params: unknown, id: string | number) => void) | null = null;
  private requestCount = 0;

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.running) {
      this.running = true;
      this.spawnEnvs.push(this.pendingEnv);
    }
    this.requests.push({ method, params });
    this.requestCount++;
    const id = this.requestCount;
    switch (method) {
      case "thread/start":
        return { thread: { id: `thr_${id}` } } as T;
      case "thread/resume":
        return { thread: { id: "thr_resume" } } as T;
      case "turn/start":
        return { turn: { id: `turn_${id}` } } as T;
      case "turn/interrupt":
        return {} as T;
      case "thread/name/set":
        return {} as T;
      case "review/start":
        return {
          turn: { id: `turn_${id}` },
          reviewThreadId: (params as { threadId?: string } | undefined)?.threadId ?? ""
        } as T;
      case "skills/list":
        return {
          data: [
            {
              cwd: (params as { cwds?: string[] } | undefined)?.cwds?.[0] ?? "",
              skills: [{ name: "ship", description: "Ship it", path: "/skills/ship", enabled: true }],
              errors: []
            }
          ]
        } as T;
      case "thread/list":
        return {
          data: [
            {
              id: "thr_a",
              name: "Thread A",
              createdAt: 1,
              updatedAt: 2,
              model: "gpt-6-astra",
              ephemeral: false
            },
            { id: "thr_b", preview: "Second", createdAt: 3, updatedAt: 4, ephemeral: true }
          ],
          nextCursor: null
        } as T;
      case "model/list":
        return {
          data: [
            { id: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true, hidden: false },
            { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false }
          ],
          nextCursor: null
        } as T;
      case "thread/read": {
        const threadId = (params as { threadId?: string } | undefined)?.threadId;
        if (threadId === "thr_child") {
          return {
            thread: {
              id: "thr_child",
              model: "gpt-6-astra",
              turns: [
                {
                  id: "turn_c",
                  startedAt: 10,
                  completedAt: 12,
                  items: [
                    {
                      type: "commandExecution",
                      id: "cc1",
                      command: "ls",
                      cwd: "C:\\proj",
                      aggregatedOutput: "a.ts\nb.ts",
                      exitCode: 0,
                      status: "completed"
                    },
                    {
                      type: "fileChange",
                      id: "cf1",
                      status: "completed",
                      changes: [{ path: "a.ts", kind: "update", diff: "@@" }]
                    }
                  ]
                }
              ]
            }
          } as T;
        }
        return {
          thread: {
            id: "thr_history",
            turns: [
              {
                id: "turn_h",
                startedAt: 7,
                items: [
                  { type: "userMessage", id: "h1", content: [{ type: "text", text: "hello" }] },
                  { type: "agentMessage", id: "h2", text: "hi there" }
                ]
              }
            ]
          }
        } as T;
      }
      default:
        return {} as T;
    }
  }

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }

  setSpawnEnv(env: Record<string, string> | undefined): void {
    this.pendingEnv = env;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: (method: string, params: unknown, id: string | number) => void): void {
    this.serverRequestHandler = handler;
  }

  dispose(): void {}

  notify(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }

  serverRequest(method: string, params: unknown, id: string | number): void {
    this.serverRequestHandler?.(method, params, id);
  }
}

class ThrowingSkillsClient extends FakeClient {
  override async request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "skills/list") throw new Error("skills/list boom");
    return super.request<T>(method, params);
  }
}

function makeDriver(client: FakeClient) {
  const events: ThreadEvent[] = [];
  const driver = new CodexCliDriver(
    (e) => events.push(e),
    () => SETTINGS,
    client
  );
  return { driver, events };
}

async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("CodexCliDriver", () => {
  let client: FakeClient;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    client = new FakeClient();
  });

  it("starts a new thread and maps streamed events into turn.done", async () => {
    const { driver, events } = makeDriver(client);
    const handle = driver.startTurn({
      sessionId: "local-1",
      prompt: "summarize the repo",
      cwd: "C:\\proj",
      permissionMode: "auto",
      effort: "high",
      model: "gpt-6-astra"
    });
    await settle();
    const start = client.requests.find((r) => r.method === "thread/start");
    expect(start?.params).toMatchObject({
      cwd: "C:\\proj",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
      model: "gpt-6-astra"
    });
    const turn = client.requests.find((r) => r.method === "turn/start");
    expect(turn?.params).toMatchObject({
      threadId: "thr_1",
      model: "gpt-6-astra",
      effort: "high",
      input: [{ type: "text", text: "summarize the repo" }]
    });

    client.notify("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "i1",
      delta: "Hello "
    });
    client.notify("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "i1",
      delta: "world"
    });
    client.notify("item/started", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: { type: "commandExecution", id: "c1", command: "npm test", cwd: "C:\\proj" }
    });
    client.notify("thread/tokenUsage/updated", {
      threadId: "thr_1",
      turnId: "turn_2",
      tokenUsage: {
        total: {},
        last: {
          totalTokens: 0,
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          outputTokens: 12,
          reasoningOutputTokens: 3
        },
        modelContextWindow: null
      }
    });
    client.notify("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "completed", items: [] }
    });
    await settle();

    const done = events.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      turnId: handle.turnId,
      sessionId: "local-1",
      resumeCursor: "thr_1",
      inputTokens: 140,
      outputTokens: 15,
      costUsd: 0,
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    const deltas = events.filter((e) => e.type === "assistant.delta");
    expect(deltas.map((d) => ("text" in d ? d.text : ""))).toEqual(["Hello ", "world"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.call",
        toolCallId: "c1",
        name: "shell"
      })
    );
    driver.dispose();
  });

  it("maps collab tool calls to subagent tool events", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "spawn", cwd: "C:\\proj" });
    await settle();
    client.notify("item/started", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: {
        type: "collabToolCall",
        id: "co1",
        tool: "spawn_agent",
        prompt: "review the diff",
        receiverThreadIds: ["thr_child"],
        status: "in_progress"
      }
    });
    client.notify("item/completed", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: {
        type: "collabToolCall",
        id: "co1",
        tool: "spawn_agent",
        receiverThreadIds: ["thr_child"],
        status: "completed",
        agentsStates: { thr_child: { status: "running" } }
      }
    });
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.call",
        toolCallId: "co1",
        name: "collab:spawn_agent",
        input: expect.objectContaining({ prompt: "review the diff", receiverThreadIds: ["thr_child"] })
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.result",
        toolCallId: "co1",
        agentId: "thr_child",
        isError: false
      })
    );
    driver.dispose();
  });

  it("maps the snake_case collab item shape", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "spawn", cwd: "C:\\proj" });
    await settle();
    client.notify("item/started", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: {
        type: "collab_tool_call",
        id: "co2",
        tool: "wait",
        receiver_thread_ids: ["thr_child"],
        status: "in_progress"
      }
    });
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.call", toolCallId: "co2", name: "collab:wait" })
    );
    driver.dispose();
  });

  it("reads subagent tool activity from the child thread", async () => {
    const { driver } = makeDriver(client);
    const result = await driver.getSubagentTools("C:\\proj", "thr_parent", "thr_child");
    expect(result.model).toBe("gpt-6-astra");
    expect(result.items.map((item) => item.name)).toEqual(["shell", "edit"]);
    expect(result.items[0].output).toBe("a.ts\nb.ts");
    expect(result.items[0].timestamp).toBe(10000);
    expect(result.items[0].completedAt).toBe(12000);
    expect(result.items[1].input).toEqual({ changes: [{ path: "a.ts", kind: "update", diff: "@@" }] });
    driver.dispose();
  });

  it("maps reasoning notifications to reasoning.delta and sticks to one stream per item", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "think", cwd: "C:\\proj" });
    await settle();
    client.notify("item/reasoning/summaryTextDelta", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "r1",
      delta: "**Planning**",
      summaryIndex: 0
    });
    client.notify("item/reasoning/summaryTextDelta", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "r1",
      delta: " more",
      summaryIndex: 0
    });
    client.notify("item/reasoning/textDelta", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "r1",
      delta: "raw reasoning",
      contentIndex: 0
    });
    await settle();
    const reasoning = events.filter((e) => e.type === "reasoning.delta");
    expect(reasoning.map((e) => ("text" in e ? e.text : ""))).toEqual(["**Planning**", " more"]);
    expect(events.some((e) => e.type === "assistant.delta")).toBe(false);
    driver.dispose();
  });

  it("emits the full reasoning text from item/completed when nothing streamed", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "think", cwd: "C:\\proj" });
    await settle();
    client.notify("item/completed", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: { type: "reasoning", id: "r2", summary: [{ type: "summary_text", text: "Summary body" }] }
    });
    await settle();
    expect(events).toContainEqual({
      type: "reasoning.delta",
      turnId: expect.any(String),
      text: "Summary body"
    });
    driver.dispose();
  });

  it("emits todo.updated from a turn/plan/updated notification for the active turn", async () => {
    const { driver, events } = makeDriver(client);
    const handle = driver.startTurn({ sessionId: "local-1", prompt: "plan the work", cwd: "C:\\proj" });
    await settle();
    client.notify("turn/plan/updated", {
      threadId: "thr_1",
      turnId: "turn_2",
      explanation: "here is the plan",
      plan: [
        { step: "Inspect the repo", status: "completed" },
        { step: "Write the fix", status: "in_progress" },
        { step: "Add tests", status: "queued" }
      ]
    });
    await settle();
    expect(events).toContainEqual({
      type: "todo.updated",
      turnId: handle.turnId,
      todos: [
        { content: "Inspect the repo", status: "completed" },
        { content: "Write the fix", status: "in_progress" },
        { content: "Add tests", status: "pending" }
      ]
    });
    driver.dispose();
  });

  it("emits an empty todo.updated when the active turn's plan is empty", async () => {
    const { driver, events } = makeDriver(client);
    const handle = driver.startTurn({ sessionId: "local-1", prompt: "plan the work", cwd: "C:\\proj" });
    await settle();
    client.notify("turn/plan/updated", {
      threadId: "thr_1",
      turnId: "turn_2",
      plan: []
    });
    await settle();
    expect(events).toContainEqual({
      type: "todo.updated",
      turnId: handle.turnId,
      todos: []
    });
    driver.dispose();
  });

  it("drops plan updates for unknown turns", async () => {
    const { driver, events } = makeDriver(client);
    client.notify("turn/plan/updated", {
      threadId: "thr_zzz",
      turnId: "turn_zzz",
      plan: [{ step: "Nope", status: "pending" }]
    });
    await settle();
    expect(events.filter((e) => e.type === "todo.updated")).toEqual([]);
    driver.dispose();
  });

  it("emits turn.error when the turn fails", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "go", cwd: "C:\\proj" });
    await settle();
    client.notify("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "failed", error: { message: "usage limit reached" }, items: [] }
    });
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.error", message: "usage limit reached" })
    );
    driver.dispose();
  });

  it("resumes a stored thread instead of starting one", async () => {
    const { driver } = makeDriver(client);
    driver.startTurn({
      sessionId: "local-1",
      prompt: "continue",
      cwd: "C:\\proj",
      resumeCursor: "thr_9"
    });
    await settle();
    expect(client.requests.map((r) => r.method)).toEqual(["thread/resume", "turn/start"]);
    expect(client.requests[0].params).toMatchObject({ threadId: "thr_9", cwd: "C:\\proj" });
    expect(client.requests[1].params).toMatchObject({ threadId: "thr_resume" });
    driver.dispose();
  });

  it("interrupts the active codex turn", async () => {
    const { driver } = makeDriver(client);
    const handle = driver.startTurn({ sessionId: "local-1", prompt: "long", cwd: "C:\\proj" });
    await settle();
    driver.interrupt("nope");
    await settle();
    expect(client.requests.some((r) => r.method === "turn/interrupt")).toBe(false);
    driver.interrupt(handle.turnId);
    await settle();
    const interrupt = client.requests.find((r) => r.method === "turn/interrupt");
    expect(interrupt?.params).toMatchObject({ threadId: "thr_1" });
    driver.dispose();
  });

  it("routes command approvals to decisions", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "work", cwd: "C:\\proj" });
    await settle();
    client.serverRequest("item/commandExecution/requestApproval", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "c9",
      command: "git push",
      cwd: "C:\\proj"
    }, 42);
    await settle();
    const request = events.find((e) => e.type === "approval.request");
    expect(request).toMatchObject({
      type: "approval.request",
      turnId: expect.any(String),
      request: {
        kind: "command",
        title: "git push",
        decisions: ["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]
      }
    });
    const requestId = request && "request" in request ? request.request.requestId : "";
    await driver.respondToApproval(requestId, "acceptForSession");
    await settle();
    expect(client.responses).toEqual([{ id: 42, result: { decision: "acceptForSession" } }]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "approval.resolved", requestId })
    );
    driver.dispose();
  });

  it("echoes requested permissions for permission approvals", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "work", cwd: "C:\\proj" });
    await settle();
    const requested = { network: { mode: "restricted" } };
    client.serverRequest("item/permissions/requestApproval", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "p1",
      permissions: requested
    }, 7);
    await settle();
    const request = events.find((e) => e.type === "approval.request");
    const requestId = request && "request" in request ? request.request.requestId : "";
    await driver.respondToApproval(requestId, "acceptForSession");
    await settle();
    expect(client.responses).toEqual([
      { id: 7, result: { permissions: requested, scope: "session" } }
    ]);
    driver.dispose();
  });

  it("auto-declines approvals for unknown turns", async () => {
    const { driver } = makeDriver(client);
    client.serverRequest("item/commandExecution/requestApproval", {
      threadId: "thr_zzz",
      turnId: "turn_zzz",
      itemId: "c1",
      command: "danger"
    }, 9);
    await settle();
    expect(client.responses).toEqual([{ id: 9, result: { decision: "decline" } }]);
    driver.dispose();
  });

  it("lists sessions with pagination and skips ephemeral threads", async () => {
    const { driver } = makeDriver(client);
    client.requests = [];
    const sessions = await driver.listSessions("C:\\proj", "p1");
    expect(client.requests[0]).toMatchObject({ method: "thread/list" });
    expect(client.requests[0].params).toMatchObject({ cwd: "C:\\proj", limit: 50 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "codex:thr_a",
      driver: "codex",
      title: "Thread A",
      resumeCursor: "thr_a",
      createdAt: 1000,
      updatedAt: 2000
    });
    driver.dispose();
  });

  it("reads history through thread/read", async () => {
    const { driver } = makeDriver(client);
    const history = await driver.getHistory("C:\\proj", "thr_history");
    expect(client.requests[0]).toMatchObject({
      method: "thread/read",
      params: { threadId: "thr_history", includeTurns: true }
    });
    expect(history).toEqual([
      { id: "h1", role: "user", text: "hello", turnId: "turn_h", timestamp: 7000 },
      { id: "h2", role: "assistant", text: "hi there", turnId: "turn_h", timestamp: 7000 }
    ]);
    driver.dispose();
  });

  it("lists live models without hidden entries", async () => {
    const { driver } = makeDriver(client);
    const models = await driver.listModels("C:\\proj");
    expect(client.requests[0]).toMatchObject({ method: "model/list" });
    expect(models).toEqual([
      { id: "gpt-6-astra", label: "GPT-6-Astra", source: "live" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", source: "live" }
    ]);
    driver.dispose();
  });

  it("renames native threads by thread id", async () => {
    const { driver } = makeDriver(client);
    await driver.renameSession("thr_a", "Renamed");
    expect(client.requests[0]).toMatchObject({
      method: "thread/name/set",
      params: { threadId: "thr_a", name: "Renamed" }
    });
    driver.dispose();
  });

  it("auto-accepts approvals in the background for full access mode", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "work", cwd: "C:\\proj", permissionMode: "bypassPermissions" });
    await settle();
    client.serverRequest("item/commandExecution/requestApproval", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "c1",
      command: "rm -rf build"
    }, 11);
    await settle();
    expect(events.some((e) => e.type === "approval.request")).toBe(false);
    expect(client.responses).toEqual([{ id: 11, result: { decision: "accept" } }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved" }));
    driver.dispose();
  });

  it("lists native permission modes including full access", async () => {
    const { driver } = makeDriver(client);
    const modes = await driver.listPermissionModes();
    expect(modes.map((m) => m.id)).toEqual(["manual", "auto", "bypassPermissions"]);
    expect(modes.map((m) => m.label)).toEqual(["Read Only", "Auto", "Full Access"]);
    expect(modes.every((m) => m.native)).toBe(true);
    driver.dispose();
  });

  it("applies each turn's env to the next app-server spawn and never restarts a live shared server", async () => {
    const shared = new FakeClient();
    const { driver } = makeDriver(shared);
    driver.startTurn({ sessionId: "s1", cwd: "C:\\w1", prompt: "a", env: { CW_SESSION_ID: "s1" } });
    await settle();
    driver.startTurn({ sessionId: "s2", cwd: "C:\\w2", prompt: "b", env: { CW_SESSION_ID: "s2" } });
    await settle();
    expect(shared.spawnEnvs).toEqual([{ CW_SESSION_ID: "s1" }]);
    shared.running = false;
    driver.startTurn({ sessionId: "s3", cwd: "C:\\w3", prompt: "c", env: { CW_SESSION_ID: "s3" } });
    await settle();
    expect(shared.spawnEnvs).toEqual([{ CW_SESSION_ID: "s1" }, { CW_SESSION_ID: "s3" }]);
    driver.dispose();
  });

  it("passes existing absolute attachments through and drops escapes", async () => {
    const { driver } = makeDriver(client);
    const outside = mkdtempSync(join(tmpdir(), "cw-codex-outside-"));
    const abs = join(outside, "paste.png");
    writeFileSync(abs, "x", "utf8");
    driver.startTurn({
      sessionId: "local-1",
      prompt: "look",
      cwd: "C:\\proj",
      attachments: [abs, join("..", "secret.png")]
    });
    await settle();
    const turn = client.requests.find((r) => r.method === "turn/start");
    const input = (turn?.params as { input?: Array<{ type: string; path?: string }> } | undefined)?.input ?? [];
    expect(input).toContainEqual({ type: "localImage", path: abs });
    expect(input.some((entry) => entry.path === join("..", "secret.png"))).toBe(false);
    driver.dispose();
  });

  it("lists codex built-in commands plus enabled skills", async () => {
    const { driver } = makeDriver(client);
    const commands = await driver.listCommands("C:\\proj");
    expect(client.requests[0]).toMatchObject({ method: "skills/list", params: { cwds: ["C:\\proj"] } });
    expect(commands).toEqual([
      { name: "compact", description: "Summarize the thread to free context", dispatch: "native" },
      {
        name: "review",
        description: "Review uncommitted changes, or follow custom instructions",
        argumentHint: "[instructions]",
        dispatch: "native"
      },
      { name: "ship", description: "Ship it", dispatch: "native" }
    ]);
    driver.dispose();
  });

  it("falls back to built-in commands and warns when skills/list fails", async () => {
    const throwingClient = new ThrowingSkillsClient();
    const { driver } = makeDriver(throwingClient);
    const commands = await driver.listCommands("C:\\proj");
    expect(commands).toEqual([
      { name: "compact", description: "Summarize the thread to free context", dispatch: "native" },
      {
        name: "review",
        description: "Review uncommitted changes, or follow custom instructions",
        argumentHint: "[instructions]",
        dispatch: "native"
      }
    ]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("skills/list boom"));
    driver.dispose();
  });

  it("compacts an existing thread via thread/compact/start and emits the compaction note", async () => {
    const { driver, events } = makeDriver(client);
    const handle = driver.startTurn({
      sessionId: "local-1",
      prompt: "/compact",
      cwd: "C:\\proj",
      resumeCursor: "thr_9",
      command: { name: "compact", args: "" }
    });
    await settle();
    expect(client.requests.map((r) => r.method)).toEqual(["thread/resume", "thread/compact/start"]);
    expect(client.requests[1].params).toMatchObject({ threadId: "thr_resume" });

    client.notify("turn/started", { threadId: "thr_resume", turn: { id: "turn_c1" } });
    client.notify("item/completed", {
      threadId: "thr_resume",
      turnId: "turn_c1",
      item: { type: "contextCompaction", id: "cc1" }
    });
    client.notify("turn/completed", {
      threadId: "thr_resume",
      turn: { id: "turn_c1", status: "completed", items: [] }
    });
    await settle();

    expect(events).toContainEqual({ type: "assistant.delta", turnId: handle.turnId, text: "Context compacted." });
    expect(events.find((e) => e.type === "turn.done")).toMatchObject({
      turnId: handle.turnId,
      resumeCursor: "thr_resume"
    });
    driver.dispose();
  });

  it("prefixes the compaction note with a blank line when the turn already streamed assistant text", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({
      sessionId: "local-1",
      prompt: "/compact",
      cwd: "C:\\proj",
      resumeCursor: "thr_9",
      command: { name: "compact", args: "" }
    });
    await settle();
    client.notify("turn/started", { threadId: "thr_resume", turn: { id: "turn_c2" } });
    client.notify("item/agentMessage/delta", {
      threadId: "thr_resume",
      turnId: "turn_c2",
      delta: "Summarizing the thread..."
    });
    client.notify("item/completed", {
      threadId: "thr_resume",
      turnId: "turn_c2",
      item: { type: "contextCompaction", id: "cc2" }
    });
    await settle();

    const deltas = events.filter((e) => e.type === "assistant.delta").map((e) => ("text" in e ? e.text : ""));
    expect(deltas).toEqual(["Summarizing the thread...", "\n\nContext compacted."]);
    driver.dispose();
  });

  it("ignores contextCompaction items on a normal turn (auto-compaction mid-turn)", async () => {
    const { driver, events } = makeDriver(client);
    driver.startTurn({ sessionId: "local-1", prompt: "keep going", cwd: "C:\\proj" });
    await settle();
    client.notify("item/completed", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: { type: "contextCompaction", id: "cc1" }
    });
    await settle();
    expect(events.some((e) => e.type === "assistant.delta")).toBe(false);
    driver.dispose();
  });

  it("throws synchronously when compacting a thread with no history, without creating a thread", () => {
    const { driver, events } = makeDriver(client);
    expect(() =>
      driver.startTurn({
        sessionId: "local-1",
        prompt: "/compact",
        cwd: "C:\\proj",
        command: { name: "compact", args: "" }
      })
    ).toThrow("Nothing to compact yet");
    expect(events).toEqual([]);
    expect(client.requests).toEqual([]);
    driver.dispose();
  });

  it("starts a review turn via review/start and emits the review text", async () => {
    const { driver, events } = makeDriver(client);
    const handle = driver.startTurn({
      sessionId: "local-1",
      prompt: "/review check races",
      cwd: "C:\\proj",
      command: { name: "review", args: "check races" }
    });
    await settle();
    const review = client.requests.find((r) => r.method === "review/start");
    expect(review?.params).toMatchObject({
      threadId: "thr_1",
      target: { type: "custom", instructions: "check races" },
      delivery: "inline"
    });

    client.notify("item/completed", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: { type: "exitedReviewMode", id: "r1", review: "Looks fine overall." }
    });
    client.notify("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "completed", items: [] }
    });
    await settle();

    expect(events).toContainEqual({ type: "assistant.delta", turnId: handle.turnId, text: "Looks fine overall." });
    expect(events.find((e) => e.type === "turn.done")).toMatchObject({ turnId: handle.turnId });
    driver.dispose();
  });

  it("does not duplicate the review text when agentMessage deltas already streamed it", async () => {
    const { driver, events } = makeDriver(client);
    const handle = driver.startTurn({
      sessionId: "local-1",
      prompt: "/review check races",
      cwd: "C:\\proj",
      command: { name: "review", args: "check races" }
    });
    await settle();

    client.notify("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "turn_2",
      delta: "Looks fine overall."
    });
    client.notify("item/completed", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: { type: "exitedReviewMode", id: "r1", review: "Looks fine overall." }
    });
    client.notify("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "completed", items: [] }
    });
    await settle();

    const deltas = events.filter((e) => e.type === "assistant.delta").map((e) => ("text" in e ? e.text : ""));
    expect(deltas).toEqual(["Looks fine overall."]);
    expect(events.find((e) => e.type === "turn.done")).toMatchObject({ turnId: handle.turnId });
    driver.dispose();
  });

  it("dispatches a skill command through turn/start with a skill item", async () => {
    const { driver } = makeDriver(client);
    const commands = await driver.listCommands("C:\\proj");
    expect(commands.map((c) => c.name)).toEqual(["compact", "review", "ship"]);

    driver.startTurn({
      sessionId: "local-1",
      prompt: "/ship the release",
      cwd: "C:\\proj",
      command: { name: "ship", args: "the release" }
    });
    await settle();
    const turn = client.requests.find((r) => r.method === "turn/start");
    expect(turn?.params).toMatchObject({
      threadId: "thr_2",
      input: [
        { type: "text", text: "$ship the release" },
        { type: "skill", name: "ship", path: "/skills/ship" }
      ]
    });
    driver.dispose();
  });

  it("errors when a skill command cannot be resolved even after refetching skills/list", async () => {
    const { driver, events } = makeDriver(client);
    const handle = driver.startTurn({
      sessionId: "local-1",
      prompt: "/nope",
      cwd: "C:\\proj",
      command: { name: "nope", args: "" }
    });
    await settle();
    const refetch = client.requests.find((r) => r.method === "skills/list");
    expect(refetch?.params).toMatchObject({ cwds: ["C:\\proj"], forceReload: true });
    expect(events).toContainEqual({ type: "turn.error", turnId: handle.turnId, message: "Unknown command: /nope" });
    driver.dispose();
  });

  it("propagates skills/list errors from resolveSkillPath into turn.error", async () => {
    const throwingClient = new ThrowingSkillsClient();
    const { driver, events } = makeDriver(throwingClient);
    const handle = driver.startTurn({
      sessionId: "local-1",
      prompt: "/ship",
      cwd: "C:\\proj",
      command: { name: "ship", args: "" }
    });
    await settle();
    expect(events).toContainEqual({ type: "turn.error", turnId: handle.turnId, message: "skills/list boom" });
    driver.dispose();
  });
});
