import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { OPENCODE_SESSION_HEADER } from "@cw-code/shared/protocol";
import type { AgentTokens } from "../agent/AgentTokens.js";
import type { SessionWatch } from "../agent/SessionWatch.js";
import { bearerToken, reply } from "../transport/httpRoutes.js";
import type { Router } from "../transport/Router.js";
import { registerCwTools, WAIT_MAX_MS, type CwToolsSessions } from "./cwTools.js";

export const MCP_SERVER_NAME = "cw";

export type ResolveOpencodeAgent = (secret: string, opencodeSessionId: string) => { sessionId: string } | null;

export interface McpRouteDeps {
  router: Router;
  tokens: AgentTokens;
  watch: SessionWatch;
  sessions: CwToolsSessions;
  version: string;
  resolveOpencode?: ResolveOpencodeAgent;
}

function callerSessionId(authInfo: AuthInfo | undefined): string {
  const sessionId = authInfo?.extra?.sessionId;
  if (typeof sessionId !== "string") throw new Error("MCP request has no verified agent session");
  return sessionId;
}

const BUN_MAX_IDLE_TIMEOUT_SECONDS = 255;
export const MCP_IDLE_TIMEOUT_SECONDS = Math.min(BUN_MAX_IDLE_TIMEOUT_SECONDS, Math.ceil(WAIT_MAX_MS / 1000) + 15);

function agentSessionOf(req: Request, token: string, deps: McpRouteDeps): string | null {
  const opencodeSessionId = req.headers.get(OPENCODE_SESSION_HEADER);
  if (opencodeSessionId === null) return deps.tokens.verify(token)?.sessionId ?? null;
  if (!opencodeSessionId || !deps.resolveOpencode) return null;
  return deps.resolveOpencode(token, opencodeSessionId)?.sessionId ?? null;
}

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
    const sessionId = token === null ? null : agentSessionOf(req, token, deps);
    if (token === null || sessionId === null) return reply("unauthorized", 401, { "WWW-Authenticate": "Bearer" });
    extendTimeout(MCP_IDLE_TIMEOUT_SECONDS);
    const authInfo: AuthInfo = { token, clientId: `mcp:${sessionId}`, scopes: [], extra: { sessionId } };
    return handler.fetch(req, { authInfo });
  };
}
