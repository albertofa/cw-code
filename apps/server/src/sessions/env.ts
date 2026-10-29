import { CW_AGENT_TOKEN_ENV, CW_MCP_URL_ENV } from "../agent/claudePlugin.js";

const NOT_INHERITED: ReadonlySet<string> = new Set([CW_AGENT_TOKEN_ENV, CW_MCP_URL_ENV]);

export function buildTurnEnv(
  processEnv: Record<string, string | undefined>,
  sessionVars: Record<string, string>,
  turnEnv?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string" && !NOT_INHERITED.has(key.toUpperCase())) out[key] = value;
  }
  for (const [key, value] of Object.entries(sessionVars)) {
    if (typeof value === "string") out[key] = value;
  }
  for (const [key, value] of Object.entries(turnEnv ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function githubAccountEnv(account: { host: string; login: string } | undefined, token: string | null): Record<string, string> {
  if (!account || !token) return {};
  const host = account.host.trim().toLowerCase();
  if (!host) return {};
  const tokenKey = host === "github.com" || host.endsWith(".ghe.com") ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN";
  return { GH_HOST: host, [tokenKey]: token };
}
