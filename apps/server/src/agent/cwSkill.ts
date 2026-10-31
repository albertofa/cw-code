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
  "settings_set",
  "subagent_run",
  "subagent_wait",
  "subagent_send",
  "subagent_stop",
  "subagents_list",
  "subagent_targets"
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
  const ownSession =
    harness === "claude"
      ? "Never prompt, stop or wait on your own session. Its id is in the environment variable CW_SESSION_ID."
      : "Never prompt, stop or wait on your own session; the tools refuse it.";
  const body = `# cw-code session tools

The tools are ${CW_TOOLS.map(name).join(", ")}.

- Delegate work with ${name("session_create")}, then call ${name("session_wait")} (repeat while it returns timedOut), then ${name("session_get")} for the result.
- ${ownSession}
- Child sessions never run with more permissions than this one.
- ${name("settings_set")} only accepts model, worktree, session lifecycle and refresh preferences.

## Subagents

- Use ${name("subagent_run")} for work on another harness or in an isolated checkout (\`isolation: "worktree"\`). For work on your own harness, use its own subagent tool.
- When the user names a model in plain text, call ${name("subagent_targets")} with that text as \`query\` first and pass the returned id as \`model\`.
- For long tasks, dispatch with \`wait: false\` and end your turn; cw-code sends the results to you as a new turn. Never poll ${name("subagent_wait")} or ${name("subagents_list")} in a loop.
- A subagent cannot dispatch subagents of its own.
`;
  return `---\nname: ${CW_SKILL_NAME}\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${body}`;
}
