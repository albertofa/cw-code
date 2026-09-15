import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeSendMessages, extractAgentId, findSidecarModel, foldTaskNotifications, parseClaudeTranscriptLine, readSidecarAgent, toEpochMs } from "./claudeHistory.js";
import type { HistoryMessage } from "@cw-code/contracts";

function toolMessage(partial: Partial<HistoryMessage> & { id: string }): HistoryMessage {
  return { role: "tool", text: "", turnId: "t1", ...partial };
}

describe("parseClaudeTranscriptLine", () => {
  it("maps string user content to a user message", () => {
    const out = parseClaudeTranscriptLine({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "hello" }
    });
    expect(out).toEqual([{ id: "u1", role: "user", text: "hello", turnId: "u1" }]);
  });

  it("skips meta and sidechain lines", () => {
    expect(
      parseClaudeTranscriptLine({ type: "user", isMeta: true, message: { content: "x" } })
    ).toEqual([]);
    expect(
      parseClaudeTranscriptLine({ type: "assistant", isSidechain: true, message: { content: [] } })
    ).toEqual([]);
  });

  it("maps assistant text and tool_use blocks", () => {
    const out = parseClaudeTranscriptLine({
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "tu1", name: "Read", input: { path: "a.ts" } },
          { type: "thinking", thinking: "..." }
        ]
      }
    });
    expect(out).toEqual([
      { id: "a1-a0", role: "assistant", text: "looking", turnId: "a1" },
      {
        id: "tu1",
        role: "tool",
        text: 'Read {"path":"a.ts"}',
        turnId: "a1",
        toolName: "Read"
      }
    ]);
  });

  it("attaches normalized todos to TodoWrite tool_use messages", () => {
    const input = {
      todos: [
        { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
        { content: "Ship it", status: "completed", activeForm: "Shipping it" }
      ]
    };
    const out = parseClaudeTranscriptLine({
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "TodoWrite", input }]
      }
    });
    expect(out).toEqual([
      {
        id: "tu1",
        role: "tool",
        text: `TodoWrite ${JSON.stringify(input)}`,
        turnId: "a1",
        toolName: "TodoWrite",
        todos: [
          { content: "Write tests", status: "in_progress" },
          { content: "Ship it", status: "completed" }
        ]
      }
    ]);
  });

  it("omits the todos field for non-todo tool calls", () => {
    const out = parseClaudeTranscriptLine({
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "a.ts" } }]
      }
    });
    expect(out).toHaveLength(1);
    expect("todos" in out[0]).toBe(false);
  });

  it("maps tool_result blocks to tool messages", () => {
    const out = parseClaudeTranscriptLine({
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }]
      }
    });
    expect(out).toEqual([
      { id: "tu1-r", role: "tool", text: "file contents", turnId: "u2", toolName: "result", isError: false }
    ]);
  });

  it("falls back to synthetic ids when tool_use_id is missing", () => {
    const out = parseClaudeTranscriptLine({
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "file contents" }]
      }
    });
    expect(out).toEqual([
      { id: "u2-t0", role: "tool", text: "file contents", turnId: "u2", toolName: "result", isError: false }
    ]);
  });

  it("carries transcript timestamps onto messages", () => {
    const out = parseClaudeTranscriptLine({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-09-10T15:14:59.007Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Task", input: { description: "x" } }]
      }
    });
    expect(out).toEqual([
      {
        id: "tu1",
        role: "tool",
        text: 'Task {"description":"x"}',
        turnId: "a1",
        toolName: "Task",
        timestamp: Date.parse("2026-09-10T15:14:59.007Z")
      }
    ]);
  });

  it("omits timestamps when the line has none", () => {
    const out = parseClaudeTranscriptLine({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] }
    });
    expect(out).toEqual([{ id: "a1-a0", role: "assistant", text: "hi", turnId: "a1" }]);
  });

  it("emits task notifications as tool messages", () => {
    const out = parseClaudeTranscriptLine({
      type: "user",
      uuid: "u9",
      timestamp: "2026-09-10T15:19:01.272Z",
      message: {
        role: "user",
        content: "<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>tu1</tool-use-id>\n</task-notification>"
      }
    });
    expect(out).toEqual([
      {
        id: "u9-n",
        role: "tool",
        text: "<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>tu1</tool-use-id>\n</task-notification>",
        turnId: "u9",
        toolName: "task-notification",
        timestamp: Date.parse("2026-09-10T15:19:01.272Z")
      }
    ]);
  });

  it("keeps ordinary user text that mentions task notifications", () => {
    const text = "Why does <task-notification> appear here?";
    expect(
      parseClaudeTranscriptLine({ type: "user", uuid: "u10", message: { role: "user", content: text } })
    ).toEqual([{ id: "u10", role: "user", text, turnId: "u10" }]);
  });
});

describe("toEpochMs", () => {
  it("parses ISO strings and epoch seconds or milliseconds", () => {
    expect(toEpochMs("2026-09-10T15:14:59.007Z")).toBe(Date.parse("2026-09-10T15:14:59.007Z"));
    expect(toEpochMs(1757517299)).toBe(1757517299000);
    expect(toEpochMs(1757517299007)).toBe(1757517299007);
  });

  it("rejects missing or invalid values", () => {
    expect(toEpochMs(undefined)).toBeUndefined();
    expect(toEpochMs("not a date")).toBeUndefined();
    expect(toEpochMs(Number.NaN)).toBeUndefined();
  });
});

describe("foldTaskNotifications", () => {
  const notif = (result: string, status = "completed", ts = 9000) =>
    toolMessage({
      id: "n1",
      toolName: "task-notification",
      timestamp: ts,
      text: `<task-notification>\n<task-id>aa11</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>${status}</status>\n<result>${result}</result>`
    });

  it("folds the result into the parent call and drops the notification", () => {
    const out = foldTaskNotifications([
      toolMessage({ id: "tu1", toolName: "Task", text: "Task call" }),
      toolMessage({ id: "tu1-r", toolName: "result", text: "Async agent launched", timestamp: 2000, isError: true }),
      notif("Real report here")
    ]);
    expect(out.map((m) => m.id)).toEqual(["tu1", "tu1-r"]);
    expect(out[1].text).toBe("Real report here");
    expect(out[1].timestamp).toBe(9000);
    expect(out[1].isError).toBe(false);
  });

  it("drops an orphaned notification", () => {
    const out = foldTaskNotifications([notif("Real report here")]);
    expect(out).toEqual([]);
  });

  it("turns the notification into a result when the acknowledgement is missing", () => {
    const out = foldTaskNotifications([
      toolMessage({ id: "tu1", toolName: "Task", text: "Task call", turnId: "turn-1" }),
      notif("Real report here")
    ]);
    expect(out).toEqual([
      toolMessage({ id: "tu1", toolName: "Task", text: "Task call", turnId: "turn-1" }),
      toolMessage({
        id: "tu1-r",
        toolName: "result",
        text: "Real report here",
        turnId: "turn-1",
        timestamp: 9000,
        isError: false
      })
    ]);
  });

  it("last notification wins and non-completed status flags errors", () => {
    const out = foldTaskNotifications([
      toolMessage({ id: "tu1-r", toolName: "result", text: "ack" }),
      notif("first", "completed", 9000),
      toolMessage({ id: "n2", toolName: "task-notification", timestamp: 9500, text: notif("second", "failed", 9500).text })
    ]);
    expect(out.map((m) => m.id)).toEqual(["tu1-r"]);
    expect(out[0].text).toBe("second");
    expect(out[0].timestamp).toBe(9500);
    expect(out[0].isError).toBe(true);
  });
});

describe("attributeSendMessages", () => {
  const agents = new Map([["tu1", "aa11"]]);

  it("links SendMessage calls to their parent Task call", () => {
    const messages = [
      toolMessage({ id: "sm1", toolName: "SendMessage", text: 'SendMessage {"to":"aa11","message":"hi"}' }),
      toolMessage({ id: "b1", toolName: "Bash", text: "ls" })
    ];
    attributeSendMessages(messages, agents);
    expect(messages[0].parentToolCallId).toBe("tu1");
    expect(messages[1].parentToolCallId).toBeUndefined();
  });

  it("leaves unknown agents and existing links untouched", () => {
    const messages = [
      toolMessage({ id: "sm1", toolName: "SendMessage", text: 'SendMessage {"to":"zzzz"}' }),
      toolMessage({ id: "sm2", toolName: "SendMessage", text: "truncated", parentToolCallId: "tu9" })
    ];
    attributeSendMessages(messages, agents);
    expect(messages[0].parentToolCallId).toBeUndefined();
    expect(messages[1].parentToolCallId).toBe("tu9");
  });

  it("does nothing without known agents", () => {
    const messages = [toolMessage({ id: "sm1", toolName: "SendMessage", text: '{"to":"aa11"}' })];
    attributeSendMessages(messages, new Map());
    expect(messages[0].parentToolCallId).toBeUndefined();
  });
});

describe("extractAgentId", () => {
  it("finds the agent id in launch metadata", () => {
    expect(
      extractAgentId("Async agent launched successfully.\nagentId: a202cd0fd545a319e (internal ID)")
    ).toBe("a202cd0fd545a319e");
  });

  it("returns undefined when absent", () => {
    expect(extractAgentId("All done.")).toBeUndefined();
  });
});

describe("findSidecarModel", () => {
  it("reads the model from the subagent transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-sidecar-"));
    mkdirSync(join(dir, "subagents"));
    writeFileSync(
      join(dir, "subagents", "agent-add0c7136f774d68d.jsonl"),
      '{"type":"user"}\n{"type":"assistant","message":{"model":"claude-sonnet-5"}}\n'
    );
    expect(findSidecarModel(dir, "add0c7136f774d68d")).toBe("claude-sonnet-5");
  });

  it("returns undefined for missing files or bad ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-sidecar-"));
    expect(findSidecarModel(dir, "add0c7136f774d68d")).toBeUndefined();
    expect(findSidecarModel(dir, "not-an-id")).toBeUndefined();
  });
});

describe("readSidecarAgent", () => {
  it("extracts model and tool activity with results joined", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-sidecar-"));
    mkdirSync(join(dir, "subagents"));
    writeFileSync(
      join(dir, "subagents", "agent-add0c7136f774d68d.jsonl"),
      [
        '{"type":"user","timestamp":"2026-09-10T15:15:27.537Z"}',
        '{"type":"assistant","timestamp":"2026-09-10T15:15:31.200Z","message":{"model":"claude-sonnet-5","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"path":"a.ts"}}]}}',
        '{"type":"user","timestamp":"2026-09-10T15:15:32.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"file!"}]}}',
        '{"type":"assistant","timestamp":"2026-09-10T15:15:33.000Z","message":{"content":[{"type":"tool_use","id":"tu2","name":"Bash","input":{"command":"ls"}}]}}'
      ].join("\n")
    );
    const agent = readSidecarAgent(dir, "add0c7136f774d68d");
    expect(agent?.model).toBe("claude-sonnet-5");
    expect(agent?.total).toBe(2);
    expect(agent?.items).toHaveLength(2);
    expect(agent?.items[0]).toEqual({
      id: "tu1",
      name: "Read",
      input: { path: "a.ts" },
      timestamp: Date.parse("2026-09-10T15:15:31.200Z"),
      output: "file!",
      isError: false,
      completedAt: Date.parse("2026-09-10T15:15:32.000Z")
    });
    expect(agent?.items[1].output).toBeUndefined();
  });

  it("truncates long input strings", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-sidecar-"));
    mkdirSync(join(dir, "subagents"));
    writeFileSync(
      join(dir, "subagents", "agent-add0c7136f774d68d.jsonl"),
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"a.ts","content":"${"x".repeat(2000)}"}}]}}\n`
    );
    const agent = readSidecarAgent(dir, "add0c7136f774d68d");
    const content = (agent?.items[0].input as { content?: string }).content ?? "";
    expect(content.length).toBeLessThan(2000);
    expect(content.endsWith("…")).toBe(true);
  });

  it("extracts effort and deduplicates usage by message id", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-sidecar-"));
    mkdirSync(join(dir, "subagents"));
    writeFileSync(
      join(dir, "subagents", "agent-add0c7136f774d68d.jsonl"),
      [
        '{"type":"assistant","effort":"low","perTurnEffort":"high","message":{"id":"msg1","usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":5},"content":[{"type":"text","text":"first"}]}}',
        '{"type":"assistant","message":{"id":"msg1","usage":{"input_tokens":120,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":10},"content":[{"type":"text","text":"repeated"}]}}',
        '{"type":"user","message":{"content":"<total_tokens>999999</total_tokens>"}}',
        '{"type":"assistant","message":{"id":"msg2","usage":{"input_tokens":10,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":5},"content":[{"type":"text","text":"second"}]}}'
      ].join("\n")
    );

    const agent = readSidecarAgent(dir, "add0c7136f774d68d");
    expect(agent?.effort).toBe("high");
    expect(agent?.totalTokens).toBe(200);
  });

  it("returns undefined for missing files or bad ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-sidecar-"));
    expect(readSidecarAgent(dir, "add0c7136f774d68d")).toBeUndefined();
    expect(readSidecarAgent(dir, "not-an-id")).toBeUndefined();
  });
});
