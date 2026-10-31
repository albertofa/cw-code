import type { TurnRequest } from "@cw-code/contracts";
import { agentTokenFingerprint, CW_AGENT_TOKEN_ENV } from "./claudePlugin.js";
import { MCP_IDLE_TIMEOUT_SECONDS } from "./mcpTimeouts.js";

const MCP_SERVER_NAME = "cw";

export type CodexAgent = NonNullable<TurnRequest["agent"]>;

export interface CodexMcpServerConfig {
  url: string;
  http_headers: { Authorization: string };
  default_tools_approval_mode: "approve";
  tool_timeout_sec: number;
}

export interface CodexThreadConfig {
  mcp_servers: Record<string, CodexMcpServerConfig>;
}

export function codexThreadConfig(agent: CodexAgent): CodexThreadConfig {
  return {
    mcp_servers: {
      [MCP_SERVER_NAME]: {
        url: agent.mcpUrl,
        http_headers: { Authorization: `Bearer ${agent.token}` },
        default_tools_approval_mode: "approve",
        tool_timeout_sec: MCP_IDLE_TIMEOUT_SECONDS
      }
    }
  };
}

export function codexAgentFingerprint(agent: CodexAgent | undefined): string {
  return agent ? agentTokenFingerprint({ [CW_AGENT_TOKEN_ENV]: agent.token }) : "";
}

export function codexTerminalMcpArgs(mcpUrl: string): string[] {
  const key = `mcp_servers.${MCP_SERVER_NAME}`;
  return [
    "-c",
    `${key}.url=${JSON.stringify(mcpUrl)}`,
    "-c",
    `${key}.bearer_token_env_var=${JSON.stringify(CW_AGENT_TOKEN_ENV)}`,
    "-c",
    `${key}.default_tools_approval_mode="approve"`,
    "-c",
    `${key}.tool_timeout_sec=${MCP_IDLE_TIMEOUT_SECONDS}`
  ];
}
