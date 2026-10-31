import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ComposerPrefs,
  CreateSessionOptions,
  DriverKind,
  HarnessAvailability,
  ModelOption,
  PermissionMode,
  Project,
  SessionMeta,
  SettingsPatch,
  SubagentIsolation,
  SubagentResult
} from "@cw-code/contracts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { SUBAGENT_DEPTH_REFUSAL } from "../agent/agentPolicy.js";
import { AgentTokens } from "../agent/AgentTokens.js";
import { MCP_IDLE_TIMEOUT_SECONDS } from "../agent/mcpTimeouts.js";
import { SessionWatch } from "../agent/SessionWatch.js";
import type { ServerApp } from "../app/ServerApp.js";
import { registerSessionHandlers } from "../handlers/sessions.js";
import { registerSettingsHandlers } from "../handlers/settings.js";
import { registerSubagentHandlers, type SubagentTarget } from "../handlers/subagents.js";
import { registerTurnHandlers } from "../handlers/turns.js";
import type { StartTurnInput } from "../threads/TurnService.js";
import { Router, type CallContext } from "../transport/Router.js";
import { OPENCODE_SESSION_HEADER } from "@cw-code/shared/protocol";
import { SUBAGENT_TOOL_NAMES } from "@cw-code/shared/subagents";
import { cwToolDefinitions, registerCwTools, SUBAGENT_INPUT_NEXT, SUBAGENT_RUNNING_NEXT, WAIT_MAX_MS } from "./cwTools.js";
import { createMcpRoute, MCP_SERVER_NAME } from "./mcpRoute.js";

const URL_MCP = "http://127.0.0.1:4100/mcp";
const SESSION_TOOL_NAMES = [
  "projects_list",
  "sessions_list",
  "session_get",
  "session_create",
  "session_send",
  "session_stop",
  "session_wait",
  "usage_report",
  "settings_get",
  "settings_set"
];
const TOOL_NAMES = [...SESSION_TOOL_NAMES, ...SUBAGENT_TOOL_NAMES];
const PROJECTS: Project[] = [{ id: "p1", rootPath: "/repo", name: "repo" }];
const MODELS: Record<DriverKind, ModelOption[]> = {
  claude: [
    { id: "claude-opus-5-5", label: "Opus 5.5", source: "curated" },
    { id: "claude-opus-4-5", label: "Opus 4.5", source: "curated" }
  ],
  codex: [{ id: "gpt-5-codex", label: "GPT-5 Codex", source: "live" }],
  opencode: [
    { id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", source: "live", variants: ["high", "max"] },
    { id: "openai/gpt-5-codex", label: "GPT-5 Codex", source: "live" }
  ]
};

interface StartedTurn {
  sessionId: string;
  prompt: string;
  input: StartTurnInput;
}

function meta(id: string, status: SessionMeta["status"], permissionMode?: PermissionMode): SessionMeta {
  return {
    id,
    projectId: "p1",
    driver: "claude",
    title: id,
    status,
    resumeCursor: "",
    createdAt: 1,
    updatedAt: 2,
    ...(permissionMode ? { permissionMode } : {})
  };
}

function harnessCheck(binary: DriverKind, overrides: Partial<HarnessAvailability["checks"][number]> = {}): HarnessAvailability["checks"][number] {
  return { binary, binaryPath: binary, minimum: "1.0.0", actual: null, configured: false, found: true, available: true, error: null, ok: false, skipped: false, ...overrides };
}

let tokens: AgentTokens;
let callerToken: string;
let sessions: SessionMeta[];
let started: StartedTurn[];
let turnModes: Map<string, PermissionMode>;
let emitted: Array<{ channel: string; payload: unknown }>;
let settings: Record<string, unknown>;
let router: Router;
let extended: number[];
let route: ReturnType<typeof createMcpRoute>;
let watch: SessionWatch;
let lastTurns: Map<string, string>;
let pendingCounts: Map<string, number>;
let delivered: Array<[string, string]>;
let installed: DriverKind[];
let harnessChecks: HarnessAvailability["checks"];
let failingHarnesses: Set<DriverKind>;
let failNextStart: boolean;
let resolvedSessions: Array<[string, SessionMeta["status"], { removeWorktree?: boolean }]>;

function findSession(id: string): SessionMeta {
  const session = sessions.find((candidate) => candidate.id === id);
  if (!session) throw new Error(`unknown session ${id}`);
  return session;
}

function child(id: string, parentSessionId: string, status: SessionMeta["status"] = "idle", permissionMode?: PermissionMode): SessionMeta {
  const created = { ...meta(id, status, permissionMode), driver: "codex" as const, subagent: { parentSessionId, isolation: "shared" as const } };
  sessions.push(created);
  return created;
}

const fakeSessions = {
  listProjects: () => PROJECTS,
  listSessions: async (projectId: string) => sessions.filter((session) => session.projectId === projectId),
  createSession: async (projectId: string, driver: DriverKind, _options?: CreateSessionOptions) => {
    const created = { ...meta(`s${sessions.length + 1}`, "idle"), projectId, driver };
    sessions.push(created);
    return { ...created };
  },
  createSubagentSession: async (parentId: string, driver: DriverKind, opts: { title: string; isolation: SubagentIsolation }) => {
    const created: SessionMeta = {
      ...meta(`s${sessions.length + 1}`, "idle"),
      driver,
      title: opts.title,
      subagent: { parentSessionId: parentId, isolation: opts.isolation }
    };
    sessions.push(created);
    return { ...created };
  },
  listSubagents: (parentId: string) => sessions.filter((session) => session.subagent?.parentSessionId === parentId),
  listPendingRequests: (id: string) => Array.from({ length: pendingCounts.get(id) ?? 0 }),
  markSubagentDelivered: (childId: string, turnId: string) => {
    delivered.push([childId, turnId]);
    const link = findSession(childId).subagent;
    if (link?.result?.turnId === turnId) link.delivered = true;
  },
  findSession: (id: string) => sessions.find((session) => session.id === id),
  listActiveTurns: () =>
    sessions.filter((session) => session.status === "working").map((session) => ({ sessionId: session.id, turnId: lastTurns.get(session.id) ?? "t", startedAt: 1 })),
  resolveSession: async (id: string, status: SessionMeta["status"], options: { removeWorktree?: boolean }) => {
    resolvedSessions.push([id, status, options]);
    findSession(id).status = status;
  },
  getComposer: (id: string): ComposerPrefs => ({ permissionMode: findSession(id).permissionMode ?? "auto" }),
  setComposer: (id: string, prefs: ComposerPrefs): ComposerPrefs => {
    findSession(id).permissionMode = prefs.permissionMode;
    return fakeSessions.getComposer(id);
  },
  turnPermissionMode: (id: string) => turnModes.get(id),
  hasSession: (id: string) => sessions.some((session) => session.id === id),
  listModelsFor: async (_projectId: string, driver: DriverKind): Promise<ModelOption[]> => (failingHarnesses.has(driver) ? [] : MODELS[driver]),
  listModelsForHarness: async (driver: DriverKind): Promise<ModelOption[]> => {
    if (failingHarnesses.has(driver)) throw new Error(`${driver} model list failed`);
    return MODELS[driver];
  },
  getSettings: () => settings,
  setSettings: (patch: SettingsPatch) => Object.assign(settings, patch)
};

function setStatus(id: string, status: SessionMeta["status"]): void {
  const session = findSession(id);
  session.status = status;
  watch.sessionChanged({ ...session });
}

function completeTurn(id: string, resultText: string, outcome: SubagentResult["outcome"] = "done"): void {
  const turnId = lastTurns.get(id) ?? "t";
  watch.turnSettled(id, {
    type: "turn.done",
    turnId,
    sessionId: id,
    resumeCursor: "",
    resultText,
    usage: [],
    numTurns: 1,
    isError: false,
    backgroundTasks: 0
  });
  const session = findSession(id);
  if (session.subagent) session.subagent = { ...session.subagent, result: { turnId, outcome, text: resultText, at: 3 }, delivered: false };
  setStatus(id, "idle");
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error("condition not met");
}

const noop = (): void => {};

function buildRouter(): Router {
  const built = new Router();
  const turns = {
    start: async (sessionId: string, prompt: string, input: StartTurnInput) => {
      if (failNextStart) {
        failNextStart = false;
        throw new Error(`${findSession(sessionId).driver} is updating`);
      }
      setStatus(sessionId, "working");
      started.push({ sessionId, prompt, input });
      turnModes.set(sessionId, input.prefs?.permissionMode ?? fakeSessions.getComposer(sessionId).permissionMode ?? "auto");
      const turnId = `turn-${started.length}`;
      lastTurns.set(sessionId, turnId);
      return turnId;
    },
    stop: () => ({ stopped: true })
  };
  const services = {
    sessions: fakeSessions,
    turns,
    appTopic: {
      setSettings: noop,
      get harnesses() {
        return { installed, checks: harnessChecks };
      }
    },
    prStore: { onSettingsChanged: noop },
    autoFollowUp: { reevaluate: noop },
    sidebar: { invalidate: noop },
    githubViews: { onSettingsChanged: noop },
    accountUsage: { invalidate: noop },
    harnessMonitor: { check: async () => {} }
  };
  const app = {
    requireServices: () => services,
    emit: (channel: string, payload?: unknown) => emitted.push({ channel, payload })
  } as unknown as ServerApp;
  registerSessionHandlers(built, app);
  registerTurnHandlers(built, app);
  registerSubagentHandlers(built, app);
  registerSettingsHandlers(built, app);
  built.handle("usage.report", (query) => ({ query }));
  return built;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${callerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function callRoute(req: Request): Promise<Response> {
  return route(req, (seconds) => extended.push(seconds));
}

async function readRpc(response: Response): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .at(-1);
  if (data === undefined) throw new Error(`no SSE data in ${text}`);
  return JSON.parse(data);
}

async function modernClient(seen: Response[], token = callerToken): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const response = await callRoute(new Request(url, init));
      seen.push(response);
      return response;
    }
  });
  await client.connect(transport);
  return client;
}

function toolText(result: { content?: unknown }): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first.text;
}

function agent(sessionId: string): CallContext {
  return { clientId: `mcp:${sessionId}`, client: "mcp", auth: { kind: "agent", sessionId } };
}

beforeEach(() => {
  tokens = new AgentTokens();
  callerToken = tokens.tokenFor("caller");
  sessions = [meta("caller", "working", "manual"), meta("target", "idle", "bypassPermissions"), meta("old", "resolved", "auto")];
  started = [];
  turnModes = new Map();
  emitted = [];
  settings = { claudeDefaultModel: "opus" };
  lastTurns = new Map();
  pendingCounts = new Map();
  delivered = [];
  installed = ["claude", "codex", "opencode"];
  harnessChecks = [];
  failingHarnesses = new Set();
  failNextStart = false;
  resolvedSessions = [];
  extended = [];
  router = buildRouter();
  watch = new SessionWatch({ getSession: (id) => sessions.find((session) => session.id === id) });
  route = createMcpRoute({ router, tokens, watch, sessions: fakeSessions, version: "9.9.9" });
});

describe("mcp route gate", () => {
  test("rejects a request without a bearer token and keeps the default idle timeout", async () => {
    const response = await callRoute(new Request(URL_MCP, { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(extended).toEqual([]);
  });

  test("rejects an unknown bearer token", async () => {
    const response = await callRoute(post({}, { Authorization: "Bearer not-a-token" }));
    expect(response.status).toBe(401);
    expect(extended).toEqual([]);
  });

  test("rejects a revoked token", async () => {
    tokens.revoke("caller");
    expect((await callRoute(post({}))).status).toBe(401);
  });

  test("rejects any Origin header", async () => {
    const response = await callRoute(post({}, { Origin: "http://evil.example" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(extended).toEqual([]);
  });

  test("answers GET with 405", async () => {
    const response = await callRoute(new Request(URL_MCP, { headers: { Authorization: `Bearer ${callerToken}`, Accept: "text/event-stream" } }));
    expect(response.status).toBe(405);
  });

  test("extends the idle timeout to a finite value beyond the longest wait once the bearer verifies", async () => {
    await callRoute(post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "MCP-Protocol-Version": "2025-11-25" }));
    expect(extended).toEqual([MCP_IDLE_TIMEOUT_SECONDS]);
    expect(MCP_IDLE_TIMEOUT_SECONDS).toBe(255);
    expect(WAIT_MAX_MS / 1000).toBeLessThan(MCP_IDLE_TIMEOUT_SECONDS);
  });
});

describe("mcp modern era", () => {
  let client: Client;
  let seen: Response[];
  const others: Client[] = [];

  beforeEach(async () => {
    seen = [];
    client = await modernClient(seen);
  });

  afterEach(async () => {
    await client.close();
    await Promise.all(others.splice(0).map((other) => other.close()));
  });

  async function clientFor(sessionId: string): Promise<Client> {
    const other = await modernClient([], tokens.tokenFor(sessionId));
    others.push(other);
    return other;
  }

  test("discovers the server and lists the cw tools without a session id", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME, version: "9.9.9" });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(seen.length).toBeGreaterThan(0);
    for (const response of seen) expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  test("lists active sessions and hides resolved ones by default", async () => {
    const result = await client.callTool({ name: "sessions_list", arguments: {} });
    expect(JSON.parse(toolText(result)).map((row: { id: string }) => row.id)).toEqual(["caller", "target"]);
    const all = await client.callTool({ name: "sessions_list", arguments: { includeResolved: true } });
    expect(JSON.parse(toolText(all))).toHaveLength(3);
  });

  test("refuses to stop the caller's own session", async () => {
    const result = await client.callTool({ name: "session_stop", arguments: { sessionId: "caller" } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("own session");
  });

  test("refuses to send a prompt to the caller's own session", async () => {
    const result = await client.callTool({ name: "session_send", arguments: { sessionId: "caller", prompt: "hi" } });
    expect(result.isError).toBe(true);
    expect(started).toHaveLength(0);
  });

  test("refuses to wait on the caller's own session", async () => {
    const result = await client.callTool({ name: "session_wait", arguments: { sessionId: "caller" } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toBe("an agent cannot wait on its own session");
  });

  test("reports an unknown session as an error result", async () => {
    const result = await client.callTool({ name: "session_get", arguments: { sessionId: "missing" } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toBe("unknown session missing");
  });

  test("reports the effective permission mode of a session with no stored mode", async () => {
    sessions.push(meta("plain", "idle"));
    const result = await client.callTool({ name: "session_get", arguments: { sessionId: "plain" } });
    expect(JSON.parse(toolText(result))).toMatchObject({ id: "plain", permissionMode: "auto" });
  });

  test("caps a requested bypassPermissions at the caller's manual mode", async () => {
    const result = await client.callTool({
      name: "session_create",
      arguments: { projectId: "p1", driver: "claude", prompt: "do it", permissionMode: "bypassPermissions" }
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(toolText(result))).toEqual({ sessionId: "s4", turnId: "turn-1", permissionMode: "manual" });
    expect(started[0]).toMatchObject({ sessionId: "s4", prompt: "do it" });
    expect(started[0]?.input.prefs?.permissionMode).toBe("manual");
  });

  test("persists the caller cap as the stored mode of a session it creates", async () => {
    sessions.push(meta("editor", "working", "acceptEdits"));
    const editor = await clientFor("editor");
    const result = await editor.callTool({ name: "session_create", arguments: { projectId: "p1", driver: "codex", prompt: "go" } });
    const { sessionId, permissionMode } = JSON.parse(toolText(result)) as { sessionId: string; permissionMode: PermissionMode };
    expect(permissionMode).toBe("acceptEdits");
    expect(findSession(sessionId).permissionMode).toBe("acceptEdits");
    expect(fakeSessions.getComposer(sessionId).permissionMode).toBe("acceptEdits");
    expect(emitted).toContainEqual({ channel: "composer.changed", payload: { sessionId, prefs: { permissionMode: "acceptEdits" } } });

    const child = await clientFor(sessionId);
    const grandchild = await child.callTool({
      name: "session_create",
      arguments: { projectId: "p1", driver: "claude", prompt: "deeper", permissionMode: "bypassPermissions" }
    });
    expect(JSON.parse(toolText(grandchild))).toMatchObject({ permissionMode: "acceptEdits" });
    expect(started.at(-1)?.input.prefs?.permissionMode).toBe("acceptEdits");
  });

  test("caps the target session's stored mode when none is requested", async () => {
    await client.callTool({ name: "session_send", arguments: { sessionId: "target", prompt: "next" } });
    expect(started[0]?.input.prefs?.permissionMode).toBe("manual");
  });

  test("caps a session's own children at the mode its running turn was started with", async () => {
    await client.callTool({ name: "session_send", arguments: { sessionId: "target", prompt: "next" } });
    expect(turnModes.get("target")).toBe("manual");
    const target = await clientFor("target");
    const result = await target.callTool({
      name: "session_create",
      arguments: { projectId: "p1", driver: "claude", prompt: "escalate", permissionMode: "bypassPermissions" }
    });
    expect(JSON.parse(toolText(result))).toMatchObject({ permissionMode: "manual" });
    expect(started.at(-1)?.input.prefs?.permissionMode).toBe("manual");
    const created = (JSON.parse(toolText(result)) as { sessionId: string }).sessionId;
    expect(findSession(created).permissionMode).toBe("manual");
  });

  test("rejects session_create with an unsafe model before creating anything", async () => {
    const result = await client.callTool({ name: "session_create", arguments: { projectId: "p1", driver: "claude", prompt: "go", model: "opus&whoami" } });
    expect(result.isError).toBe(true);
    expect(sessions).toHaveLength(3);
    expect(started).toHaveLength(0);
  });

  test("returns at once when waiting on a session that is not working", async () => {
    const result = await client.callTool({ name: "session_wait", arguments: { sessionId: "target" } });
    expect(JSON.parse(toolText(result))).toEqual({ status: "idle", lastResultText: null, timedOut: false });
  });

  test("waits on a sent turn while it works and resolves when it completes", async () => {
    await client.callTool({ name: "session_send", arguments: { sessionId: "target", prompt: "next" } });
    expect(findSession("target").status).toBe("working");
    const waiting = client.callTool({ name: "session_wait", arguments: { sessionId: "target", timeoutMs: 5_000 } });
    const pending = Symbol("pending");
    expect(await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve(pending), 50))])).toBe(pending);
    completeTurn("target", "finished");
    expect(JSON.parse(toolText(await waiting))).toEqual({ status: "idle", lastResultText: "finished", timedOut: false });
  });

  test("times out waiting on a session that keeps working", async () => {
    sessions.push(meta("busy", "working", "auto"));
    const result = await client.callTool({ name: "session_wait", arguments: { sessionId: "busy", timeoutMs: 1 } });
    expect(JSON.parse(toolText(result))).toEqual({ status: "working", lastResultText: null, timedOut: true });
  });

  test("reports a forbidden settings key as an error result", async () => {
    const result = await client.callTool({ name: "settings_set", arguments: { patch: { claudeBinaryPath: "/tmp/evil" } } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("claudeBinaryPath");
    expect(settings).not.toHaveProperty("claudeBinaryPath");
  });

  test("applies an allowlisted settings key", async () => {
    const result = await client.callTool({ name: "settings_set", arguments: { patch: { claudeDefaultModel: "sonnet" } } });
    expect(result.isError).toBeUndefined();
    expect(settings.claudeDefaultModel).toBe("sonnet");
  });

  test("subagent_run waits for the result, caps the permission mode and marks the result delivered", async () => {
    const running = client.callTool({
      name: "subagent_run",
      arguments: { driver: "codex", task: "review the diff\nthen report", permissionMode: "bypassPermissions", timeoutMs: 5_000 }
    });
    await until(() => started.length === 1);
    expect(started[0]).toMatchObject({ sessionId: "s4", prompt: "review the diff\nthen report" });
    expect(started[0]?.input.prefs?.permissionMode).toBe("manual");
    expect(findSession("s4")).toMatchObject({ title: "review the diff", permissionMode: "manual", subagent: { parentSessionId: "caller" } });
    completeTurn("s4", "looks good");
    expect(JSON.parse(toolText(await running))).toEqual({
      subagentId: "s4",
      status: "idle",
      outcome: "done",
      resultText: "looks good",
      timedOut: false,
      next: null
    });
    expect(delivered).toEqual([["s4", "turn-1"]]);
    expect(findSession("s4").subagent?.delivered).toBe(true);
  });

  test("subagent_run with wait false returns at once with the running hint", async () => {
    const result = await client.callTool({ name: "subagent_run", arguments: { driver: "claude", task: "long job", title: "Long job", wait: false } });
    expect(JSON.parse(toolText(result))).toEqual({
      subagentId: "s4",
      status: "working",
      outcome: null,
      resultText: null,
      timedOut: false,
      next: SUBAGENT_RUNNING_NEXT
    });
    expect(findSession("s4").title).toBe("Long job");
    expect(delivered).toEqual([]);
  });

  test("a pending approval ends the wait without marking the result delivered", async () => {
    const running = client.callTool({ name: "subagent_run", arguments: { driver: "codex", task: "edit files", timeoutMs: 5_000 } });
    await until(() => started.length === 1);
    pendingCounts.set("s4", 1);
    setStatus("s4", "input-required");
    expect(JSON.parse(toolText(await running))).toEqual({
      subagentId: "s4",
      status: "input-required",
      outcome: null,
      resultText: null,
      timedOut: false,
      next: SUBAGENT_INPUT_NEXT
    });
    expect(delivered).toEqual([]);
  });

  test("subagent_wait returns a settled result of the caller's own subagent", async () => {
    child("kid", "caller", "working");
    lastTurns.set("kid", "turn-9");
    const waiting = client.callTool({ name: "subagent_wait", arguments: { subagentId: "kid", timeoutMs: 5_000 } });
    const pending = Symbol("pending");
    expect(await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve(pending), 50))])).toBe(pending);
    completeTurn("kid", "done it");
    expect(JSON.parse(toolText(await waiting))).toEqual({ status: "idle", outcome: "done", resultText: "done it", timedOut: false, next: null });
    expect(delivered).toEqual([["kid", "turn-9"]]);
  });

  test("subagent_wait and subagent_send report an error or interrupted outcome", async () => {
    child("kid", "caller", "working");
    lastTurns.set("kid", "turn-9");
    const waiting = client.callTool({ name: "subagent_wait", arguments: { subagentId: "kid", timeoutMs: 5_000 } });
    completeTurn("kid", "boom", "error");
    expect(JSON.parse(toolText(await waiting))).toMatchObject({ status: "idle", outcome: "error", resultText: "boom" });

    const sending = client.callTool({ name: "subagent_send", arguments: { subagentId: "kid", prompt: "again", timeoutMs: 5_000 } });
    await until(() => started.length === 1);
    completeTurn("kid", "", "interrupted");
    expect(JSON.parse(toolText(await sending))).toMatchObject({ subagentId: "kid", status: "idle", outcome: "interrupted" });
  });

  test("subagent tools answer the same way for another session's subagent and an unknown id", async () => {
    child("theirs", "target", "working");
    for (const subagentId of ["theirs", "missing"]) {
      for (const [name, args] of [
        ["subagent_wait", { subagentId }],
        ["subagent_send", { subagentId, prompt: "hi" }],
        ["subagent_stop", { subagentId }]
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(toolText(result)).toBe(`unknown subagent ${subagentId}`);
      }
    }
    expect(started).toHaveLength(0);
    expect(JSON.parse(toolText(await client.callTool({ name: "subagents_list", arguments: {} })))).toEqual([]);
  });

  test("subagent_send caps the subagent's stored mode at the caller's", async () => {
    child("kid", "caller", "idle", "bypassPermissions");
    const result = await client.callTool({ name: "subagent_send", arguments: { subagentId: "kid", prompt: "again", wait: false } });
    expect(JSON.parse(toolText(result))).toMatchObject({ subagentId: "kid", status: "working", next: SUBAGENT_RUNNING_NEXT });
    expect(started[0]).toMatchObject({ sessionId: "kid", prompt: "again" });
    expect(started[0]?.input.prefs?.permissionMode).toBe("manual");
  });

  test("subagents_list summarizes the caller's subagents with their pending requests", async () => {
    child("kid", "caller", "input-required");
    child("other", "target");
    pendingCounts.set("kid", 2);
    const result = await client.callTool({ name: "subagents_list", arguments: {} });
    expect(JSON.parse(toolText(result))).toEqual([
      { id: "kid", driver: "codex", title: "kid", status: "input-required", isolation: "shared", pendingRequests: 2, createdAt: 1, updatedAt: 2 }
    ]);
  });

  test("a subagent caller gets only the read and settings tools", async () => {
    child("kid", "caller", "working", "auto");
    const kid = await clientFor("kid");
    const { tools } = await kid.listTools();
    const dispatching = new Set(["session_create", "session_send", "session_stop"]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(SESSION_TOOL_NAMES.filter((name) => !dispatching.has(name)).sort());
  });

  test("session tools hide another session's subagents as unknown sessions", async () => {
    child("kid", "target", "working");
    const listed = await client.callTool({ name: "sessions_list", arguments: { includeResolved: true } });
    expect(JSON.parse(toolText(listed)).map((row: { id: string }) => row.id)).toEqual(["caller", "target", "old"]);
    for (const [name, args] of [
      ["session_get", { sessionId: "kid" }],
      ["session_send", { sessionId: "kid", prompt: "p" }],
      ["session_stop", { sessionId: "kid" }],
      ["session_wait", { sessionId: "kid" }]
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toBe("unknown session kid");
    }
    expect(started).toHaveLength(0);
  });

  test("session tools point the parent at the subagent tools for its own subagent", async () => {
    child("kid", "caller", "working");
    for (const [name, args] of [
      ["session_send", { sessionId: "kid", prompt: "p" }],
      ["session_stop", { sessionId: "kid" }],
      ["session_wait", { sessionId: "kid" }]
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("subagent_send");
    }
    expect(toolText(await client.callTool({ name: "session_get", arguments: { sessionId: "kid" } }))).toBe("unknown session kid");
    expect(started).toHaveLength(0);
  });

  test("does not mark a result delivered once the caller's turn has ended", async () => {
    const running = client.callTool({ name: "subagent_run", arguments: { driver: "codex", task: "review", timeoutMs: 5_000 } });
    await until(() => started.length === 1);
    setStatus("caller", "holding");
    completeTurn("s4", "too late");
    expect(JSON.parse(toolText(await running))).toMatchObject({ status: "idle", resultText: "too late" });
    expect(delivered).toEqual([]);
    expect(findSession("s4").subagent?.delivered).toBe(false);
  });

  test("subagent_targets finds provider-prefixed opencode ids that contain a harness name", async () => {
    Object.assign(settings, { codexDefaultModel: "", opencodeDefaultModel: "" });
    for (const [query, id] of [
      ["anthropic/claude-opus-4-5", "anthropic/claude-opus-4-5"],
      ["openai/gpt-5-codex", "openai/gpt-5-codex"]
    ] as const) {
      const targets = JSON.parse(toolText(await client.callTool({ name: "subagent_targets", arguments: { query } }))) as SubagentTarget[];
      expect(targets.map((target) => target.driver)).toEqual(["claude", "opencode", "codex"]);
      expect(targets.find((target) => target.driver === "opencode")?.models.map((model) => model.id)).toEqual([id]);
    }
  });

  test("subagent_targets searches every harness when the named harness has no match", async () => {
    Object.assign(settings, { codexDefaultModel: "", opencodeDefaultModel: "" });
    const targets = JSON.parse(toolText(await client.callTool({ name: "subagent_targets", arguments: { query: "codex anthropic opus" } }))) as SubagentTarget[];
    expect(targets.map((target) => [target.driver, target.models.map((model) => model.id)])).toEqual([
      ["claude", []],
      ["opencode", ["anthropic/claude-opus-4-5"]],
      ["codex", []]
    ]);
  });

  test("subagent_targets ranks a plain-text model and reports a failing harness in its entry", async () => {
    Object.assign(settings, { codexDefaultModel: "gpt-5-codex", opencodeDefaultModel: " " });
    failingHarnesses.add("opencode");
    installed = ["claude", "opencode"];
    const result = await client.callTool({ name: "subagent_targets", arguments: { query: "opus 4.5 high" } });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(toolText(result)) as SubagentTarget[]).toEqual([
      { driver: "claude", installed: true, defaultModel: "opus", effort: "high", models: [{ id: "claude-opus-4-5", label: "Opus 4.5" }] },
      { driver: "opencode", installed: true, defaultModel: null, effort: "high", models: [], error: "opencode model list failed" },
      {
        driver: "codex",
        installed: false,
        defaultModel: "gpt-5-codex",
        effort: "high",
        models: [],
        error: "codex is not installed. Install it or set its executable in Settings, then recheck the harnesses."
      }
    ]);
  });

  test("subagent_targets explains why a harness cannot run instead of listing no models", async () => {
    Object.assign(settings, { codexDefaultModel: "", opencodeDefaultModel: "" });
    installed = ["claude", "codex"];
    harnessChecks = [
      harnessCheck("opencode", { found: false, available: false, skipped: true, error: 'Executable not found in $PATH: "opencode.exe"' }),
      harnessCheck("codex", { binaryPath: "C:/tools/codex.exe", configured: true, available: false, error: "spawn EACCES" })
    ];
    const opencode = JSON.parse(
      toolText(await client.callTool({ name: "subagent_targets", arguments: { query: "deepseek v4.1 flash max", driver: "opencode" } }))
    ) as SubagentTarget[];
    expect(opencode).toEqual([
      {
        driver: "opencode",
        installed: false,
        defaultModel: null,
        effort: "max",
        models: [],
        error: `opencode: 'opencode' was not found (Executable not found in $PATH: "opencode.exe"). Install it or set its executable in Settings, then recheck the harnesses.`
      }
    ]);

    const all = JSON.parse(toolText(await client.callTool({ name: "subagent_targets", arguments: {} }))) as SubagentTarget[];
    expect(all.find((target) => target.driver === "codex")).toMatchObject({
      installed: true,
      models: [],
      error: "codex: could not run 'C:/tools/codex.exe' (spawn EACCES). Change its executable in Settings."
    });
    expect(all.find((target) => target.driver === "claude")?.models.length).toBeGreaterThan(0);
  });

  test("subagent_targets reports a query that matches no model of an available harness", async () => {
    Object.assign(settings, { codexDefaultModel: "" });
    const targets = JSON.parse(toolText(await client.callTool({ name: "subagent_targets", arguments: { driver: "codex", query: "kimi" } }))) as SubagentTarget[];
    expect(targets).toEqual([{ driver: "codex", installed: true, defaultModel: null, models: [], error: "no codex model matches 'kimi'" }]);
  });

  test("subagent_targets narrows to the harness named in the query and lists opencode efforts", async () => {
    Object.assign(settings, { codexDefaultModel: "", opencodeDefaultModel: "anthropic/claude-opus-4-5" });
    const result = await client.callTool({ name: "subagent_targets", arguments: { query: "opencode opus" } });
    expect(JSON.parse(toolText(result))).toEqual([
      {
        driver: "opencode",
        installed: true,
        defaultModel: "anthropic/claude-opus-4-5",
        models: [{ id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", variants: ["high", "max"], efforts: ["high", "max"] }]
      }
    ]);
  });
});

describe("subagent router methods", () => {
  const owner: CallContext = { clientId: "ui", client: "desktop-ui", auth: { kind: "owner" } };
  const device: CallContext = { clientId: "web", client: "web", auth: { kind: "device", deviceId: "d1" } };

  test("owner and device clients stop any subagent but not a plain session", async () => {
    child("kid", "target", "working");
    expect(await router.dispatch("subagents.stop", { subagentId: "kid" }, owner)).toEqual({ stopped: true });
    expect(await router.dispatch("subagents.stop", { subagentId: "kid" }, device)).toEqual({ stopped: true });
    await expect(router.dispatch("subagents.stop", { subagentId: "target" }, owner)).rejects.toThrow("unknown subagent target");
  });

  test("an agent stops only its own subagents", async () => {
    child("kid", "target", "working");
    await expect(router.dispatch("subagents.stop", { subagentId: "kid" }, agent("caller"))).rejects.toThrow("unknown subagent kid");
    expect(await router.dispatch("subagents.stop", { subagentId: "kid" }, agent("target"))).toEqual({ stopped: true });
  });

  test("create, send and targets are agent-only", async () => {
    for (const method of ["subagents.create", "subagents.send", "subagents.targets"]) {
      await expect(router.dispatch(method, {}, owner)).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  test("owner clients list the subagents of a named parent", async () => {
    child("kid", "target");
    const listed = (await router.dispatch("subagents.list", { parentSessionId: "target" }, owner)) as Array<{ id: string }>;
    expect(listed.map((summary) => summary.id)).toEqual(["kid"]);
  });

  test("rejects an unsafe model before creating anything", async () => {
    const start = router.dispatch("subagents.create", { driver: "claude", task: "go", model: "opus&whoami" }, agent("caller"));
    await expect(start).rejects.toMatchObject({ code: "forbidden" });
    expect(sessions).toHaveLength(3);
  });

  test("refuses a subagent on a harness that cannot run before creating anything", async () => {
    harnessChecks = [harnessCheck("opencode", { found: false, available: false, skipped: true, error: "not found" })];
    installed = ["claude", "codex"];
    const start = router.dispatch("subagents.create", { driver: "opencode", task: "go" }, agent("caller"));
    await expect(start).rejects.toThrow("opencode: 'opencode' was not found (not found). Install it or set its executable in Settings");
    expect(sessions).toHaveLength(3);
    expect(started).toHaveLength(0);
  });

  test("refuses a follow-up to a subagent whose harness stopped running", async () => {
    child("kid", "caller");
    harnessChecks = [harnessCheck("codex", { configured: true, available: false, error: null })];
    const send = router.dispatch("subagents.send", { subagentId: "kid", prompt: "again" }, agent("caller"));
    await expect(send).rejects.toThrow("codex: could not run 'codex'. Change its executable in Settings.");
    expect(started).toHaveLength(0);
  });

  test("archives a created subagent whose first turn did not start and reports it", async () => {
    failNextStart = true;
    const start = router.dispatch("subagents.create", { driver: "codex", task: "go", isolation: "worktree" }, agent("caller"));
    await expect(start).rejects.toThrow("subagent s4 was created but its first turn did not start: codex is updating");
    expect(resolvedSessions).toEqual([["s4", "archived", { removeWorktree: true }]]);
  });

  test("caps an explicit title like a derived one", async () => {
    const title = `  Review   the\n${"x".repeat(80)}  `;
    await router.dispatch("subagents.create", { driver: "codex", task: "go", title }, agent("caller"));
    const stored = findSession("s4").title;
    expect(stored).toHaveLength(60);
    expect(stored.startsWith("Review the xxx")).toBe(true);
    expect(stored.endsWith("…")).toBe(true);
  });

  test("subagents.ack marks a result delivered only while the caller is in a turn", async () => {
    child("kid", "caller");
    findSession("kid").subagent = { parentSessionId: "caller", isolation: "shared", result: { turnId: "turn-7", outcome: "done", text: "ok", at: 1 } };
    expect(await router.dispatch("subagents.ack", { subagentId: "kid", turnId: "turn-6" }, agent("caller"))).toEqual({ delivered: false });
    setStatus("caller", "idle");
    expect(await router.dispatch("subagents.ack", { subagentId: "kid", turnId: "turn-7" }, agent("caller"))).toEqual({ delivered: false });
    setStatus("caller", "working");
    expect(await router.dispatch("subagents.ack", { subagentId: "kid", turnId: "turn-7" }, agent("caller"))).toEqual({ delivered: true });
    expect(delivered).toEqual([["kid", "turn-7"]]);
    await expect(router.dispatch("subagents.ack", { subagentId: "kid", turnId: "turn-7" }, agent("target"))).rejects.toThrow("unknown subagent kid");
  });

  test.each([
    ["sessions.create", { projectId: "p1", driver: "claude" }],
    ["turns.start", { sessionId: "caller", prompt: "p" }],
    ["turns.start", { sessionId: "target", prompt: "p" }],
    ["turns.stop", { sessionId: "caller" }],
    ["subagents.create", { driver: "claude", task: "deeper" }],
    ["subagents.send", { subagentId: "kid", prompt: "p" }],
    ["subagents.stop", { subagentId: "kid" }],
    ["subagents.ack", { subagentId: "kid", turnId: "t" }],
    ["subagents.targets", {}]
  ] as const)("refuses %s from a subagent caller", async (method, params) => {
    child("kid", "caller", "working", "auto");
    await expect(router.dispatch(method, params, agent("kid"))).rejects.toMatchObject({ code: "forbidden", message: SUBAGENT_DEPTH_REFUSAL });
    expect(sessions).toHaveLength(4);
    expect(started).toHaveLength(0);
  });

  test("lets a subagent caller use the read-only methods", async () => {
    child("kid", "caller", "working", "auto");
    expect(await router.dispatch("projects.list", undefined, agent("kid"))).toEqual(PROJECTS);
    expect(await router.dispatch("subagents.list", undefined, agent("kid"))).toEqual([]);
    expect(await router.dispatch("composer.get", { sessionId: "target" }, agent("kid"))).toMatchObject({ permissionMode: "bypassPermissions" });
  });
});

describe("cw tools abort", () => {
  type ToolCallback = (args: Record<string, unknown>, request: ServerContext) => Promise<CallToolResult>;

  function capturedTools(): Map<string, ToolCallback> {
    const tools = new Map<string, ToolCallback>();
    const server = { registerTool: (name: string, _spec: unknown, callback: ToolCallback) => tools.set(name, callback) } as unknown as McpServer;
    registerCwTools(server, { router, watch, sessions: fakeSessions, callerSessionId: "caller" });
    return tools;
  }

  test("does not mark a result delivered when the request was aborted", async () => {
    child("kid", "caller");
    findSession("kid").subagent = { parentSessionId: "caller", isolation: "shared", result: { turnId: "turn-3", outcome: "done", text: "ok", at: 1 }, delivered: false };
    const controller = new AbortController();
    controller.abort();
    const request = { mcpReq: { signal: controller.signal, notify: async () => {} } } as unknown as ServerContext;
    const wait = capturedTools().get("subagent_wait");
    if (!wait) throw new Error("subagent_wait is not registered");
    expect(JSON.parse(toolText(await wait({ subagentId: "kid" }, request)))).toMatchObject({ status: "idle", resultText: "ok" });
    expect(delivered).toEqual([]);

    const live = { mcpReq: { signal: new AbortController().signal, notify: async () => {} } } as unknown as ServerContext;
    await wait({ subagentId: "kid" }, live);
    expect(delivered).toEqual([["kid", "turn-3"]]);
  });
});

describe("agent call arguments", () => {
  test.each([
    ["command", { name: "review" }],
    ["attachments", ["/etc/passwd"]],
    ["acceptFolderHead", "main"],
    ["prRefs", [{ owner: "o", repo: "r", number: 1 }]]
  ])("turns.start rejects %s from an agent", async (field, value) => {
    await expect(router.dispatch("turns.start", { sessionId: "target", prompt: "p", [field]: value }, agent("caller"))).rejects.toMatchObject({
      code: "forbidden"
    });
    expect(started).toHaveLength(0);
  });

  test.each([["model"], ["variant"]])("turns.start rejects an unsafe prefs.%s from an agent", async (field) => {
    await expect(
      router.dispatch("turns.start", { sessionId: "target", prompt: "p", prefs: { [field]: "opus&whoami" } }, agent("caller"))
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(started).toHaveLength(0);
  });

  test("turns.start accepts a provider-qualified model id from an agent", async () => {
    await router.dispatch("turns.start", { sessionId: "target", prompt: "p", prefs: { model: "openai/gpt-5", variant: "high" } }, agent("caller"));
    expect(started[0]?.input.prefs).toMatchObject({ model: "openai/gpt-5", variant: "high" });
  });

  test("turns.start leaves owner model ids to the launcher", async () => {
    const owner: CallContext = { clientId: "ui", client: "desktop-ui", auth: { kind: "owner" } };
    await router.dispatch("turns.start", { sessionId: "target", prompt: "p", prefs: { model: "custom model" } }, owner);
    expect(started[0]?.input.prefs?.model).toBe("custom model");
  });

  test("settings.set rejects an unsafe default model from an agent", async () => {
    await expect(router.dispatch("settings.set", { codexDefaultModel: "gpt&calc" }, agent("caller"))).rejects.toMatchObject({ code: "forbidden" });
    expect(settings).not.toHaveProperty("codexDefaultModel");
  });

  test("sessions.create rejects options other than useWorktree from an agent", async () => {
    await expect(
      router.dispatch("sessions.create", { projectId: "p1", driver: "claude", options: { useWorktree: true, reuseWorktreePath: "/x" } }, agent("caller"))
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(sessions).toHaveLength(3);
  });

  test("sessions.create leaves the stored mode alone for the owner", async () => {
    const owner: CallContext = { clientId: "ui", client: "desktop-ui", auth: { kind: "owner" } };
    const created = (await router.dispatch("sessions.create", { projectId: "p1", driver: "claude", options: { baseBranch: "main" } }, owner)) as SessionMeta;
    expect(findSession(created.id).permissionMode).toBeUndefined();
    expect(emitted).toEqual([]);
  });
});

describe("cw tool definitions", () => {
  test("describe the same tools the server registers, with object input schemas", async () => {
    const definitions = cwToolDefinitions();
    expect(definitions.map((definition) => definition.name)).toEqual(TOOL_NAMES);
    const client = await modernClient([]);
    const { tools } = await client.listTools();
    await client.close();
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.inputSchema.type).toBe("object");
      expect(definition.inputSchema).not.toHaveProperty("$schema");
      expect(tools.find((tool) => tool.name === definition.name)?.description).toBe(definition.description);
    }
  });

  test("use only patterns that strict regex engines accept", () => {
    const patterns = JSON.stringify(cwToolDefinitions()).match(/"pattern":"(?:[^"\\]|\\.)*"/g) ?? [];
    expect(patterns.length).toBeGreaterThan(0);
    for (const entry of patterns) {
      const pattern = (JSON.parse(`{${entry}}`) as { pattern: string }).pattern;
      expect(() => new RegExp(pattern, "v")).not.toThrow();
    }
  });
});

describe("mcp opencode principal", () => {
  const SECRET = "opencode-secret";
  let inFlight: Map<string, string>;
  let resolved: Array<[string, string]>;

  beforeEach(() => {
    inFlight = new Map([["ses_oc", "caller"]]);
    resolved = [];
    route = createMcpRoute({
      router,
      tokens,
      watch,
      sessions: fakeSessions,
      version: "9.9.9",
      resolveOpencode: (secret, opencodeSessionId) => {
        resolved.push([secret, opencodeSessionId]);
        const sessionId = secret === SECRET ? inFlight.get(opencodeSessionId) : undefined;
        return sessionId ? { sessionId } : null;
      }
    });
  });

  function opencodeCall(name: string, args: Record<string, unknown>, secret: string, opencodeSession: string): Request {
    return post(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } },
      { Authorization: `Bearer ${secret}`, [OPENCODE_SESSION_HEADER]: opencodeSession, "MCP-Protocol-Version": "2025-11-25" }
    );
  }

  test("accepts the opencode secret for an in-flight session and acts as that cw-code session", async () => {
    const response = await callRoute(opencodeCall("session_stop", { sessionId: "caller" }, SECRET, "ses_oc"));
    expect(response.status).toBe(200);
    expect(extended).toEqual([MCP_IDLE_TIMEOUT_SECONDS]);
    const called = await readRpc(response);
    expect(called.result?.isError).toBe(true);
    expect((called.result?.content as Array<{ text: string }>)[0]?.text).toBe("an agent cannot stop its own session");
    expect(resolved).toEqual([[SECRET, "ses_oc"]]);
  });

  test("applies the caller's permission cap to sessions it creates", async () => {
    const response = await callRoute(
      opencodeCall("session_create", { projectId: "p1", driver: "claude", prompt: "go", permissionMode: "bypassPermissions" }, SECRET, "ses_oc")
    );
    const created = await readRpc(response);
    expect(JSON.parse((created.result?.content as Array<{ text: string }>)[0]?.text ?? "null")).toMatchObject({ permissionMode: "manual" });
  });

  test("keeps the static tool list for an opencode subagent and returns the depth refusal from the router", async () => {
    child("kid", "caller", "working", "auto");
    inFlight.set("ses_kid", "kid");
    const list = await readRpc(
      await callRoute(
        post(
          { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} },
          { Authorization: `Bearer ${SECRET}`, [OPENCODE_SESSION_HEADER]: "ses_kid", "MCP-Protocol-Version": "2025-11-25" }
        )
      )
    );
    expect((list.result?.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const [name, args] of [
      ["subagent_run", { driver: "claude", task: "deeper" }],
      ["subagent_send", { subagentId: "kid", prompt: "p" }],
      ["session_create", { projectId: "p1", driver: "claude", prompt: "go" }],
      ["session_send", { sessionId: "caller", prompt: "p" }],
      ["session_stop", { sessionId: "caller" }]
    ] as const) {
      const called = await readRpc(await callRoute(opencodeCall(name, args, SECRET, "ses_kid")));
      expect(called.result?.isError).toBe(true);
      expect((called.result?.content as Array<{ text: string }>)[0]?.text).toBe(SUBAGENT_DEPTH_REFUSAL);
    }
    expect(sessions).toHaveLength(4);
    expect(started).toHaveLength(0);
  });

  test.each([
    ["a wrong secret", "not-the-secret", "ses_oc"],
    ["an unknown opencode session", SECRET, "ses_other"],
    ["an empty opencode session", SECRET, ""]
  ])("rejects %s", async (_label, secret, opencodeSession) => {
    const response = await callRoute(opencodeCall("projects_list", {}, secret, opencodeSession));
    expect(response.status).toBe(401);
    expect(extended).toEqual([]);
  });

  test("rejects a session whose turn has finished", async () => {
    expect((await callRoute(opencodeCall("projects_list", {}, SECRET, "ses_oc"))).status).toBe(200);
    inFlight.delete("ses_oc");
    expect((await callRoute(opencodeCall("projects_list", {}, SECRET, "ses_oc"))).status).toBe(401);
  });

  test("does not accept an agent token with the opencode header", async () => {
    const response = await callRoute(opencodeCall("projects_list", {}, callerToken, "ses_oc"));
    expect(response.status).toBe(401);
    expect(resolved).toEqual([[callerToken, "ses_oc"]]);
  });

  test("never asks the opencode resolver about requests without the header", async () => {
    expect((await callRoute(post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { Authorization: `Bearer ${SECRET}` }))).status).toBe(401);
    expect((await callRoute(post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "MCP-Protocol-Version": "2025-11-25" }))).status).toBe(200);
    expect(resolved).toEqual([]);
  });

  test("rejects the header when no opencode resolver is wired", async () => {
    route = createMcpRoute({ router, tokens, watch, sessions: fakeSessions, version: "9.9.9" });
    expect((await callRoute(opencodeCall("projects_list", {}, SECRET, "ses_oc"))).status).toBe(401);
  });

  test("rejects any Origin before checking the opencode secret", async () => {
    const request = opencodeCall("projects_list", {}, SECRET, "ses_oc");
    request.headers.set("Origin", "http://evil.example");
    expect((await callRoute(request)).status).toBe(403);
    expect(resolved).toEqual([]);
  });
});

describe("mcp legacy era", () => {
  test("serves initialize and a following tools/list statelessly", async () => {
    const initialize = await callRoute(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1.0.0" } }
      })
    );
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    const initialized = await readRpc(initialize);
    expect(initialized.result?.serverInfo).toMatchObject({ name: MCP_SERVER_NAME, version: "9.9.9" });

    const list = await callRoute(post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "MCP-Protocol-Version": "2025-11-25" }));
    expect(list.status).toBe(200);
    expect(list.headers.get("mcp-session-id")).toBeNull();
    const listed = await readRpc(list);
    expect((listed.result?.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("serves a tools/call without a prior initialize", async () => {
    const response = await callRoute(
      post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "projects_list", arguments: {} } }, { "MCP-Protocol-Version": "2025-11-25" })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const called = await readRpc(response);
    const content = called.result?.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(PROJECTS);
  });
});
