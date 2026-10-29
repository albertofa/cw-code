import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import type { AgentTokens } from "../agent/AgentTokens.js";
import type { SessionWatch } from "../agent/SessionWatch.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import { bearerToken, reply } from "../transport/httpRoutes.js";
import type { Router } from "../transport/Router.js";
import { registerCwTools, WAIT_MAX_MS } from "./cwTools.js";

export const MCP_SERVER_NAME = "cw";

export interface McpRouteDeps {
  router: Router;
  tokens: AgentTokens;
  watch: SessionWatch;
  sessions: Pick<SessionManager, "getComposer" | "turnPermissionMode">;
  version: string;
}

function callerSessionId(authInfo: AuthInfo | undefined): string {
  const sessionId = authInfo?.extra?.sessionId;
  if (typeof sessionId !== "string") throw new Error("MCP request has no verified agent session");
  return sessionId;
}

const BUN_MAX_IDLE_TIMEOUT_SECONDS = 255;
export const MCP_IDLE_TIMEOUT_SECONDS = Math.min(BUN_MAX_IDLE_TIMEOUT_SECONDS, Math.ceil(WAIT_MAX_MS / 1000) + 15);

export function createMcpRoute(deps: McpRouteDeps): (req: Request, extendTimeout: (seconds: number) => void) => Promise<Response> {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const server = new McpServer({ name: MCP_SERVER_NAME, version: deps.version });
      registerCwTools(server, { router: deps.router, watch: deps.watch, sessions: deps.sessions, callerSessionId: callerSessionId(authInfo) });
      return server;
    },
    { legacy: "stateless", onerror: (error) => console.warn(`[mcp] ${error.message}`) }
  );
  return async (req, extendTimeout) => {
    if (req.headers.get("origin") !== null) return reply("forbidden", 403);
    const token = bearerToken(req);
    const agent = token === null ? null : deps.tokens.verify(token);
    if (token === null || agent === null) return reply("unauthorized", 401, { "WWW-Authenticate": "Bearer" });
    extendTimeout(MCP_IDLE_TIMEOUT_SECONDS);
    const authInfo: AuthInfo = { token, clientId: `mcp:${agent.sessionId}`, scopes: [], extra: { sessionId: agent.sessionId } };
    return handler.fetch(req, { authInfo });
  };
}
