import { beforeEach, describe, expect, it, vi } from "vitest";
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
  gitBinaryPath: "git",
  githubCliBinaryPath: "gh",
  sourceControlRefreshIntervalSeconds: 30,
  defaultUseWorktree: true,
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
      case "thread/read":
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
});
