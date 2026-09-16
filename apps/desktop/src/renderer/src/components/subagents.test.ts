import { describe, expect, it } from "vitest";
import {
  collectAgentMessages,
  collectSubagents,
  describeSubagent,
  extractJsonStringFragment,
  formatSubagentCount,
  formatTokensShort,
  groupStatus,
  groupSubagentMetrics,
  groupSubagents,
  isSubagentMessage,
  isSubagentTool,
  mergeSubagentTools,
  parseResultCounts,
  shortModelName,
  unwrapTaskOutput,
  type SubagentMessage
} from "./subagents.js";
import { mergeToolPairs } from "./toolSummaries.js";
import type { ChatMessage } from "../stores/appStore.js";

let nextId = 0;
function msg(partial: Partial<SubagentMessage> & { id?: string }): SubagentMessage {
  return { role: "tool", text: "", turnId: "t1", id: `test-${nextId++}`, ...partial };
}

describe("isSubagentTool", () => {
  it("matches Task and Agent case-insensitively", () => {
    expect(isSubagentTool("Task")).toBe(true);
    expect(isSubagentTool("task")).toBe(true);
    expect(isSubagentTool("Agent")).toBe(true);
    expect(isSubagentTool("AGENT")).toBe(true);
    expect(isSubagentTool("Bash")).toBe(false);
    expect(isSubagentTool(undefined)).toBe(false);
  });

  it("matches tool messages only", () => {
    expect(isSubagentMessage(msg({ toolName: "Task" }))).toBe(true);
    expect(isSubagentMessage(msg({ role: "assistant", toolName: "Task" }))).toBe(false);
  });
});

describe("describeSubagent", () => {
  it("extracts Agent description, model, background flag and prompt", () => {
    const info = describeSubagent(
      msg({
        toolName: "Agent",
        text: "Agent",
        toolInput: {
          description: "Implement Task 1: agent factory",
          model: "opus",
          run_in_background: false,
          prompt: "You are implementing Task 1 of the plan"
        },
        toolOutput: "All done. Final report follows."
      })
    );
    expect(info.name).toBe("Implement Task 1: agent factory");
    expect(info.model).toBe("opus");
    expect(info.runInBackground).toBe(false);
    expect(info.prompt).toBe("You are implementing Task 1 of the plan");
    expect(info.status).toBe("completed");
    expect(info.summary).toBe("All done. Final report follows.");
  });

  it("extracts Task description and subagent_type", () => {
    const info = describeSubagent(
      msg({
        toolName: "Task",
        text: "Task",
        toolInput: { description: "Review diff", subagent_type: "general-purpose", prompt: "Review it" }
      })
    );
    expect(info.name).toBe("Review diff");
    expect(info.agentType).toBe("general-purpose");
    expect(info.status).toBe("running");
    expect(info.summary).toBe("Review it");
  });

  it("recovers input from history-shaped Name {json} text", () => {
    const info = describeSubagent(
      msg({
        toolName: "Agent",
        text: 'Agent {"description":"Verify skill","model":"sonnet","prompt":"Check it"}',
        toolOutput: "ok"
      })
    );
    expect(info.name).toBe("Verify skill");
    expect(info.model).toBe("sonnet");
  });

  it("recovers description and prompt prefix from truncated history JSON", () => {
    const info = describeSubagent(
      msg({
        toolName: "Agent",
        text: 'Agent {"description":"Implement Task 1: agent factory","model":"opus","run_in_background":false,"prompt":"You are implementing Task 1 of the plan in the repo `C:\\\\Projects\\\\nuria',
        toolOutput: "Async agent launched successfully."
      })
    );
    expect(info.name).toBe("Implement Task 1: agent factory");
    expect(info.model).toBe("opus");
    expect(info.prompt?.startsWith("You are implementing Task 1")).toBe(true);
    expect(info.prompt?.endsWith("…")).toBe(true);
  });

  it("prefers structured toolInput over text fragments", () => {
    const info = describeSubagent(
      msg({
        toolName: "Task",
        text: 'Task {"description":"stale","prompt":"stale prompt"}',
        toolInput: { description: "Fresh", prompt: "Fresh prompt" }
      })
    );
    expect(info.name).toBe("Fresh");
    expect(info.prompt).toBe("Fresh prompt");
  });

  it("uses structured tool usage, agent id and duration", () => {
    const info = describeSubagent(
      msg({
        toolName: "Agent",
        toolInput: { description: "Review diff", run_in_background: true },
        toolOutput: "Approve with nits.",
        toolDone: true,
        toolStartedAt: 1000,
        toolCompletedAt: 9000,
        subagentAgentId: "a36e7282329ba6455",
        toolUsage: { tokens: 136099, toolUses: 12, durationMs: 287602 }
      })
    );
    expect(info.agentId).toBe("a36e7282329ba6455");
    expect(info.durationMs).toBe(287602);
    expect(info.counts).toEqual({ tokens: 136099, tools: 12 });
  });

  it("hides the launch acknowledgement from output and summary while still running", () => {
    const info = describeSubagent(
      msg({
        toolName: "Agent",
        toolInput: { description: "Review PR #15", prompt: "Review the PR", run_in_background: true },
        toolOutput: "Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a36e7282329ba6455",
        toolDone: true
      })
    );
    expect(info.status).toBe("running");
    expect(info.output).toBeUndefined();
    expect(info.summary).toBe("Review the PR");
  });

  it("completes a background agent once the notification result replaces the launch ack", () => {
    const info = describeSubagent(
      msg({
        toolName: "Agent",
        toolInput: { description: "Review PR #15", run_in_background: true },
        toolOutput: "Approve with nits; two blockers.",
        toolDone: true,
        toolCompletedAt: 5000
      })
    );
    expect(info.status).toBe("completed");
    expect(info.output).toBe("Approve with nits; two blockers.");
  });

  it("falls back to the sidecar model when the call omits it", () => {
    const info = describeSubagent(
      msg({
        toolName: "Task",
        text: "Task",
        toolInput: { description: "Audit", subagent_type: "general-purpose" },
        subagentModel: "claude-sonnet-5"
      })
    );
    expect(info.model).toBe("sonnet-5");
  });

  it("prefers the explicit call model over the sidecar model", () => {
    const info = describeSubagent(
      msg({
        toolName: "Agent",
        text: "Agent",
        toolInput: { description: "x", model: "opus" },
        subagentModel: "claude-sonnet-5"
      })
    );
    expect(info.model).toBe("opus");
  });

  it("exposes nested sidecar tools and their total", () => {
    const info = describeSubagent(
      msg({
        toolName: "Task",
        toolInput: { description: "x" },
        subagentTools: {
          total: 3,
          items: [{ id: "tu1", name: "Read", input: { path: "a.ts" } }]
        }
      })
    );
    expect(info.toolCount).toBe(3);
    expect(info.tools).toHaveLength(1);
    expect(info.tools[0].name).toBe("Read");
  });

  it("prefers sidecar metrics over result hints, including a zero tool count", () => {
    const info = describeSubagent(
      msg({
        toolName: "Task",
        toolInput: { description: "x" },
        toolOutput: "456 tokens · 7 tools · effort: low",
        subagentTools: { total: 0, items: [], effort: "high", totalTokens: 123 }
      })
    );
    expect(info.counts).toEqual(expect.objectContaining({ tokens: 123, tools: 0, effort: "high" }));
  });

  it("defaults to no nested tools", () => {
    const info = describeSubagent(msg({ toolName: "Task", toolInput: { description: "x" } }));
    expect(info.tools).toEqual([]);
    expect(info.toolCount).toBe(0);
  });

  it("maps error status and duration from timestamps", () => {
    const info = describeSubagent(
      msg({
        toolName: "Task",
        toolInput: { description: "x" },
        toolOutput: "boom",
        isError: true,
        toolStartedAt: 1000,
        toolCompletedAt: 46000
      })
    );
    expect(info.status).toBe("error");
    expect(info.durationMs).toBe(45000);
  });

  it("falls back to prompt excerpt when no output yet", () => {
    const info = describeSubagent(
      msg({ toolName: "Task", toolInput: { description: "Deep work", prompt: "First line\nSecond line" } })
    );
    expect(info.summary).toBe("First line");
  });

  it("derives durations from merged history timestamps", () => {
    const history: ChatMessage[] = [
      {
        id: "toolu_1",
        role: "tool",
        text: 'Task {"description":"Deep work","prompt":"Do it"}',
        turnId: "t9",
        toolName: "Task",
        timestamp: 1000
      },
      { id: "toolu_1-r", role: "tool", text: "done", turnId: "t9", toolName: "result", timestamp: 46000 }
    ];
    const merged = mergeToolPairs(history);
    const infos = collectSubagents(merged);
    expect(infos).toHaveLength(1);
    expect(infos[0].name).toBe("Deep work");
    expect(infos[0].durationMs).toBe(45000);
  });

  it("falls back to Subagent when description and prompt are empty", () => {
    const info = describeSubagent(msg({ toolName: "Task", toolInput: { description: "  " } }));
    expect(info.name).toBe("Subagent");
    expect(info.summary).toBe("Subagent");
  });

  it("treats toolDone without output as completed with unknown duration", () => {
    const info = describeSubagent(msg({ toolName: "Agent", toolInput: { description: "x" }, toolDone: true }));
    expect(info.status).toBe("completed");
    expect(info.durationMs).toBeUndefined();
  });

  it("ignores inverted timestamps", () => {
    const info = describeSubagent(
      msg({
        toolName: "Task",
        toolInput: { description: "x" },
        toolOutput: "done",
        toolStartedAt: 5000,
        toolCompletedAt: 1000
      })
    );
    expect(info.durationMs).toBeUndefined();
  });
});

describe("extractJsonStringFragment", () => {
  it("extracts closed values and unescapes quotes", () => {
    expect(extractJsonStringFragment('Agent {"description":"Fix the \\"auth\\" bug"}', ["description"])).toBe(
      'Fix the "auth" bug'
    );
  });

  it("marks values cut off by truncation with an ellipsis", () => {
    expect(extractJsonStringFragment('Agent {"prompt":"You are implemen', ["prompt"])).toBe("You are implemen…");
  });

  it("returns undefined when the key is absent", () => {
    expect(extractJsonStringFragment("Agent {}", ["description"])).toBeUndefined();
  });
});

describe("shortModelName", () => {
  it("strips the claude vendor prefix", () => {
    expect(shortModelName("claude-sonnet-5")).toBe("sonnet-5");
    expect(shortModelName("opus")).toBe("opus");
  });

  it("returns undefined for missing names", () => {
    expect(shortModelName(undefined)).toBeUndefined();
    expect(shortModelName("  ")).toBeUndefined();
  });
});

describe("parseResultCounts", () => {
  it("parses k-token and tool counts", () => {
    expect(parseResultCounts("done · 284k tok · 92 tools")).toEqual(
      expect.objectContaining({ tokens: 284000, tools: 92 })
    );
    expect(parseResultCounts("done · 90.1k tokens · 19 tools")).toEqual(
      expect.objectContaining({ tokens: 90100, tools: 19 })
    );
  });

  it("returns undefined when no counts are present", () => {
    expect(parseResultCounts("All done. Final report follows.")).toBeUndefined();
    expect(parseResultCounts(undefined)).toBeUndefined();
  });

  it("does not match singular tool prose", () => {
    expect(parseResultCounts("used the right tool for the job")).toBeUndefined();
  });

  it("parses singular tool counts and comma-separated tokens", () => {
    expect(parseResultCounts("finished · 1 tool")).toEqual(expect.objectContaining({ tools: 1 }));
    expect(parseResultCounts("finished · 12,345 tokens")).toEqual(expect.objectContaining({ tokens: 12345 }));
  });

  it("parses model and effort hints", () => {
    expect(parseResultCounts("model: opus-4\nsome work")).toEqual(expect.objectContaining({ model: "opus-4" }));
    expect(parseResultCounts("effort: high")).toEqual(expect.objectContaining({ effort: "high" }));
  });
});

describe("collectAgentMessages", () => {
  it("selects only messages linked to the agent", () => {
    const found = collectAgentMessages(
      [
        msg({ id: "sm1", toolName: "SendMessage", parentToolCallId: "tu1" }),
        msg({ id: "sm2", toolName: "SendMessage", parentToolCallId: "tu2" }),
        msg({ id: "b1", toolName: "Bash" })
      ],
      "tu1"
    );
    expect(found.map((m) => m.id)).toEqual(["sm1"]);
  });
});

describe("groupSubagents", () => {
  it("groups consecutive subagent tools and splits on text", () => {
    const groups = groupSubagents([
      msg({ id: "a1", toolName: "Task", toolInput: { description: "one" } }),
      msg({ id: "a2", toolName: "Agent", toolInput: { description: "two" } }),
      msg({ id: "t", role: "assistant", text: "text" }),
      msg({ id: "a3", toolName: "Task", toolInput: { description: "three" } })
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((i) => i.name)).toEqual(["one", "two"]);
    expect(groups[1].items.map((i) => i.name)).toEqual(["three"]);
  });

  it("splits groups on other tool kinds so panel ids match inline cards", () => {
    const groups = groupSubagents([
      msg({ id: "a1", toolName: "Task", toolInput: { description: "one" } }),
      msg({ id: "b1", toolName: "Bash", text: "ls" }),
      msg({ id: "a2", toolName: "Agent", toolInput: { description: "two" } })
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((i) => i.name)).toEqual(["one"]);
    expect(groups[1].items.map((i) => i.name)).toEqual(["two"]);
  });
});

describe("unwrapTaskOutput", () => {
  it("extracts the inner result from opencode task wrappers", () => {
    const wrapped = `<task id="ses_1" state="completed">\n<task_result>\n# Report\n\nDone.\n</task_result>\n</task>`;
    expect(unwrapTaskOutput(wrapped)).toBe("# Report\n\nDone.");
    expect(unwrapTaskOutput("plain output")).toBe("plain output");
    expect(unwrapTaskOutput(undefined)).toBeUndefined();
  });

  it("handles leading whitespace, missing closing tags and tag-only output", () => {
    expect(unwrapTaskOutput(`\n  <task id="ses_1" state="completed">\n<task_result>\nDone\n</task_result>`)).toBe("Done");
    expect(unwrapTaskOutput(`<task id="ses_1" state="running">`)).toBe("");
    expect(unwrapTaskOutput(`<task id="ses_1" state="running">\nstarting up`)).toBe("starting up");
  });

  it("summarizes wrapped output without the task tag line", () => {
    const info = describeSubagent(
      msg({
        toolName: "task",
        toolInput: { description: "Explore drivers", subagent_type: "explore" },
        toolOutput: `<task id="ses_1" state="completed">\n<task_result>\n# Survey\n\nDetails here.\n</task_result>\n</task>`
      })
    );
    expect(info.name).toBe("Explore drivers");
    expect(info.summary).toBe("Survey");
    expect(info.output).toBe("# Survey\n\nDetails here.");
  });
});

describe("helpers", () => {
  it("collects, counts and rolls up status", () => {
    const infos = collectSubagents([
      msg({ id: "a1", toolName: "Task", toolInput: { description: "one" } }),
      msg({ id: "b1", toolName: "Bash", text: "ls" })
    ]);
    expect(infos).toHaveLength(1);
    expect(formatSubagentCount(1)).toBe("1 subagent");
    expect(formatSubagentCount(2)).toBe("2 subagents");
    expect(formatTokensShort(284000)).toBe("284k");
    expect(formatTokensShort(90100)).toBe("90.1k");
    expect(formatTokensShort(999)).toBe("999");
    expect(formatTokensShort(1000)).toBe("1k");
    expect(formatTokensShort(1500000)).toBe("1.5M");
    expect(groupStatus([{ status: "completed" }, { status: "running" }])).toBe("running");
    expect(groupStatus([{ status: "completed" }, { status: "error" }])).toBe("error");
    expect(groupStatus([{ status: "running" }, { status: "error" }])).toBe("running");
  });

  it("aggregates group metrics and reports mixed known efforts", () => {
    const matching = groupSubagentMetrics([
      { counts: { tokens: 100, tools: 2, effort: "high" } },
      { counts: { tokens: 50, tools: 3, effort: "high" } },
      { counts: { tools: 0 } }
    ]);
    expect(matching).toEqual({ tokens: 150, tools: 5, effort: "high" });
    expect(groupSubagentMetrics([{ counts: { effort: "high" } }, { counts: { effort: "low" } }])).toEqual({
      effort: "mixed"
    });
    expect(groupSubagentMetrics([{ counts: { tokens: 0, tools: 0 } }, {}])).toEqual({ tokens: 0, tools: 0 });
  });
});

describe("mergeSubagentTools", () => {
  it("prefers live activity over fetched entries and sorts by timestamp", () => {
    const merged = mergeSubagentTools(
      [
        {
          id: "tu2",
          role: "tool",
          text: "Bash",
          turnId: "t1",
          toolName: "Bash",
          toolInput: { command: "ls" },
          toolOutput: "a.ts",
          toolDone: true,
          toolStartedAt: 2000,
          toolCompletedAt: 2500
        }
      ],
      [
        { id: "tu1", name: "Read", input: { file_path: "a.ts" }, timestamp: 1000, output: "file!" },
        { id: "tu2", name: "Bash", input: { command: "ls" }, timestamp: 2000 }
      ]
    );
    expect(merged.map((tool) => tool.id)).toEqual(["tu1", "tu2"]);
    expect(merged[1].output).toBe("a.ts");
    expect(merged[1].completedAt).toBe(2500);
  });

  it("ignores non-tool rows and merges nothing when both sources are empty", () => {
    expect(mergeSubagentTools([], [])).toEqual([]);
    expect(
      mergeSubagentTools([{ id: "m1", role: "assistant", text: "hi", turnId: "t1" }], [])
    ).toEqual([]);
  });
});
