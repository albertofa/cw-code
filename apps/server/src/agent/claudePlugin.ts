import { createHash } from "node:crypto";
import { join } from "node:path";
import { cwSkillMarkdown } from "./cwSkill.js";
import { writeFileIfChanged } from "./writeFileIfChanged.js";

export const CLAUDE_PLUGIN_NAME = "cw-code";
export const CW_MCP_URL_ENV = "CW_MCP_URL";
export const CW_AGENT_TOKEN_ENV = "CW_AGENT_TOKEN";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function claudePluginFiles(version: string): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": json({ name: CLAUDE_PLUGIN_NAME, version, description: "cw-code session tools" }),
    ".mcp.json": json({
      mcpServers: {
        cw: {
          type: "http",
          url: `\${${CW_MCP_URL_ENV}}`,
          headers: { Authorization: `Bearer \${${CW_AGENT_TOKEN_ENV}}` }
        }
      }
    }),
    "skills/cw-code/SKILL.md": cwSkillMarkdown("claude")
  };
}

export async function writeClaudePlugin(dir: string, version: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(claudePluginFiles(version))) {
    await writeFileIfChanged(join(dir, ...relativePath.split("/")), content);
  }
}

export function claudePluginArgs(dir: string | null): string[] {
  return dir === null ? [] : ["--plugin-dir", dir];
}

export function agentTokenFingerprint(env: Record<string, string> | undefined): string {
  const token = env?.[CW_AGENT_TOKEN_ENV];
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "";
}
