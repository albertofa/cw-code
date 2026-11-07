import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeHistoryFile } from "./claudeHistory.js";
import { CLAUDE_SKILL_CONTENT_LIMIT, claudeTranscriptToolContent, parseClaudeSyntheticUserText } from "./claudeSkillContent.js";

const BODY = "Base directory for this skill: /home/dev/.claude/skills/demo\n\n# Demo skill\n\nDo the thing.";

describe("parseClaudeSyntheticUserText", () => {
  it("reads the skill body from a top-level synthetic user message", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: BODY }] },
      parent_tool_use_id: null,
      isSynthetic: true
    });
    expect(parseClaudeSyntheticUserText(line)).toBe(BODY);
  });

  it("ignores subagent, non-synthetic, empty and tool-result messages", () => {
    const base = { type: "user", message: { content: [{ type: "text", text: BODY }] }, isSynthetic: true };
    expect(parseClaudeSyntheticUserText(JSON.stringify({ ...base, parent_tool_use_id: "toolu_parent" }))).toBeNull();
    expect(parseClaudeSyntheticUserText(JSON.stringify({ ...base, isSynthetic: false }))).toBeNull();
    expect(parseClaudeSyntheticUserText(JSON.stringify({ ...base, message: { content: [{ type: "text", text: "  " }] } }))).toBeNull();
    expect(
      parseClaudeSyntheticUserText(
        JSON.stringify({ ...base, message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } })
      )
    ).toBeNull();
    expect(parseClaudeSyntheticUserText("not json isSynthetic")).toBeNull();
  });

  it("caps the body", () => {
    const line = JSON.stringify({ type: "user", isSynthetic: true, message: { content: "x".repeat(CLAUDE_SKILL_CONTENT_LIMIT + 50) } });
    expect(parseClaudeSyntheticUserText(line)?.length).toBe(CLAUDE_SKILL_CONTENT_LIMIT);
  });
});

describe("claudeTranscriptToolContent", () => {
  it("keys an isMeta body by its source tool call", () => {
    expect(
      claudeTranscriptToolContent({
        type: "user",
        isMeta: true,
        sourceToolUseID: "toolu_skill",
        message: { content: [{ type: "text", text: BODY }] }
      })
    ).toEqual({ toolUseId: "toolu_skill", text: BODY });
  });

  it("ignores meta lines without a source call and sidechain lines", () => {
    expect(claudeTranscriptToolContent({ type: "user", isMeta: true, message: { content: BODY } })).toBeNull();
    expect(
      claudeTranscriptToolContent({ type: "user", isMeta: true, isSidechain: true, sourceToolUseID: "t", message: { content: BODY } })
    ).toBeNull();
  });
});

function transcript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-claude-skill-"));
  const file = join(dir, "cursor-1.jsonl");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

describe("readClaudeHistoryFile skill bodies", () => {
  const call = (id: string, name: string) => ({
    type: "assistant",
    uuid: `a-${id}`,
    message: { content: [{ type: "tool_use", id, name, input: { skill: "demo" } }] }
  });
  const result = (id: string, text: string) => ({
    type: "user",
    uuid: `r-${id}`,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] }
  });
  const meta = (id: string, text: string) => ({
    type: "user",
    uuid: `m-${id}`,
    isMeta: true,
    sourceToolUseID: id,
    message: { content: [{ type: "text", text }] }
  });

  it("shows the loaded skill body as the Skill call's result", () => {
    const file = transcript([call("toolu_skill", "Skill"), result("toolu_skill", "Launching skill: demo"), meta("toolu_skill", BODY)]);
    const messages = readClaudeHistoryFile(file, "cursor-1");
    expect(messages.find((m) => m.id === "toolu_skill-r")?.text).toBe(BODY);
    expect(messages.some((m) => m.role === "user")).toBe(false);
  });

  it("leaves other tools' results alone", () => {
    const file = transcript([call("toolu_other", "Read"), result("toolu_other", "file text"), meta("toolu_other", BODY)]);
    expect(readClaudeHistoryFile(file, "cursor-1").find((m) => m.id === "toolu_other-r")?.text).toBe("file text");
  });
});
