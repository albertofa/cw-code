import { describe, expect, it } from "bun:test";
import { SUBAGENT_TOOL_NAMES } from "@cw-code/shared/subagents";
import {
  cwPrSkillMarkdown,
  cwSkillMarkdown,
  cwSkills,
  cwToolName,
  PR_SKILL_DESCRIPTION,
  PR_SKILL_NAME,
  PR_TOOLS,
  SKILL_DESCRIPTION,
  type AgentHarness
} from "./cwSkill.js";

describe("cwToolName", () => {
  it("prefixes the tool the way each harness exposes MCP tools", () => {
    expect(cwToolName("claude", "session_create")).toBe("mcp__plugin_cw-code_cw__session_create");
    expect(cwToolName("codex", "session_create")).toBe("mcp__cw__session_create");
    expect(cwToolName("opencode", "session_create")).toBe("cw_session_create");
  });
});

describe("cwSkillMarkdown", () => {
  it.each(["claude", "codex", "opencode"] as AgentHarness[])("names the %s tools and keeps the cw-code frontmatter", (harness) => {
    const skill = cwSkillMarkdown(harness);
    expect(skill.startsWith("---\nname: cw-code\ndescription: ")).toBe(true);
    for (const tool of ["session_create", "session_wait", "session_get", "settings_set", "projects_list"]) {
      expect(skill).toContain(`\`${cwToolName(harness, tool)}\``);
    }
  });

  it.each(["claude", "codex", "opencode"] as AgentHarness[])("names every %s subagent tool", (harness) => {
    const skill = cwSkillMarkdown(harness);
    for (const tool of SUBAGENT_TOOL_NAMES) expect(skill).toContain(`\`${cwToolName(harness, tool)}\``);
    expect(skill).toContain("wait: false");
  });

  it("does not leak another harness's tool names", () => {
    expect(cwSkillMarkdown("codex")).not.toContain("mcp__plugin_cw-code_cw__");
    expect(cwSkillMarkdown("opencode")).not.toContain("mcp__");
    expect(cwSkillMarkdown("claude")).not.toContain("`cw_session_create`");
  });

  it("points only Claude at CW_SESSION_ID, which shared harness processes do not carry", () => {
    expect(cwSkillMarkdown("claude")).toContain("CW_SESSION_ID");
    expect(cwSkillMarkdown("codex")).not.toContain("CW_SESSION_ID");
    expect(cwSkillMarkdown("opencode")).not.toContain("CW_SESSION_ID");
  });
});

describe("cwPrSkillMarkdown", () => {
  it.each(["claude", "codex", "opencode"] as AgentHarness[])("names every %s pull request tool under its own frontmatter", (harness) => {
    const skill = cwPrSkillMarkdown(harness);
    expect(skill.startsWith(`---\nname: ${PR_SKILL_NAME}\ndescription: `)).toBe(true);
    for (const tool of PR_TOOLS) expect(skill).toContain(`\`${cwToolName(harness, tool)}\``);
    expect(skill).toContain("opened: true");
  });

  it("does not leak another harness's tool names", () => {
    expect(cwPrSkillMarkdown("codex")).not.toContain("mcp__plugin_cw-code_cw__");
    expect(cwPrSkillMarkdown("opencode")).not.toContain("mcp__");
  });
});

describe("cwSkills", () => {
  it.each(["claude", "codex", "opencode"] as AgentHarness[])("ships the session and pull request skills for %s", (harness) => {
    expect(cwSkills(harness)).toEqual([
      { name: "cw-code", description: SKILL_DESCRIPTION, markdown: cwSkillMarkdown(harness) },
      { name: "cw-code-prs", description: PR_SKILL_DESCRIPTION, markdown: cwPrSkillMarkdown(harness) }
    ]);
  });
});
