import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ComposerPrefs, CreateSessionOptions, DriverKind, PermissionMode, Project, SessionMeta, SettingsPatch } from "@cw-code/contracts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AgentTokens } from "../agent/AgentTokens.js";
import { SessionWatch } from "../agent/SessionWatch.js";
import type { ServerApp } from "../app/ServerApp.js";
import { registerSessionHandlers } from "../handlers/sessions.js";
import { registerSettingsHandlers } from "../handlers/settings.js";
import { registerTurnHandlers } from "../handlers/turns.js";
import type { StartTurnInput } from "../threads/TurnService.js";
import { Router, type CallContext } from "../transport/Router.js";
import { WAIT_MAX_MS } from "./cwTools.js";
import { createMcpRoute, MCP_IDLE_TIMEOUT_SECONDS, MCP_SERVER_NAME } from "./mcpRoute.js";

const URL_MCP = "http://127.0.0.1:4100/mcp";
const TOOL_NAMES = [
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
const PROJECTS: Project[] = [{ id: "p1", rootPath: "/repo", name: "repo" }];

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

function findSession(id: string): SessionMeta {
  const session = sessions.find((candidate) => candidate.id === id);
  if (!session) throw new Error(`unknown session ${id}`);
  return session;
}

const fakeSessions = {
  listProjects: () => PROJECTS,
  listSessions: async (projectId: string) => sessions.filter((session) => session.projectId === projectId),
  createSession: async (projectId: string, driver: DriverKind, _options?: CreateSessionOptions) => {
    const created = { ...meta(`s${sessions.length + 1}`, "idle"), projectId, driver };
    sessions.push(created);
    return { ...created };
  },
  getComposer: (id: string): ComposerPrefs => ({ permissionMode: findSession(id).permissionMode ?? "auto" }),
  setComposer: (id: string, prefs: ComposerPrefs): ComposerPrefs => {
    findSession(id).permissionMode = prefs.permissionMode;
    return fakeSessions.getComposer(id);
  },
  turnPermissionMode: (id: string) => turnModes.get(id),
  hasSession: (id: string) => sessions.some((session) => session.id === id),
  getSettings: () => settings,
  setSettings: (patch: SettingsPatch) => Object.assign(settings, patch)
};

const noop = (): void => {};

function buildRouter(): Router {
  const built = new Router();
  const turns = {
    start: async (sessionId: string, prompt: string, input: StartTurnInput) => {
      started.push({ sessionId, prompt, input });
      turnModes.set(sessionId, input.prefs?.permissionMode ?? fakeSessions.getComposer(sessionId).permissionMode ?? "auto");
      return `turn-${started.length}`;
    },
    stop: () => ({ stopped: true })
  };
  const services = {
    sessions: fakeSessions,
    turns,
    appTopic: { setSettings: noop },
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
  extended = [];
  router = buildRouter();
  const watch = new SessionWatch({ getSession: (id) => sessions.find((session) => session.id === id) });
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
    expect(MCP_IDLE_TIMEOUT_SECONDS).toBe(Math.ceil(WAIT_MAX_MS / 1000) + 30);
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

  test("returns at once when waiting on a session that is not working", async () => {
    const result = await client.callTool({ name: "session_wait", arguments: { sessionId: "target" } });
    expect(JSON.parse(toolText(result))).toEqual({ status: "idle", lastResultText: null, timedOut: false });
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
