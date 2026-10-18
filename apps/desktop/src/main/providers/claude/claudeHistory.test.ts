import { describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignReasoningDurations, attributeSendMessages, extractAgentId, findSidecarModel, parseClaudeTranscriptLine, readClaudeHistoryFile, readClaudeTaskResult, readSidecarAgent, toEpochMs } from "./claudeHistory.js";
import type { HistoryMessage, TaskSnapshot } from "@cw-code/contracts";

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

  it("maps a compact boundary line to a system marker with its metadata", () => {
    const out = parseClaudeTranscriptLine({
      type: "system",
      subtype: "compact_boundary",
      uuid: "b1",
      logicalParentUuid: "u1",
      timestamp: "2026-09-25T10:00:00.000Z",
      compactMetadata: {
        trigger: "manual",
        preTokens: 633409,
        postTokens: 16048,
        cumulativeDroppedTokens: 617361,
        durationMs: 80261
      }
    });
    expect(out).toEqual([
      {
        id: "b1",
        role: "system",
        text: "Context compacted",
        turnId: "u1",
        compaction: {
          trigger: "manual",
          preTokens: 633409,
          postTokens: 16048,
          droppedTokens: 617361,
          durationMs: 80261
        },
        timestamp: Date.parse("2026-09-25T10:00:00.000Z")
      }
    ]);
  });

  it("skips the compact summary body and unknown system lines", () => {
    expect(
      parseClaudeTranscriptLine({
        type: "user",
        uuid: "s1",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: "user", content: "This session is being continued from a previous conversation..." }
      })
    ).toEqual([]);
    expect(parseClaudeTranscriptLine({ type: "system", subtype: "status", uuid: "x" })).toEqual([]);
  });

  it("maps assistant text and tool_use blocks", () => {
    const out = parseClaudeTranscriptLine({
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "tu1", name: "Read", input: { path: "a.ts" } }
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

  it("maps thinking blocks to reasoning messages and skips empty ones", () => {
    const out = parseClaudeTranscriptLine({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-09-09T11:21:21.422Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "thinking", thinking: "weighing options" }
        ]
      }
    });
    expect(out).toEqual([
      {
        id: "a1-th1",
        role: "reasoning",
        text: "weighing options",
        turnId: "a1",
        timestamp: 1788952881422
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
      {
        id: "tu1-r",
        role: "tool",
        text: "file contents",
        turnId: "u2",
        toolName: "result",
        isError: false,
        toolOutputEmpty: false
      }
    ]);
  });

  it("marks a shell result that produced nothing as empty", () => {
    const out = parseClaudeTranscriptLine({
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "(Bash completed with no output)" }]
      }
    });
    expect(out[0].toolOutputEmpty).toBe(true);
  });

  it("computes emptiness from the full result, not the truncated display slice", () => {
    const padded = `${" ".repeat(4100)}real output`;
    const out = parseClaudeTranscriptLine({
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: padded }]
      }
    });
    expect(out[0].text).toHaveLength(4000);
    expect(out[0].toolOutputEmpty).toBe(false);
  });

  it("never marks a failed result as empty", () => {
    const out = parseClaudeTranscriptLine({
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "", is_error: true }]
      }
    });
    expect(out[0].toolOutputEmpty).toBe(false);
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
      {
        id: "u2-t0",
        role: "tool",
        text: "file contents",
        turnId: "u2",
        toolName: "result",
        isError: false,
        toolOutputEmpty: false
      }
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

  it("yields no message for a task notification user string", () => {
    const out = parseClaudeTranscriptLine({
      type: "user",
      uuid: "u9",
      timestamp: "2026-09-10T15:19:01.272Z",
      message: {
        role: "user",
        content: "<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>tu1</tool-use-id>\n</task-notification>"
      }
    });
    expect(out).toEqual([]);
  });

  it("keeps ordinary user text that mentions task notifications", () => {
    const text = "Why does <task-notification> appear here?";
    expect(
      parseClaudeTranscriptLine({ type: "user", uuid: "u10", message: { role: "user", content: text } })
    ).toEqual([{ id: "u10", role: "user", text, turnId: "u10" }]);
  });

  it("renders a slash-command transcript line as /name args", () => {
    const text =
      "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>";
    expect(
      parseClaudeTranscriptLine({ type: "user", uuid: "u11", message: { role: "user", content: text } })
    ).toEqual([{ id: "u11", role: "user", text: "/context", turnId: "u11" }]);
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

describe("assignReasoningDurations", () => {
  it("stamps the span from first thinking line to the last block of the same message", () => {
    const first: HistoryMessage = { id: "a-th0", role: "reasoning", text: "step one", turnId: "a" };
    const second: HistoryMessage = { id: "a-th1", role: "reasoning", text: "step two", turnId: "a" };
    assignReasoningDurations(
      new Map([["msg_1", [first, second]]]),
      new Map([["msg_1", 1000]]),
      new Map([["msg_1", 4200]])
    );
    expect(first.reasoningMs).toBe(3200);
    expect(second.reasoningMs).toBe(3200);
  });

  it("leaves durations unset when the end stamp is missing", () => {
    const only: HistoryMessage = { id: "a-th0", role: "reasoning", text: "step", turnId: "a" };
    assignReasoningDurations(new Map([["msg_1", [only]]]), new Map([["msg_1", 1000]]), new Map());
    expect(only.reasoningMs).toBeUndefined();
  });
});

const FIXTURES = fileURLToPath(new URL("./__fixtures__/tasks/", import.meta.url));

function fixtureSession(name: string): { file: string; cursor: string } {
  const source = join(FIXTURES, name);
  const transcript = readFileSync(join(source, "transcript.jsonl"), "utf8");
  const cursor = (JSON.parse(transcript.slice(0, transcript.indexOf("\n"))) as { sessionId: string }).sessionId;
  const dir = mkdtempSync(join(tmpdir(), "cw-claude-history-"));
  const file = join(dir, `${cursor}.jsonl`);
  writeFileSync(file, transcript);
  cpSync(join(source, "subagents"), join(dir, cursor, "subagents"), { recursive: true });
  return { file, cursor };
}

const CURSOR = "11111111-2222-3333-4444-555555555555";
const AGENT_ID = "abcdef0123456789";
const T0 = Date.parse("2026-10-17T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function syntheticSession(lines: object[], metas: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-claude-history-"));
  const file = join(dir, `${CURSOR}.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  const names = Object.keys(metas);
  if (names.length > 0) {
    mkdirSync(join(dir, CURSOR, "subagents"), { recursive: true });
    for (const name of names) writeFileSync(join(dir, CURSOR, "subagents", name), metas[name]);
  }
  return file;
}

function agentCall(id: string, offset: number, input: Record<string, unknown>): object {
  return {
    type: "assistant",
    uuid: `a-${id}`,
    timestamp: iso(offset),
    message: { id: `msg-${id}`, role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input }] }
  };
}

function toolResult(id: string, offset: number, text: string, toolUseResult: Record<string, unknown>): object {
  return {
    type: "user",
    uuid: `r-${id}`,
    timestamp: iso(offset),
    toolUseResult,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] }
  };
}

function launchAck(id: string, offset: number): object {
  return toolResult(id, offset, `Async agent launched successfully.\nagentId: ${AGENT_ID} (internal ID)`, {
    isAsync: true,
    status: "async_launched",
    agentId: AGENT_ID
  });
}

function assistantText(uuid: string, offset: number, text: string): object {
  return { type: "assistant", uuid, timestamp: iso(offset), message: { role: "assistant", content: [{ type: "text", text }] } };
}

function queuedNotification(toolUseId: string, offset: number, body: string, taskId = AGENT_ID): object {
  return {
    type: "attachment",
    uuid: `q-${toolUseId}`,
    timestamp: iso(offset),
    isSidechain: false,
    attachment: {
      type: "queued_command",
      prompt: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n${body}\n</task-notification>`,
      commandMode: "task-notification",
      runId: "run-1"
    }
  };
}

function taskOf(messages: HistoryMessage[], id: string): TaskSnapshot | undefined {
  return messages.find((m) => m.id === id)?.task;
}

describe("readClaudeHistoryFile", () => {
  const PONG_CALL = "toolu_01DaQjvfNQDvgKAiv1WcJNYS";
  const SLEEPER_CALL = "toolu_01RDYCbJfdYE4q12sgc97ETw";
  const HANDBACK_CALL = "toolu_019cYvRiA4JYiUUSq18cKuos";
  const BACKGROUND_INPUT = { description: "bg", prompt: "work", run_in_background: true };

  it("closes the resumed pong agent on its second run and the stopped sleeper from a real transcript", () => {
    const { file, cursor } = fixtureSession("hooks-probe");
    const messages = readClaudeHistoryFile(file, cursor);

    expect(taskOf(messages, PONG_CALL)).toMatchObject({
      cliTaskId: "a5fd6f29192d6b105",
      kind: "agent",
      background: true,
      state: "completed",
      endReason: "cli",
      runCount: 2,
      startedAt: Date.parse("2026-10-17T12:16:29.492Z"),
      endedAt: Date.parse("2026-10-17T12:16:33.085Z"),
      output: "PONG2",
      usage: { tokens: 28111, toolUses: 2, durationMs: 8936 }
    });
    expect(taskOf(messages, SLEEPER_CALL)).toMatchObject({
      cliTaskId: "a74a561c109a552e8",
      state: "stopped",
      endReason: "cli",
      runCount: 1,
      output: 'Agent "sleeper" was stopped by Claude'
    });
  });

  it("keeps the launch acknowledgement on the result message and emits no notification messages", () => {
    const { file, cursor } = fixtureSession("hooks-probe");
    const messages = readClaudeHistoryFile(file, cursor);

    expect(messages.find((m) => m.id === `${PONG_CALL}-r`)?.text.startsWith("Async agent launched")).toBe(true);
    expect(messages.find((m) => m.id === `${PONG_CALL}-r`)?.task).toBeUndefined();
    expect(messages.some((m) => m.toolName === "task-notification" || m.text.startsWith("<task-notification>"))).toBe(false);
    expect(messages.find((m) => m.toolName === "SendMessage")).toMatchObject({ parentToolCallId: PONG_CALL });
    expect(messages.find((m) => m.toolName === "SendMessage")?.task).toBeUndefined();
  });

  it("completes the handback agent with the notification report", () => {
    const { file, cursor } = fixtureSession("handback-probe");
    const messages = readClaudeHistoryFile(file, cursor);

    expect(taskOf(messages, HANDBACK_CALL)).toMatchObject({
      id: HANDBACK_CALL,
      cliTaskId: "a087ca34d38140971",
      kind: "agent",
      background: true,
      state: "completed",
      endReason: "cli",
      runCount: 1,
      startedAt: Date.parse("2026-10-17T12:03:12.617Z"),
      output: "PONG",
      usage: { tokens: 27937, toolUses: 1, durationMs: 2127 }
    });
  });

  it("never returns a running task", () => {
    for (const name of ["hooks-probe", "handback-probe"]) {
      const { file, cursor } = fixtureSession(name);
      const tasks = readClaudeHistoryFile(file, cursor).flatMap((m) => (m.task ? [m.task] : []));
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every((task) => task.state !== "running")).toBe(true);
    }
  });

  it("prefers the per-session sidecar folder over the shared one for a safe cursor", () => {
    const file = syntheticSession([agentCall("toolu_bg", 0, BACKGROUND_INPUT), launchAck("toolu_bg", 100)], {
      [`agent-${AGENT_ID}.meta.json`]: JSON.stringify({ toolUseId: "toolu_bg", finished: true })
    });
    mkdirSync(join(dirname(file), "subagents"), { recursive: true });
    writeFileSync(
      join(dirname(file), "subagents", `agent-${AGENT_ID}.meta.json`),
      JSON.stringify({ toolUseId: "toolu_bg", finished: false })
    );

    expect(taskOf(readClaudeHistoryFile(file, CURSOR), "toolu_bg")).toMatchObject({ state: "completed", endReason: "sidecar" });
  });

  it("still reads the shared sidecar folder when the session cursor is not a safe path segment", () => {
    const file = syntheticSession([agentCall("toolu_bg", 0, BACKGROUND_INPUT), launchAck("toolu_bg", 100)]);
    mkdirSync(join(dirname(file), "subagents"), { recursive: true });
    writeFileSync(
      join(dirname(file), "subagents", `agent-${AGENT_ID}.meta.json`),
      JSON.stringify({ toolUseId: "toolu_bg", finished: true })
    );

    expect(taskOf(readClaudeHistoryFile(file, "../escape"), "toolu_bg")).toMatchObject({ state: "completed", endReason: "sidecar" });
  });

  it("does not let a sidecar finished flag close a resumed run it cannot be tied to", () => {
    const sendCall = {
      type: "assistant",
      uuid: "a-send",
      timestamp: iso(6000),
      message: { id: "msg-send", role: "assistant", content: [{ type: "tool_use", id: "toolu_send", name: "SendMessage", input: { to: AGENT_ID, message: "again" } }] }
    };
    const file = syntheticSession(
      [
        agentCall("toolu_bg", 0, BACKGROUND_INPUT),
        launchAck("toolu_bg", 100),
        queuedNotification("toolu_bg", 5000, "<status>completed</status>\n<result>FIRST</result>"),
        sendCall,
        toolResult("toolu_send", 6100, `{"success":true,"message":"Resuming agent ${AGENT_ID}"}`, { success: true, resumedAgentId: AGENT_ID })
      ],
      { [`agent-${AGENT_ID}.meta.json`]: JSON.stringify({ toolUseId: "toolu_bg", finished: true }) }
    );

    expect(taskOf(readClaudeHistoryFile(file, CURSOR), "toolu_bg")).toMatchObject({ state: "unknown", endReason: "no-record", runCount: 2 });
  });

  it("ends a background shell whose launch was denied", () => {
    const file = syntheticSession([
      {
        type: "assistant",
        uuid: "a-bash",
        timestamp: iso(0),
        message: { id: "msg-bash", role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "sleep 100", run_in_background: true } }] }
      },
      {
        type: "user",
        uuid: "r-bash",
        timestamp: iso(100),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", is_error: true, content: "The user doesn't want to proceed with this tool use." }] }
      }
    ]);

    expect(taskOf(readClaudeHistoryFile(file, CURSOR), "toolu_bash")).toMatchObject({ kind: "shell", state: "failed", endReason: "tool-result" });
  });

  it("ignores notification XML quoted by a user prompt and reads it only from marked carriers", () => {
    const quoted = `Here is what the app logged:\n<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>`;
    const notification = `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>failed</status>\n<result>BOOM</result>\n</task-notification>`;
    const quotedOnly = syntheticSession([
      agentCall("toolu_bg", 0, BACKGROUND_INPUT),
      launchAck("toolu_bg", 100),
      { type: "user", uuid: "u-quote", timestamp: iso(200), message: { role: "user", content: quoted } },
      { type: "user", uuid: "u-block", timestamp: iso(300), message: { role: "user", content: [{ type: "text", text: notification }] } }
    ]);
    expect(taskOf(readClaudeHistoryFile(quotedOnly, CURSOR), "toolu_bg")).toMatchObject({ state: "unknown", endReason: "no-record" });

    const marked = syntheticSession([
      agentCall("toolu_bg", 0, BACKGROUND_INPUT),
      launchAck("toolu_bg", 100),
      {
        type: "user",
        uuid: "u-marked",
        timestamp: iso(300),
        origin: { kind: "task-notification", runId: "run-1" },
        message: { role: "user", content: [{ type: "text", text: `<system-reminder>\n${notification}\n</system-reminder>` }] }
      }
    ]);
    const messages = readClaudeHistoryFile(marked, CURSOR);
    expect(taskOf(messages, "toolu_bg")).toMatchObject({ state: "failed", endReason: "cli", output: "BOOM" });
  });

  it("completes a background agent closed only by a mid-turn queued_command attachment", () => {
    const file = syntheticSession([
      agentCall("toolu_bg", 0, BACKGROUND_INPUT),
      launchAck("toolu_bg", 100),
      queuedNotification(
        "toolu_bg",
        5000,
        "<status>completed</status>\n<summary>Agent \"bg\" finished</summary>\n<result>REPORT</result>\n<usage><subagent_tokens>100</subagent_tokens><tool_uses>3</tool_uses><duration_ms>500</duration_ms></usage>"
      )
    ]);

    expect(taskOf(readClaudeHistoryFile(file, CURSOR), "toolu_bg")).toStrictEqual({
      id: "toolu_bg",
      cliTaskId: AGENT_ID,
      kind: "agent",
      background: true,
      state: "completed",
      endReason: "cli",
      runCount: 1,
      startedAt: T0,
      endedAt: T0 + 5000,
      output: "REPORT",
      usage: { tokens: 100, toolUses: 3, durationMs: 500 }
    });
  });

  it("completes a background agent from a finished sidecar meta and tolerates bad metas", () => {
    const file = syntheticSession(
      [agentCall("toolu_bg", 0, BACKGROUND_INPUT), launchAck("toolu_bg", 100), assistantText("a-last", 9000, "waiting")],
      {
        [`agent-${AGENT_ID}.meta.json`]: JSON.stringify({ toolUseId: "toolu_bg", finished: true }),
        "agent-bad.meta.json": "{not json",
        "agent-anon.meta.json": JSON.stringify({ finished: true })
      }
    );

    expect(taskOf(readClaudeHistoryFile(file, CURSOR), "toolu_bg")).toMatchObject({
      state: "completed",
      endReason: "sidecar",
      endedAt: T0 + 9000
    });
  });

  it("marks a background agent with neither notification nor finished meta as unknown", () => {
    const file = syntheticSession(
      [agentCall("toolu_bg", 0, BACKGROUND_INPUT), launchAck("toolu_bg", 100), assistantText("a-last", 9000, "waiting")],
      { [`agent-${AGENT_ID}.meta.json`]: JSON.stringify({ toolUseId: "toolu_bg" }) }
    );

    expect(taskOf(readClaudeHistoryFile(file, CURSOR), "toolu_bg")).toMatchObject({
      state: "unknown",
      endReason: "no-record",
      endedAt: T0 + 9000
    });
  });

  it("marks an agent unknown when no sidecar directory exists", () => {
    const file = syntheticSession([agentCall("toolu_bg", 0, BACKGROUND_INPUT), launchAck("toolu_bg", 100)]);

    expect(taskOf(readClaudeHistoryFile(file, CURSOR), "toolu_bg")).toMatchObject({
      state: "unknown",
      endReason: "no-record"
    });
  });

  it("completes a foreground agent from its tool result", () => {
    const file = syntheticSession([
      agentCall("toolu_fg", 0, { description: "fg", prompt: "work" }),
      toolResult("toolu_fg", 3000, "FOREGROUND REPORT", { status: "completed", agentId: AGENT_ID, totalTokens: 10 })
    ]);
    const messages = readClaudeHistoryFile(file, CURSOR);

    expect(taskOf(messages, "toolu_fg")).toMatchObject({
      background: false,
      state: "completed",
      endReason: "tool-result",
      endedAt: T0 + 3000,
      output: "FOREGROUND REPORT"
    });
    expect(messages.find((m) => m.id === "toolu_fg-r")?.text).toBe("FOREGROUND REPORT");
  });

  it("ignores notifications for calls outside the returned window", () => {
    const fillers = Array.from({ length: 300 }, (_, i) => assistantText(`f${i}`, 1000 + i, `filler ${i}`));
    const file = syntheticSession([
      agentCall("toolu_old", 0, BACKGROUND_INPUT),
      launchAck("toolu_old", 100),
      ...fillers,
      queuedNotification("toolu_old", 5000, "<status>completed</status>\n<result>late</result>"),
      queuedNotification("toolu_missing", 5100, "<status>failed</status>", "0123456789abcdef")
    ]);

    const messages = readClaudeHistoryFile(file, CURSOR);
    expect(messages).toHaveLength(300);
    expect(messages.some((m) => m.id === "toolu_old")).toBe(false);
    expect(messages.every((m) => m.task === undefined)).toBe(true);
  });

  it("warns and returns nothing when the transcript is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = join(mkdtempSync(join(tmpdir(), "cw-claude-history-")), `${CURSOR}.jsonl`);

    expect(readClaudeHistoryFile(missing, CURSOR)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`claude history not found: ${missing}`);
    warn.mockRestore();
  });
});

describe("readClaudeTaskResult", () => {
  it("returns undefined for unsafe cursors or missing transcripts", () => {
    expect(readClaudeTaskResult("C:\\proj", "../escape", "tu1")).toBeUndefined();
    expect(readClaudeTaskResult("C:\\proj", "no-such-session", "tu1")).toBeUndefined();
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
