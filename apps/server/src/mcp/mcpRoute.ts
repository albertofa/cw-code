import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import type { AgentTokens } from "../agent/AgentTokens.js";
import type { SessionWatch } from "../agent/SessionWatch.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import { bearerToken, reply } from "../transport/httpRoutes.js";
import type { Router } from "../transport/Router.js";
import { registerCwTools } from "./cwTools.js";

export const MCP_SERVER_NAME = "cw";

export interface McpRouteDeps {
  router: Router;
  tokens: AgentTokens;
  watch: SessionWatch;
  sessions: Pick<SessionManager, "getComposer">;
  version: string;
}

function callerSessionId(authInfo: AuthInfo | undefined): string {
  const sessionId = authInfo?.extra?.sessionId;
  if (typeof sessionId !== "string") throw new Error("MCP request has no verified agent session");
  return sessionId;
}

export function createMcpRoute(deps: McpRouteDeps): (req: Request) => Promise<Response> {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const server = new McpServer({ name: MCP_SERVER_NAME, version: deps.version });
      registerCwTools(server, { router: deps.router, watch: deps.watch, sessions: deps.sessions, callerSessionId: callerSessionId(authInfo) });
      return server;
    },
    { legacy: "stateless", onerror: (error) => console.warn(`[mcp] ${error.message}`) }
  );
  return async (req) => {
    if (req.headers.get("origin") !== null) return reply("forbidden", 403);
    const token = bearerToken(req);
    const agent = token === null ? null : deps.tokens.verify(token);
    if (token === null || agent === null) return reply("unauthorized", 401, { "WWW-Authenticate": "Bearer" });
    const authInfo: AuthInfo = { token, clientId: `mcp:${agent.sessionId}`, scopes: [], extra: { sessionId: agent.sessionId } };
    return handler.fetch(req, { authInfo });
  };
}
