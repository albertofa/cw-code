import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CLAUDE_PLUGIN_NAME = "cw-code";
export const CW_MCP_URL_ENV = "CW_MCP_URL";
export const CW_AGENT_TOKEN_ENV = "CW_AGENT_TOKEN";

const SKILL_DESCRIPTION =
  "Use when the user asks to run work in parallel or in other cw-code sessions, delegate a task to another harness, check or monitor cw-code sessions, or look at usage or settings.";

const SKILL_BODY = `# cw-code session tools

The tools are \`mcp__plugin_cw-code_cw__*\`: projects_list, sessions_list, session_get, session_create, session_send, session_stop, session_wait, usage_report, settings_get, settings_set.

- Delegate work with session_create, then call session_wait (repeat while it returns timedOut), then session_get for the result.
- Never prompt, stop or wait on your own session. Its id is in the environment variable CW_SESSION_ID.
- Child sessions never run with more permissions than this one.
- settings_set only accepts model, worktree, session lifecycle and refresh preferences.
`;

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
    "skills/cw-code/SKILL.md": `---\nname: cw-code\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${SKILL_BODY}`
  };
}

export async function writeClaudePlugin(dir: string, version: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(claudePluginFiles(version))) {
    const file = join(dir, ...relativePath.split("/"));
    await mkdir(dirname(file), { recursive: true });
    const existing = await readFile(file, "utf8").catch(() => undefined);
    if (existing !== content) await writeFile(file, content, "utf8");
  }
}

export function claudePluginArgs(dir: string | null): string[] {
  return dir === null ? [] : ["--plugin-dir", dir];
}

export function agentTokenFingerprint(env: Record<string, string> | undefined): string {
  const token = env?.[CW_AGENT_TOKEN_ENV];
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "";
}
