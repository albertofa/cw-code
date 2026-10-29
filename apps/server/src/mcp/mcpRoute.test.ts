import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ComposerPrefs, PermissionMode, Project, SessionMeta } from "@cw-code/contracts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AgentTokens } from "../agent/AgentTokens.js";
import { SessionWatch } from "../agent/SessionWatch.js";
import type { ServerApp } from "../app/ServerApp.js";
import { registerTurnHandlers } from "../handlers/turns.js";
import type { StartTurnInput } from "../threads/TurnService.js";
import { Router } from "../transport/Router.js";
import { createMcpRoute, MCP_SERVER_NAME } from "./mcpRoute.js";

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

interface StartedTurn {
  sessionId: string;
  prompt: string;
  input: StartTurnInput;
}

function meta(id: string, status: SessionMeta["status"], permissionMode: PermissionMode): SessionMeta {
  return { id, projectId: "p1", driver: "claude", title: id, status, resumeCursor: "", createdAt: 1, updatedAt: 2, permissionMode };
}

let tokens: AgentTokens;
let callerToken: string;
let sessions: SessionMeta[];
let started: StartedTurn[];
let route: (req: Request) => Promise<Response>;

const fakeSessions = {
  getComposer: (id: string): ComposerPrefs => {
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) throw new Error(`unknown session ${id}`);
    return { permissionMode: session.permissionMode };
  },
  hasSession: (id: string) => sessions.some((session) => session.id === id)
};

function buildRouter(): Router {
  const router = new Router();
  const turns = {
    start: async (sessionId: string, prompt: string, input: StartTurnInput) => {
      started.push({ sessionId, prompt, input });
      return `turn-${started.length}`;
    },
    stop: () => ({ stopped: true })
  };
  const app = { requireServices: () => ({ sessions: fakeSessions, turns }) } as unknown as ServerApp;
  registerTurnHandlers(router, app);
  const projects: Project[] = [{ id: "p1", rootPath: "/repo", name: "repo" }];
  router.handle("projects.list", () => projects);
  router.handle("sessions.list", (projectId) => sessions.filter((session) => session.projectId === projectId));
  router.handle("sessions.create", (params) => {
    const created = meta(`s${sessions.length + 1}`, "idle", "auto");
    created.projectId = (params as { projectId: string }).projectId;
    sessions.push(created);
    return created;
  });
  router.handle("usage.report", (query) => ({ query }));
  router.handle("settings.get", () => ({ claudeDefaultModel: "opus" }));
  router.handle("settings.set", (patch) => patch);
  return router;
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

async function modernClient(seen: Response[]): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
    requestInit: { headers: { Authorization: `Bearer ${callerToken}` } },
    fetch: async (url, init) => {
      const response = await route(new Request(url, init));
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

beforeEach(() => {
  tokens = new AgentTokens();
  callerToken = tokens.tokenFor("caller");
  sessions = [meta("caller", "working", "manual"), meta("target", "idle", "bypassPermissions"), meta("old", "resolved", "auto")];
  started = [];
  const router = buildRouter();
  const watch = new SessionWatch({ getSession: (id) => sessions.find((session) => session.id === id) });
  route = createMcpRoute({ router, tokens, watch, sessions: fakeSessions, version: "9.9.9" });
});

describe("mcp route gate", () => {
  test("rejects a request without a bearer token", async () => {
    const response = await route(new Request(URL_MCP, { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("rejects an unknown bearer token", async () => {
    const response = await route(post({}, { Authorization: "Bearer not-a-token" }));
    expect(response.status).toBe(401);
  });

  test("rejects a revoked token", async () => {
    tokens.revoke("caller");
    expect((await route(post({}))).status).toBe(401);
  });

  test("rejects any Origin header", async () => {
    const response = await route(post({}, { Origin: "http://evil.example" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("answers GET with 405", async () => {
    const response = await route(new Request(URL_MCP, { headers: { Authorization: `Bearer ${callerToken}`, Accept: "text/event-stream" } }));
    expect(response.status).toBe(405);
  });
});

describe("mcp modern era", () => {
  let client: Client;
  let seen: Response[];

  beforeEach(async () => {
    seen = [];
    client = await modernClient(seen);
  });

  afterEach(async () => {
    await client.close();
  });

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

  test("reports an unknown session as an error result", async () => {
    const result = await client.callTool({ name: "session_get", arguments: { sessionId: "missing" } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toBe("unknown session missing");
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

  test("caps the target session's stored mode when none is requested", async () => {
    await client.callTool({ name: "session_send", arguments: { sessionId: "target", prompt: "next" } });
    expect(started[0]?.input.prefs?.permissionMode).toBe("manual");
  });

  test("returns at once when waiting on a session that is not working", async () => {
    const result = await client.callTool({ name: "session_wait", arguments: { sessionId: "target" } });
    expect(JSON.parse(toolText(result))).toEqual({ status: "idle", lastResultText: null, timedOut: false });
  });
});

describe("mcp legacy era", () => {
  test("serves initialize and a following tools/list statelessly", async () => {
    const initialize = await route(
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

    const list = await route(post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "MCP-Protocol-Version": "2025-11-25" }));
    expect(list.status).toBe(200);
    expect(list.headers.get("mcp-session-id")).toBeNull();
    const listed = await readRpc(list);
    expect((listed.result?.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });
});
