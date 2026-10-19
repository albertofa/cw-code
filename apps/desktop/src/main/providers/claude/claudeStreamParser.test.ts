import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attributeClaudeSubagentEvent,
  buildClaudeAllowRule,
  claudeAllowResponse,
  claudeApprovalRequest,
  claudeControlResponse,
  claudeDenyResponse,
  claudeQuestionRequest,
  parseClaudeCompactBoundary,
  parseClaudeControlRequest,
  parseClaudeSubagentHandback,
  parseClaudeSystemInit,
  parseClaudeTaskNotificationLine,
  parseClaudeTaskSystemLine,
  parseClaudeToolUseResult,
  parseTaskNotificationUsage,
  parseStreamLine,
  type TurnDoneInfo
} from "./claudeStreamParser.js";

function hooksProbeStreamLines(): string[] {
  const text = readFileSync(
    fileURLToPath(new URL("./__fixtures__/tasks/hooks-probe/stream.jsonl", import.meta.url)),
    "utf8"
  );
  return text.split("\n").filter(Boolean);
}

function compactJson(line: string): string {
  return JSON.stringify(JSON.parse(line));
}

function hooksProbeSystemLine(subtype: string, taskId: string): string {
  const line = hooksProbeStreamLines().find((candidate) => {
    const msg = JSON.parse(candidate) as { type?: string; subtype?: string; task_id?: string };
    return msg.type === "system" && msg.subtype === subtype && msg.task_id === taskId;
  });
  if (!line) throw new Error(`fixture ${subtype} line not found for ${taskId}`);
  return compactJson(line);
}

describe("parseClaudeSubagentHandback", () => {
  it("maps a nested Handback message to its parent Agent result", () => {
    expect(
      parseClaudeSubagentHandback({
        type: "tool.call",
        turnId: "t1",
        toolCallId: "handback-1",
        name: "SubagentHandback",
        input: { message: "final report" },
        parentToolCallId: "agent-1"
      })
    ).toEqual({
      type: "tool.result",
      turnId: "t1",
      toolCallId: "agent-1",
      output: "final report",
      isError: false
    });
  });

  it("ignores non-Handback and malformed events", () => {
    expect(
      parseClaudeSubagentHandback({
        type: "tool.call",
        turnId: "t1",
        toolCallId: "read-1",
        name: "Read",
        input: { path: "a.ts" }
      })
    ).toBeNull();
    expect(
      parseClaudeSubagentHandback({
        type: "tool.call",
        turnId: "t1",
        toolCallId: "handback-1",
        name: "SubagentHandback",
        input: { message: "" },
        parentToolCallId: "agent-1"
      })
    ).toBeNull();
  });
});

describe("parseClaudeTaskNotificationLine", () => {
  const notification = "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>";

  it("returns the notification text and the origin run id of a user message", () => {
    const line = JSON.stringify({
      type: "user",
      origin: { kind: "task-notification", runId: "run-1" },
      message: { content: `\n${notification}` }
    });
    expect(parseClaudeTaskNotificationLine(line)).toStrictEqual({ text: `\n${notification}`, runId: "run-1" });
  });

  it("omits a missing or blank run id", () => {
    expect(parseClaudeTaskNotificationLine(JSON.stringify({ type: "user", message: { content: notification } }))).toStrictEqual({
      text: notification
    });
    expect(
      parseClaudeTaskNotificationLine(JSON.stringify({ type: "user", origin: { runId: " " }, message: { content: notification } }))
    ).toStrictEqual({ text: notification });
  });

  it("accepts a notification the CLI wrapped in a system reminder when the origin marks it", () => {
    const wrapped = `<system-reminder>\n${notification}\n</system-reminder>`;
    const line = JSON.stringify({ type: "user", origin: { kind: "task-notification" }, message: { content: wrapped } });
    expect(parseClaudeTaskNotificationLine(line)).toStrictEqual({ text: wrapped });
  });

  it("ignores other lines", () => {
    expect(parseClaudeTaskNotificationLine(JSON.stringify({ type: "user", message: { content: `prose ${notification}` } }))).toBeNull();
    expect(parseClaudeTaskNotificationLine(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: notification }] } }))).toBeNull();
    expect(parseClaudeTaskNotificationLine(JSON.stringify({ type: "assistant", message: { content: notification } }))).toBeNull();
    expect(parseClaudeTaskNotificationLine(JSON.stringify({ type: "user", message: { content: "hello" } }))).toBeNull();
    expect(parseClaudeTaskNotificationLine('{"type":"user","message":{"content":"<task-notification>')).toBeNull();
  });
});

describe("parseStreamLine", () => {
  it("maps text deltas to assistant.delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "hello " } }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "assistant.delta", turnId: "t1", text: "hello " }
    ]);
  });

  it("maps thinking deltas and thinking blocks to reasoning.delta", () => {
    const deltaLine = JSON.stringify({
      type: "stream_event",
      event: { delta: { type: "thinking_delta", thinking: "weighing " } }
    });
    expect(parseStreamLine(deltaLine, "t1", "s1", () => {})).toEqual([
      { type: "reasoning.delta", turnId: "t1", text: "weighing " }
    ]);
    const blockLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "more" }] }
    });
    expect(parseStreamLine(blockLine, "t1", "s1", () => {})).toEqual([
      { type: "reasoning.delta", turnId: "t1", text: "more" }
    ]);
    const emptyLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "" }] }
    });
    expect(parseStreamLine(emptyLine, "t1", "s1", () => {})).toEqual([]);
  });

  it("maps assistant tool_use blocks to tool.call", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "a.ts" } }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.call", turnId: "t1", toolCallId: "tu1", name: "Read", input: { path: "a.ts" } }
    ]);
  });

  it("routes subagent tool calls to their parent call and drops subagent prose", () => {
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "call_task",
      message: {
        content: [
          { type: "text", text: "subagent narration" },
          { type: "thinking", thinking: "subagent thought" },
          { type: "tool_use", id: "tu_nested", name: "Bash", input: { command: "ls" } }
        ]
      }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      {
        type: "tool.call",
        turnId: "t1",
        toolCallId: "tu_nested",
        name: "Bash",
        input: { command: "ls" },
        parentToolCallId: "call_task"
      }
    ]);
  });

  it("emits todo.updated alongside tool.call for TodoWrite", () => {
    const input = {
      todos: [
        { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
        { content: "Ship it", status: "completed", activeForm: "Shipping it" }
      ]
    };
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu2", name: "TodoWrite", input }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.call", turnId: "t1", toolCallId: "tu2", name: "TodoWrite", input },
      {
        type: "todo.updated",
        turnId: "t1",
        todos: [
          { content: "Write tests", status: "in_progress" },
          { content: "Ship it", status: "completed" }
        ]
      }
    ]);
  });

  it("leaves non-todo tool calls without a todo event", () => {
    const input = { todos: [{ content: "Not a todo call" }] };
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu3", name: "Task", input }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.call", turnId: "t1", toolCallId: "tu3", name: "Task", input }
    ]);
  });

  it("maps user tool results to tool.result", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ tool_use_id: "tu1", content: "file contents" }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.result", turnId: "t1", toolCallId: "tu1", output: "file contents", isError: false }
    ]);
  });

  it("leaves a replayed task-notification user message to the task table instead of a tool.result", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: "<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>completed</status>\n<result>report</result>\n</task-notification>"
      }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([]);
  });

  it("normalizes text-block arrays in user tool results", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ tool_use_id: "tu1", content: [{ type: "text", text: "Async agent launched successfully." }] }]
      }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      { type: "tool.result", turnId: "t1", toolCallId: "tu1", output: "Async agent launched successfully.", isError: false }
    ]);
  });

  it("preserves JSON for non-text tool result content", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ tool_use_id: "tu1", content: [{ type: "image", source: { data: "abc" } }] }] }
    });
    expect(parseStreamLine(line, "t1", "s1", () => {})).toEqual([
      {
        type: "tool.result",
        turnId: "t1",
        toolCallId: "tu1",
        output: JSON.stringify([{ type: "image", source: { data: "abc" } }]),
        isError: false
      }
    ]);
  });

  it("emits turn metadata on result", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "sess-1",
      total_cost_usd: 0.02,
      usage: { input_tokens: 100, output_tokens: 20 },
      num_turns: 2,
      is_error: false
    });
    let captured: Parameters<Parameters<typeof parseStreamLine>[3]>[0] | null = null;
    const events = parseStreamLine(line, "t1", "s1", (info) => {
      captured = info;
    });
    expect(events).toEqual([]);
    expect(captured).toEqual({
      resumeCursor: "sess-1",
      resultText: "done",
      usage: [],
      modelUsage: {},
      numTurns: 2,
      isError: false
    });
  });

  it("threads mainModel through to pick the context window", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "sess-1",
      num_turns: 1,
      is_error: false,
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.5,
          contextWindow: 200000
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 5,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
          contextWindow: 50000
        }
      },
      usage: {
        iterations: [{ input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]
      }
    });
    const captured: { info?: TurnDoneInfo } = {};
    parseStreamLine(
      line,
      "t1",
      "s1",
      (info) => {
        captured.info = info;
      },
      undefined,
      undefined,
      {},
      "claude-haiku-4-5"
    );
    expect(captured.info?.context?.windowTokens).toBe(50000);
  });

  it("passes through non-JSON lines as text", () => {
    expect(parseStreamLine("plain text", "t1", "s1", () => {})).toEqual([
      { type: "assistant.delta", turnId: "t1", text: "plain text" }
    ]);
  });

  it("acks a task-notification result with zero turns instead of finishing the turn", () => {
    const line = JSON.stringify({
      type: "result",
      origin: { kind: "task-notification" },
      num_turns: 0,
      is_error: false,
      session_id: "sess-1"
    });
    let doneCalls = 0;
    let ackCalls = 0;
    const events = parseStreamLine(
      line,
      "t1",
      "s1",
      () => {
        doneCalls += 1;
      },
      () => {
        ackCalls += 1;
      }
    );
    expect(events).toEqual([]);
    expect(doneCalls).toBe(0);
    expect(ackCalls).toBe(1);
  });

  it("accepts a task-notification result when no background work remains", () => {
    const line = JSON.stringify({
      type: "result",
      origin: { kind: "task-notification" },
      result: "final result",
      num_turns: 3,
      is_error: false,
      session_id: "sess-1",
      total_cost_usd: 0.03,
      usage: { input_tokens: 120, output_tokens: 30 }
    });
    let captured: Parameters<Parameters<typeof parseStreamLine>[3]>[0] | null = null;
    let ackCalls = 0;
    const events = parseStreamLine(
      line,
      "t1",
      "s1",
      (info) => {
        captured = info;
      },
      () => {
        ackCalls += 1;
      },
      () => false
    );
    expect(events).toEqual([]);
    expect(ackCalls).toBe(0);
    expect(captured).toEqual({
      resumeCursor: "sess-1",
      resultText: "final result",
      usage: [],
      modelUsage: {},
      numTurns: 3,
      isError: false
    });
  });

  it("rejects task-notification results while background work remains", () => {
    const line = JSON.stringify({
      type: "result",
      origin: { kind: "task-notification" },
      num_turns: 3,
      is_error: false,
      session_id: "sess-1"
    });
    let doneCalls = 0;
    let ackCalls = 0;
    parseStreamLine(
      line,
      "t1",
      "s1",
      () => {
        doneCalls += 1;
      },
      () => {
        ackCalls += 1;
      },
      () => true
    );
    expect(doneCalls).toBe(0);
    expect(ackCalls).toBe(1);
  });

  it("finishes the turn for an ordinary result with no origin", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "sess-1",
      num_turns: 2,
      is_error: false
    });
    let doneCalls = 0;
    parseStreamLine(line, "t1", "s1", () => {
      doneCalls += 1;
    });
    expect(doneCalls).toBe(1);
  });
});

describe("parseClaudeTaskSystemLine", () => {
  it("lists the live roster entries of background_tasks_changed", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { type: "local_agent", id: "a202cd0fd545a319e" },
        { task_id: "t-2", run_id: "run-2" },
        "t-3"
      ]
    });
    expect(parseClaudeTaskSystemLine(line)).toStrictEqual({
      kind: "tasks",
      liveTaskEntries: [{ taskId: "a202cd0fd545a319e" }, { taskId: "t-2", runId: "run-2" }, { taskId: "t-3" }]
    });
  });

  it("leaves roster entries without an id out of the live entries", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_type: "local_agent" }, { task_id: "t-1", run_id: "" }, 7]
    });
    expect(parseClaudeTaskSystemLine(line)).toStrictEqual({
      kind: "tasks",
      liveTaskEntries: [{ taskId: "t-1" }]
    });
  });

  it("includes background shells in the live task snapshot", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "agent-1", task_type: "local_agent" },
        { task_id: "bb3lof10o", task_type: "local_bash", description: "sleep 20 && echo bgdone" },
        { type: "local_bash", task_id: "b-1" }
      ]
    });
    expect(parseClaudeTaskSystemLine(line)).toEqual({
      kind: "tasks",
      liveTaskEntries: [{ taskId: "agent-1" }, { taskId: "bb3lof10o" }, { taskId: "b-1" }]
    });
  });

  it("parses task_started ids, type and background flag", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "a202cd0fd545a319e",
      tool_use_id: "toolu_1",
      task_type: "local_agent",
      description: "Review the diff",
      subagent_type: "general-purpose",
      is_backgrounded: true,
      prompt: "Review PR #15"
    });
    expect(parseClaudeTaskSystemLine(line)).toEqual({
      kind: "started",
      taskId: "a202cd0fd545a319e",
      toolUseId: "toolu_1",
      taskType: "local_agent",
      background: true
    });
  });

  it("ignores task_progress, which carries nothing the task state needs", () => {
    const line = JSON.stringify({ type: "system", subtype: "task_progress", task_id: "t1", usage: { total_tokens: 1 } });
    expect(parseClaudeTaskSystemLine(line)).toBeNull();
  });

  it("parses task_updated status and end time", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "task_updated",
      task_id: "a202cd0fd545a319e",
      patch: { status: "completed", end_time: 1789499157135 }
    });
    expect(parseClaudeTaskSystemLine(line)).toEqual({
      kind: "updated",
      taskId: "a202cd0fd545a319e",
      status: "completed",
      endTime: 1789499157135
    });
  });

  it("parses task_notification status, summary and usage", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "a202cd0fd545a319e",
      tool_use_id: "toolu_1",
      status: "completed",
      summary: "PROBE-AGENT-DONE",
      usage: { total_tokens: 25500, tool_uses: 1, duration_ms: 6964 }
    });
    expect(parseClaudeTaskSystemLine(line)).toEqual({
      kind: "notification",
      taskId: "a202cd0fd545a319e",
      toolUseId: "toolu_1",
      status: "completed",
      summary: "PROBE-AGENT-DONE",
      usage: { tokens: 25500, toolUses: 1, durationMs: 6964 }
    });
  });

  it("carries the run id of real started, updated and notification lines", () => {
    const taskId = "a5fd6f29192d6b105";
    const runId = "0mvcd1zga-1ef0f9de";
    expect(parseClaudeTaskSystemLine(hooksProbeSystemLine("task_started", taskId))).toMatchObject({
      kind: "started",
      taskId,
      runId,
      background: true
    });
    expect(parseClaudeTaskSystemLine(hooksProbeSystemLine("task_updated", taskId))).toMatchObject({
      kind: "updated",
      taskId,
      runId,
      status: "completed"
    });
    expect(parseClaudeTaskSystemLine(hooksProbeSystemLine("task_notification", taskId))).toMatchObject({
      kind: "notification",
      taskId,
      runId,
      status: "completed"
    });
  });

  it("omits the run id when the line has none", () => {
    const line = JSON.stringify({ type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "failed" } });
    expect(parseClaudeTaskSystemLine(line)).toStrictEqual({ kind: "updated", taskId: "t1", status: "failed" });
  });

  it("takes each roster entry's run id from a real background_tasks_changed line", () => {
    const line = hooksProbeStreamLines().find((candidate) => {
      const msg = JSON.parse(candidate) as { subtype?: string; tasks?: unknown[] };
      return msg.subtype === "background_tasks_changed" && msg.tasks?.length === 2;
    });
    expect(line).toBeDefined();
    expect(parseClaudeTaskSystemLine(compactJson(line!))).toStrictEqual({
      kind: "tasks",
      liveTaskEntries: [
        { taskId: "a5fd6f29192d6b105", runId: "0mvcd1zga-1ef0f9de" },
        { taskId: "a74a561c109a552e8", runId: "0mvcd1zgk-b45a6052" }
      ]
    });
  });

  it("returns null for other system subtypes", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", tasks: [] });
    expect(parseClaudeTaskSystemLine(line)).toBeNull();
  });

  it("returns null when tasks is not an array", () => {
    const line = JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: {} });
    expect(parseClaudeTaskSystemLine(line)).toBeNull();
  });

  it("returns null for non-JSON input", () => {
    expect(parseClaudeTaskSystemLine("plain text")).toBeNull();
  });
});

describe("parseClaudeToolUseResult", () => {
  const userLine = (extra: Record<string, unknown>, content: unknown): string =>
    JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });

  const realUserLines = (): { line: string; hasResult: boolean; firstToolUseId?: string }[] =>
    hooksProbeStreamLines()
      .map((line) => ({
        line,
        msg: JSON.parse(line) as {
          type?: string;
          tool_use_result?: unknown;
          message?: { content?: { tool_use_id?: string }[] };
        }
      }))
      .filter(({ msg }) => msg.type === "user")
      .map(({ line, msg }) => ({
        line,
        hasResult: msg.tool_use_result !== undefined,
        firstToolUseId: msg.message?.content?.[0]?.tool_use_id
      }));

  const realLineFor = (toolUseId: string): string => {
    const found = realUserLines().find((entry) => entry.hasResult && entry.firstToolUseId === toolUseId);
    if (!found) throw new Error(`fixture tool result line not found for ${toolUseId}`);
    return found.line;
  };

  it("returns the structured result and tool use id of a real async launch line", () => {
    expect(parseClaudeToolUseResult(realLineFor("toolu_01RDYCbJfdYE4q12sgc97ETw"))).toMatchObject({
      toolUseId: "toolu_01RDYCbJfdYE4q12sgc97ETw",
      result: { isAsync: true, status: "async_launched", agentId: "a74a561c109a552e8", description: "sleeper" }
    });
  });

  it("returns the resumedAgentId of a real SendMessage resume line", () => {
    expect(parseClaudeToolUseResult(realLineFor("toolu_011NsVdGAR78VmzQ1hYsrnNm"))).toMatchObject({
      toolUseId: "toolu_011NsVdGAR78VmzQ1hYsrnNm",
      result: { resumedAgentId: "a5fd6f29192d6b105" }
    });
  });

  it("returns null for real user lines without a tool_use_result", () => {
    const withoutResult = realUserLines().filter((entry) => !entry.hasResult);
    expect(withoutResult.length).toBeGreaterThan(0);
    for (const { line } of withoutResult) expect(parseClaudeToolUseResult(line)).toBeNull();
  });

  it("uses the first tool_result block of the line", () => {
    const line = userLine({ tool_use_result: { status: "ok" } }, [
      { type: "text", text: "noise" },
      { type: "tool_result", tool_use_id: "tu1", content: "a" },
      { type: "tool_result", tool_use_id: "tu2", content: "b" }
    ]);
    expect(parseClaudeToolUseResult(line)).toStrictEqual({ toolUseId: "tu1", result: { status: "ok" } });
  });

  it("returns null when tool_use_result is not a plain object", () => {
    const blocks = [{ type: "tool_result", tool_use_id: "tu1", content: "a" }];
    expect(parseClaudeToolUseResult(userLine({ tool_use_result: "text" }, blocks))).toBeNull();
    expect(parseClaudeToolUseResult(userLine({ tool_use_result: ["a"] }, blocks))).toBeNull();
    expect(parseClaudeToolUseResult(userLine({ tool_use_result: null }, blocks))).toBeNull();
  });

  it("returns null without a usable tool_result block", () => {
    const result = { tool_use_result: { status: "ok" } };
    expect(parseClaudeToolUseResult(userLine(result, "plain string content"))).toBeNull();
    expect(parseClaudeToolUseResult(userLine(result, [{ type: "text", text: "x" }]))).toBeNull();
    expect(parseClaudeToolUseResult(userLine(result, [{ type: "tool_result", content: "a" }]))).toBeNull();
    expect(parseClaudeToolUseResult(userLine(result, [{ type: "tool_result", tool_use_id: "  ", content: "a" }]))).toBeNull();
  });

  it("returns null for non-user lines and bad JSON", () => {
    expect(
      parseClaudeToolUseResult(
        JSON.stringify({ type: "assistant", tool_use_result: { a: 1 }, message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } })
      )
    ).toBeNull();
    expect(parseClaudeToolUseResult('{"type":"user","tool_use_result":')).toBeNull();
    expect(parseClaudeToolUseResult("plain tool_use_result text")).toBeNull();
  });
});

describe("parseClaudeSystemInit", () => {
  it("captures the terminal-only slash command names", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      terminal_slash_commands: ["doctor", "color", "reload-plugins"]
    });
    expect(parseClaudeSystemInit(line)).toEqual({
      terminalSlashCommands: ["doctor", "color", "reload-plugins"]
    });
  });

  it("captures the skill names when the CLI reports them", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", skills: ["plan", 7, "ndk:debug"] });
    expect(parseClaudeSystemInit(line)).toEqual({ terminalSlashCommands: [], skills: ["plan", "ndk:debug"] });
  });

  it("captures the model when present", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-4-5" });
    expect(parseClaudeSystemInit(line)).toEqual({ terminalSlashCommands: [], model: "claude-haiku-4-5" });
  });

  it("captures the reported permission mode only when non-empty", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", permissionMode: "manual" });
    expect(parseClaudeSystemInit(line)).toEqual({ terminalSlashCommands: [], permissionMode: "manual" });
    expect(parseClaudeSystemInit(JSON.stringify({ type: "system", subtype: "init", permissionMode: "" }))).toEqual({
      terminalSlashCommands: []
    });
  });

  it("tolerates a missing or garbage terminal_slash_commands field", () => {
    expect(parseClaudeSystemInit(JSON.stringify({ type: "system", subtype: "init" }))).toEqual({
      terminalSlashCommands: []
    });
    expect(
      parseClaudeSystemInit(JSON.stringify({ type: "system", subtype: "init", terminal_slash_commands: "nope" }))
    ).toEqual({ terminalSlashCommands: [] });
  });

  it("returns null for other system lines and non-JSON input", () => {
    expect(parseClaudeSystemInit(JSON.stringify({ type: "system", subtype: "background_tasks_changed" }))).toBeNull();
    expect(parseClaudeSystemInit(JSON.stringify({ type: "assistant" }))).toBeNull();
    expect(parseClaudeSystemInit("plain text")).toBeNull();
  });
});

describe("parseClaudeCompactBoundary", () => {
  it("parses the compact metadata from a boundary line", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-1",
      compact_metadata: {
        trigger: "manual",
        pre_tokens: 633409,
        post_tokens: 16048,
        cumulative_dropped_tokens: 617361,
        duration_ms: 80261
      }
    });
    expect(parseClaudeCompactBoundary(line)).toEqual({
      trigger: "manual",
      preTokens: 633409,
      postTokens: 16048,
      droppedTokens: 617361,
      durationMs: 80261
    });
  });

  it("keeps auto trigger and tolerates missing optional counts", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 12000 }
    });
    expect(parseClaudeCompactBoundary(line)).toEqual({ trigger: "auto", preTokens: 12000 });
  });

  it("ignores unknown triggers and non-numeric fields", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "weird", pre_tokens: "lots", post_tokens: 10 }
    });
    expect(parseClaudeCompactBoundary(line)).toEqual({ postTokens: 10 });
  });

  it("returns null without usable metadata, for other subtypes, and for non-JSON", () => {
    expect(
      parseClaudeCompactBoundary(JSON.stringify({ type: "system", subtype: "compact_boundary" }))
    ).toBeNull();
    expect(
      parseClaudeCompactBoundary(JSON.stringify({ type: "system", subtype: "status", compact_result: "success" }))
    ).toBeNull();
    expect(parseClaudeCompactBoundary("plain text")).toBeNull();
  });
});

describe("parseTaskNotificationUsage", () => {
  it("extracts subagent tokens, tool uses and duration", () => {
    const text =
      "<usage><subagent_tokens>136099</subagent_tokens><tool_uses>12</tool_uses><duration_ms>287602</duration_ms></usage>";
    expect(parseTaskNotificationUsage(text)).toEqual({ tokens: 136099, toolUses: 12, durationMs: 287602 });
  });

  it("returns undefined when no usage block is present", () => {
    expect(parseTaskNotificationUsage("no usage here")).toBeUndefined();
  });
});

describe("attributeClaudeSubagentEvent", () => {
  it("links SendMessage calls after a Task launch result", () => {
    const agentByCall = new Map<string, string>();
    attributeClaudeSubagentEvent(
      {
        type: "tool.result",
        turnId: "t1",
        toolCallId: "task-call",
        output: "Async agent launched successfully.\nagentId: a202cd0fd545a319e",
        isError: false
      },
      agentByCall
    );
    expect(
      attributeClaudeSubagentEvent(
        {
          type: "tool.call",
          turnId: "t1",
          toolCallId: "send-call",
          name: "SendMessage",
          input: { to: "a202cd0fd545a319e", message: "Check this" }
        },
        agentByCall
      )
    ).toEqual({
      type: "tool.call",
      turnId: "t1",
      toolCallId: "send-call",
      name: "SendMessage",
      input: { to: "a202cd0fd545a319e", message: "Check this" },
      parentToolCallId: "task-call"
    });
  });

  it("leaves unrelated and unknown-recipient calls unchanged", () => {
    const agentByCall = new Map([["task-call", "a202cd0fd545a319e"]]);
    const read = {
      type: "tool.call" as const,
      turnId: "t1",
      toolCallId: "read-call",
      name: "Read",
      input: { path: "a.ts" }
    };
    const send = {
      type: "tool.call" as const,
      turnId: "t1",
      toolCallId: "send-call",
      name: "SendMessage",
      input: { to: "unknown" }
    };
    expect(attributeClaudeSubagentEvent(read, agentByCall)).toBe(read);
    expect(attributeClaudeSubagentEvent(send, agentByCall)).toBe(send);
  });
});

describe("parseClaudeControlRequest", () => {
  const requestLine = (
    tool_name: string,
    questions: unknown,
    request_id = "req-1"
  ): string =>
    JSON.stringify({
      type: "control_request",
      request_id,
      request: { subtype: "can_use_tool", tool_name, input: { questions }, tool_use_id: "tu-9" }
    });

  it("parses a can_use_tool control request for AskUserQuestion", () => {
    const control = parseClaudeControlRequest(
      requestLine("AskUserQuestion", [
        {
          question: "Preferred color?",
          header: "Color",
          options: [
            { label: "Red", description: "Red" },
            { label: "Blue", description: "Blue" }
          ],
          multiSelect: false
        }
      ])
    );
    expect(control).not.toBeNull();
    expect(control!.requestId).toBe("req-1");
    expect(control!.toolName).toBe("AskUserQuestion");
    expect(control!.toolUseId).toBe("tu-9");
  });

  it("parses control requests from other tools but maps none of them to questions", () => {
    expect(parseClaudeControlRequest(requestLine("Bash", []))).toMatchObject({ requestId: "req-1", toolName: "Bash" });
    expect(parseClaudeControlRequest("not json")).toBeNull();
    expect(
      parseClaudeControlRequest(JSON.stringify({ type: "control_request", request_id: "req-1", request: { subtype: "other", tool_name: "AskUserQuestion" } }))
    ).toBeNull();
    expect(parseClaudeControlRequest(JSON.stringify({ type: "control_request" }))).toBeNull();
  });

  it("maps a control request onto the renderer QuestionRequest", () => {
    const control = parseClaudeControlRequest(
      requestLine("AskUserQuestion", [
        { question: "Preferred color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false },
        { question: "Which extras?", options: [{ label: "Lint" }, { label: "Docs" }], multiSelect: true }
      ])
    );
    expect(control).not.toBeNull();
    const request = claudeQuestionRequest(control!, "t1");
    expect(request).toEqual({
      requestId: "req-1",
      turnId: "t1",
      questions: [
        { question: "Preferred color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false, allowCustom: true },
        { question: "Which extras?", options: [{ label: "Lint" }, { label: "Docs" }], multiSelect: true, allowCustom: true }
      ]
    });
  });

  it("drops entries missing question text, keeps empty option lists", () => {
    const control = parseClaudeControlRequest(
      requestLine("AskUserQuestion", [{ question: "ok?", options: [] }, "junk", { header: "Color", options: [{ label: "Red" }] }])
    );
    expect(control).not.toBeNull();
    const request = claudeQuestionRequest(control!, "t1");
    expect(request?.questions.map((q) => q.question)).toEqual(["ok?"]);
    expect(request?.questions[0].options).toEqual([]);
  });
});

describe("claudeControlResponse", () => {
  it("serializes the answers over the original questions", () => {
    const questions = [{ question: "Preferred color?", options: [{ label: "Red" }, { label: "Blue" }] }];
    const line = claudeControlResponse("req-1", { questions }, { "Preferred color?": "Red" });
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: { questions, answers: { "Preferred color?": "Red" } } }
      }
    });
  });

  it("serializes deny responses", () => {
    const parsed = JSON.parse(claudeDenyResponse("req-2", "denied"));
    expect(parsed.response.request_id).toBe("req-2");
    expect(parsed.response.response).toEqual({ behavior: "deny", message: "denied" });
  });
});

describe("claudeApprovalRequest", () => {
  it("maps Bash to a command approval with first-line title and full command details", () => {
    const request = claudeApprovalRequest(
      { requestId: "req-bash", toolName: "Bash", input: { command: "npm run test\nnpm run lint" } },
      "t1",
      "/repo"
    );
    expect(request).toMatchObject({
      requestId: "req-bash",
      kind: "command",
      title: "npm run test",
      toolName: "Bash",
      cwd: "/repo",
      decisions: ["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]
    });
    expect(request.details).toContain("npm run test\nnpm run lint");
    expect(request.details).toContain("cwd: /repo");
  });

  it("maps PowerShell case-insensitively to a command approval", () => {
    const request = claudeApprovalRequest(
      { requestId: "req-ps", toolName: "powershell", input: { command: "Get-ChildItem" } },
      "t1"
    );
    expect(request.kind).toBe("command");
    expect(request.title).toBe("Get-ChildItem");
  });

  it("maps Edit/Write/MultiEdit to fileChange approvals naming the file", () => {
    for (const toolName of ["Edit", "Write", "MultiEdit"]) {
      const request = claudeApprovalRequest(
        { requestId: `req-${toolName}`, toolName, input: { file_path: "src/a.ts" } },
        "t1"
      );
      expect(request.kind).toBe("fileChange");
      expect(request.title).toContain("src/a.ts");
      expect(request.decisions).toEqual(["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]);
    }
  });

  it("maps unknown tools to permissions approvals with truncated JSON details", () => {
    const request = claudeApprovalRequest(
      { requestId: "req-web", toolName: "WebFetch", input: { url: "https://example.com", prompt: "summarize" } },
      "t1"
    );
    expect(request.kind).toBe("permissions");
    expect(request.title).toBe("WebFetch");
    expect(request.details).toContain("https://example.com");
  });

  it("tolerates missing input and unknown tools without crashing", () => {
    expect(claudeApprovalRequest({ requestId: "r1", toolName: "Bash", input: null }, "t1").kind).toBe("command");
    expect(claudeApprovalRequest({ requestId: "r2", toolName: "Bash", input: null }, "t1").title).toBe("Bash");
    expect(
      claudeApprovalRequest({ requestId: "r3", toolName: "SomeFutureTool", input: null }, "t1")
    ).toMatchObject({ kind: "permissions", title: "SomeFutureTool" });
    expect(
      claudeApprovalRequest({ requestId: "r4", toolName: "Edit", input: { nonsense: true } }, "t1").title
    ).toBe("Edit");
  });

  it("truncates very long details", () => {
    const request = claudeApprovalRequest(
      { requestId: "r5", toolName: "Bash", input: { command: `echo hi\n${"x".repeat(5000)}` } },
      "t1"
    );
    expect(request.details!.length).toBeLessThan(5000);
    expect(request.details).toContain("[len=");
  });
});

describe("claudeAllowResponse", () => {
  it("serializes an allow carrying the original input", () => {
    const input = { command: "npm run test" };
    const parsed = JSON.parse(claudeAllowResponse("req-1", input));
    expect(parsed).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: input }
      }
    });
  });

  it("falls back to an empty object for missing input", () => {
    const parsed = JSON.parse(claudeAllowResponse("req-1", null));
    expect(parsed.response.response).toEqual({ behavior: "allow", updatedInput: {} });
  });
});

describe("buildClaudeAllowRule", () => {
  it("returns the bare tool name regardless of input", () => {
    expect(buildClaudeAllowRule("Bash", { command: "rm -rf /" })).toBe("Bash");
    expect(buildClaudeAllowRule("Edit", { file_path: "src/a.ts" })).toBe("Edit");
    expect(buildClaudeAllowRule("  Read  ", null)).toBe("Read");
  });
});
