import { describe, expect, it } from "bun:test";
import type { SubagentSummary } from "@cw-code/contracts";
import { buildWakePrompt } from "@cw-code/shared/subagents";
import {
  cwSubagentCardTool,
  cwSubagentState,
  cwToolOf,
  describeCwSubagentCall,
  matchCwSubagent,
  parseCwSubagentOutput,
  resultTextFor,
  wakeEntriesOf
} from "./cwSubagents.js";

const REPORT = { subagentId: "sess_child", status: "idle", resultText: "all done", timedOut: false, next: null };

describe("cwToolOf", () => {
  it("recognizes prefixed names and bare names only for codex", () => {
    expect(cwToolOf("mcp__plugin_cw-code_cw__subagent_run")).toBe("subagent_run");
    expect(cwToolOf("cw_subagents_list")).toBe("subagents_list");
    expect(cwToolOf("subagent_wait", "codex")).toBe("subagent_wait");
    expect(cwToolOf("subagent_wait")).toBeNull();
    expect(cwToolOf("subagent_wait", "claude")).toBeNull();
    expect(cwToolOf("read")).toBeNull();
    expect(cwToolOf(undefined)).toBeNull();
  });

  it("limits cards to run, send and wait", () => {
    expect(cwSubagentCardTool("mcp__cw__subagent_send")).toBe("subagent_send");
    expect(cwSubagentCardTool("mcp__cw__subagent_stop")).toBeNull();
    expect(cwSubagentCardTool("mcp__cw__subagent_targets")).toBeNull();
  });
});

describe("parseCwSubagentOutput", () => {
  it("reads the plain JSON report", () => {
    expect(parseCwSubagentOutput(JSON.stringify(REPORT))).toEqual({
      subagentId: "sess_child",
      status: "idle",
      resultText: "all done",
      timedOut: false
    });
  });

  it("unwraps MCP content blocks as codex reports them", () => {
    const wrapped = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(REPORT) }] });
    expect(parseCwSubagentOutput(wrapped)?.subagentId).toBe("sess_child");
    expect(parseCwSubagentOutput(JSON.stringify([{ type: "text", text: JSON.stringify(REPORT) }]))?.resultText).toBe("all done");
  });

  it("recovers the id and status from truncated output", () => {
    const truncated = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(REPORT) }] }).slice(0, 100);
    expect(parseCwSubagentOutput(truncated)).toEqual({ subagentId: "sess_child", status: "idle" });
  });

  it("returns null for unrelated output", () => {
    expect(parseCwSubagentOutput("unknown subagent x")).toBeNull();
    expect(parseCwSubagentOutput(undefined)).toBeNull();
  });
});

describe("describeCwSubagentCall", () => {
  it("takes the id from the output of a run", () => {
    const call = describeCwSubagentCall("cw_subagent_run", { driver: "codex", task: "fix it", title: "Fixer", model: "gpt-5" }, JSON.stringify(REPORT));
    expect(call).toMatchObject({ tool: "subagent_run", subagentId: "sess_child", driver: "codex", title: "Fixer", prompt: "fix it", model: "gpt-5" });
  });

  it("takes the id from the input of a wait before it returns", () => {
    expect(describeCwSubagentCall("mcp__cw__subagent_wait", { subagentId: "sess_w" }, undefined)).toMatchObject({ subagentId: "sess_w", output: null });
  });

  it("ignores non-card tools", () => {
    expect(describeCwSubagentCall("mcp__cw__subagents_list", {}, "[]")).toBeNull();
  });

  it("describes a bare tool name only in a codex session", () => {
    expect(describeCwSubagentCall("subagent_wait", { subagentId: "sess_w" }, undefined, "codex")).toMatchObject({ tool: "subagent_wait" });
    expect(describeCwSubagentCall("subagent_wait", { subagentId: "sess_w" }, undefined, "claude")).toBeNull();
  });
});

describe("matchCwSubagent", () => {
  const summary = (id: string, createdAt: number, driver: SubagentSummary["driver"] = "codex"): SubagentSummary => ({
    id,
    driver,
    title: id,
    status: "working",
    isolation: "shared",
    pendingRequests: 0,
    createdAt,
    updatedAt: createdAt
  });

  it("matches by id when the call knows it", () => {
    expect(matchCwSubagent([summary("a", 1), summary("b", 2)], { tool: "subagent_wait", subagentId: "b" }, 0)?.id).toBe("b");
  });

  it("matches a blocking run to the single child created after it started", () => {
    const list = [summary("old", 100), summary("new", 5000)];
    expect(matchCwSubagent(list, { tool: "subagent_run", driver: "codex" }, 4000)?.id).toBe("new");
    expect(matchCwSubagent([...list, summary("twin", 5100)], { tool: "subagent_run", driver: "codex" }, 4000)).toBeUndefined();
    expect(matchCwSubagent(list, { tool: "subagent_run", driver: "claude" }, 4000)).toBeUndefined();
  });

  it("compares the call title with the server-normalized title", () => {
    const titled = { ...summary("new", 5000), title: `${"x".repeat(59)}…` };
    expect(matchCwSubagent([titled], { tool: "subagent_run", title: "x".repeat(100) }, 4000)?.id).toBe("new");
    const spaced = { ...summary("spaced", 5000), title: "fix the bug" };
    expect(matchCwSubagent([spaced], { tool: "subagent_run", title: "  fix \n the  bug " }, 4000)?.id).toBe("spaced");
    expect(matchCwSubagent([spaced], { tool: "subagent_run", title: "other" }, 4000)).toBeUndefined();
  });

  it("only matches children created while the call was in flight", () => {
    const later = [summary("later", 90_000)];
    expect(matchCwSubagent(later, { tool: "subagent_run" }, 4000, 8000)).toBeUndefined();
    expect(matchCwSubagent(later, { tool: "subagent_run" }, 4000)).toBeUndefined();
    expect(matchCwSubagent([summary("during", 6000)], { tool: "subagent_run" }, 4000, 8000)?.id).toBe("during");
    expect(matchCwSubagent([summary("running", 50_000)], { tool: "subagent_run" }, 4000)?.id).toBe("running");
  });
});

describe("resultTextFor", () => {
  it("prefers the tool's own result, then a settled result newer than the call", () => {
    const settled = { status: "idle" as const, result: { turnId: "t", outcome: "done" as const, text: "late", at: 50 } };
    expect(resultTextFor({ output: { resultText: "own" } }, settled, 10)).toBe("own");
    expect(resultTextFor({ output: { resultText: null } }, settled, 10)).toBe("late");
    expect(resultTextFor({ output: null }, settled, 60)).toBeNull();
    expect(resultTextFor({ output: null }, { ...settled, status: "working" }, 10)).toBeNull();
  });
});

describe("cwSubagentState", () => {
  it("maps session status and result outcome", () => {
    expect(cwSubagentState("working", "done")).toBe("running");
    expect(cwSubagentState("input-required")).toBe("waiting");
    expect(cwSubagentState("idle", "error")).toBe("failed");
    expect(cwSubagentState("idle", "interrupted")).toBe("interrupted");
    expect(cwSubagentState("idle")).toBe("completed");
    expect(cwSubagentState("archived")).toBe("stopped");
    expect(cwSubagentState(undefined)).toBe("unknown");
  });
});

describe("wakeEntriesOf", () => {
  it("parses wake prompts on user items only", () => {
    const text = buildWakePrompt([{ subagentId: "c", driver: "claude", title: "T", outcome: "done", text: "r" }]);
    expect(wakeEntriesOf({ role: "user", text })?.map((entry) => entry.subagentId)).toEqual(["c"]);
    expect(wakeEntriesOf({ role: "assistant", text })).toBeNull();
    expect(wakeEntriesOf({ role: "user", text: "hello" })).toBeNull();
  });
});
