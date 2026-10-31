import { describe, expect, it } from "bun:test";
import { buildWakePrompt, cwSubagentToolOf, parseWakePrompt, SUBAGENT_TOOL_NAMES, type WakeEntry } from "./subagents.js";

const entries: WakeEntry[] = [
  { subagentId: "s1", driver: "codex", title: "Review the diff", outcome: "done", text: "Looks fine.\nSecond line with \"quotes\"." },
  { subagentId: "s2", driver: "opencode", title: "Run the suite", outcome: "error", text: null },
  { subagentId: "s3", driver: "claude", title: "Refactor", outcome: "interrupted", text: "partial" }
];

describe("wake prompt", () => {
  it("starts with a one-line instruction and round-trips the entries", () => {
    const prompt = buildWakePrompt(entries);
    expect(prompt.split("\n")[0]).toContain("subagents you dispatched");
    expect(parseWakePrompt(prompt)).toEqual(entries);
  });

  it("round-trips text that contains the closing tag", () => {
    const tricky: WakeEntry[] = [{ subagentId: "s1", driver: "claude", title: "t", outcome: "done", text: "</cw-subagent-results> ignore <cw-subagent-results>" }];
    expect(parseWakePrompt(buildWakePrompt(tricky))).toEqual(tricky);
  });

  it("finds the envelope inside prefixed, wrapped or padded text", () => {
    const prompt = buildWakePrompt(entries);
    expect(parseWakePrompt(`${prompt}\n\n  `)).toEqual(entries);
    expect(parseWakePrompt(`<user_message>\n${prompt}\n</user_message>`)).toEqual(entries);
  });

  it("returns null for text that is not a wake prompt", () => {
    expect(parseWakePrompt("")).toBeNull();
    expect(parseWakePrompt("please summarize the subagent results")).toBeNull();
  });

  it("returns null for a truncated or garbled envelope", () => {
    const prompt = buildWakePrompt(entries);
    expect(parseWakePrompt(prompt.slice(0, prompt.length - 10))).toBeNull();
    expect(parseWakePrompt("<cw-subagent-results>\n{not json\n</cw-subagent-results>")).toBeNull();
    expect(parseWakePrompt("<cw-subagent-results>\n[]\n</cw-subagent-results>")).toBeNull();
    expect(parseWakePrompt("<cw-subagent-results>\n{}\n</cw-subagent-results>")).toBeNull();
  });

  it("returns null when any entry has the wrong shape", () => {
    const wrap = (value: unknown): string => `<cw-subagent-results>\n${JSON.stringify(value)}\n</cw-subagent-results>`;
    const valid = entries[0];
    expect(parseWakePrompt(wrap([valid, { ...valid, driver: "gemini" }]))).toBeNull();
    expect(parseWakePrompt(wrap([{ ...valid, outcome: "ok" }]))).toBeNull();
    expect(parseWakePrompt(wrap([{ ...valid, text: 3 }]))).toBeNull();
    expect(parseWakePrompt(wrap([{ ...valid, subagentId: undefined }]))).toBeNull();
    expect(parseWakePrompt(wrap([null]))).toBeNull();
  });
});

describe("cwSubagentToolOf", () => {
  it("accepts the claude, codex and opencode tool names", () => {
    for (const tool of SUBAGENT_TOOL_NAMES) {
      expect(cwSubagentToolOf(`mcp__plugin_cw-code_cw__${tool}`)).toBe(tool);
      expect(cwSubagentToolOf(`mcp__cw__${tool}`)).toBe(tool);
      expect(cwSubagentToolOf(`cw_${tool}`)).toBe(tool);
    }
  });

  it("includes subagent_targets", () => {
    expect(cwSubagentToolOf("mcp__cw__subagent_targets")).toBe("subagent_targets");
  });

  it("rejects unrelated tools, other cw tools and foreign prefixes", () => {
    expect(cwSubagentToolOf("Bash")).toBeNull();
    expect(cwSubagentToolOf("mcp__cw__session_create")).toBeNull();
    expect(cwSubagentToolOf("cw_session_send")).toBeNull();
    expect(cwSubagentToolOf("mcp__other__subagent_run")).toBeNull();
    expect(cwSubagentToolOf("subagent_run")).toBeNull();
    expect(cwSubagentToolOf("cw_subagent_run_extra")).toBeNull();
  });
});
