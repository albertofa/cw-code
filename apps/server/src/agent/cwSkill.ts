export type AgentHarness = "claude" | "codex" | "opencode";

const CW_TOOLS = [
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
] as const;

export const CW_SKILL_NAME = "cw-code";

export const SKILL_DESCRIPTION =
  "Use when the user asks to run work in parallel or in other cw-code sessions, delegate a task to another harness, check or monitor cw-code sessions, or look at usage or settings.";

export function cwToolName(harness: AgentHarness, tool: string): string {
  switch (harness) {
    case "claude":
      return `mcp__plugin_cw-code_cw__${tool}`;
    case "codex":
      return `mcp__cw__${tool}`;
    case "opencode":
      return `cw_${tool}`;
  }
}

export function cwSkillMarkdown(harness: AgentHarness): string {
  const name = (tool: (typeof CW_TOOLS)[number]): string => `\`${cwToolName(harness, tool)}\``;
  const body = `# cw-code session tools

The tools are ${CW_TOOLS.map(name).join(", ")}.

- Delegate work with ${name("session_create")}, then call ${name("session_wait")} (repeat while it returns timedOut), then ${name("session_get")} for the result.
- Never prompt, stop or wait on your own session. Its id is in the environment variable CW_SESSION_ID.
- Child sessions never run with more permissions than this one.
- ${name("settings_set")} only accepts model, worktree, session lifecycle and refresh preferences.
`;
  return `---\nname: ${CW_SKILL_NAME}\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${body}`;
}
