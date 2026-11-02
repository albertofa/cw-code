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

export const PR_TOOLS = ["prs_list", "pr_link", "pr_unlink"] as const;

type CwTool = (typeof CW_TOOLS)[number] | (typeof PR_TOOLS)[number];

export interface CwSkill {
  name: string;
  description: string;
  markdown: string;
}

export const CW_SKILL_NAME = "cw-code";
export const PR_SKILL_NAME = "cw-code-prs";

export const SKILL_DESCRIPTION =
  "Use when the user asks to run work in parallel or in other cw-code sessions, delegate a task to another harness, check or monitor cw-code sessions, or look at usage or settings.";

export const PR_SKILL_DESCRIPTION =
  "Use right after you open a pull request, when you start working on another pull request in the same session, or to check which pull requests cw-code tracks for this session.";

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

function toolNamer(harness: AgentHarness): (tool: CwTool) => string {
  return (tool) => `\`${cwToolName(harness, tool)}\``;
}

function withFrontmatter(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
}

export function cwSkillMarkdown(harness: AgentHarness): string {
  const name = toolNamer(harness);
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
- Pull request links have their own skill, ${PR_SKILL_NAME}.

## Subagents

- Use ${name("subagent_run")} for work on another harness or in an isolated checkout (\`isolation: "worktree"\`). For work on your own harness, use its own subagent tool.
- When the user names a model in plain text, call ${name("subagent_targets")} with that text as \`query\` first and pass the returned id as \`model\`.
- For long tasks, dispatch with \`wait: false\` and end your turn; cw-code sends the results to you as a new turn. Never poll ${name("subagent_wait")} or ${name("subagents_list")} in a loop.
- A subagent cannot dispatch subagents of its own.
`;
  return withFrontmatter(CW_SKILL_NAME, SKILL_DESCRIPTION, body);
}

export function cwPrSkillMarkdown(harness: AgentHarness): string {
  const name = toolNamer(harness);
  const body = `# cw-code pull request links

cw-code tracks the pull requests linked to a session: it shows their checks, reviews and new comments in the session and can send them to you as follow-up turns. On its own it links only the PR whose head is the session's current branch, so a PR opened from another branch or repository, or before a branch switch, is missed unless you link it.

- Right after you open a pull request (\`gh pr create\` or any other way), call ${name("pr_link")} with its URL and \`opened: true\`. Do it for every PR you open in this session.
- When you start working on a pull request this session did not open (reviewing it, fixing its CI, pushing to its branch), call ${name("pr_link")} with \`opened: false\`.
- Call ${name("prs_list")} to see what cw-code tracks. An entry with \`linked: false\` is only the PR it sees on the current branch; link it if this session is working on it.
- If a pull request is linked to this session by mistake, call ${name("pr_unlink")}; cw-code then stops linking it from the branch.
- \`pr\` accepts a pull request URL, \`owner/repo#123\`, or a number in the GitHub repository of your checkout.
- In a subagent, the links go to the parent session.
`;
  return withFrontmatter(PR_SKILL_NAME, PR_SKILL_DESCRIPTION, body);
}

export function cwSkills(harness: AgentHarness): CwSkill[] {
  return [
    { name: CW_SKILL_NAME, description: SKILL_DESCRIPTION, markdown: cwSkillMarkdown(harness) },
    { name: PR_SKILL_NAME, description: PR_SKILL_DESCRIPTION, markdown: cwPrSkillMarkdown(harness) }
  ];
}
