import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaudeTaskSystemLine, parseClaudeToolUseResult, type ClaudeTaskSystemInfo } from "./claudeStreamParser.js";
import {
  claudeCallObservation,
  claudeHandbackObservation,
  claudeNotificationObservation,
  claudeResumeObservation,
  claudeSystemTaskObservation,
  claudeToolResultObservation,
  findClaudeTaskNotification,
  isClaudeSubagentTool
} from "./claudeTasks.js";

interface FixtureLine {
  type?: string;
  subtype?: string;
  task_id?: string;
  status?: string;
  tasks?: unknown[];
  patch?: { status?: string };
  attachment?: { type?: string; prompt?: string };
  message?: { content?: unknown };
}

interface FixtureEntry {
  raw: string;
  msg: FixtureLine;
}

function readFixture(name: string): FixtureEntry[] {
  const text = readFileSync(fileURLToPath(new URL(`./__fixtures__/tasks/${name}`, import.meta.url)), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((raw) => ({ raw, msg: JSON.parse(raw) as FixtureLine }));
}

const HOOKS_STREAM = readFixture("hooks-probe/stream.jsonl");
const HOOKS_TRANSCRIPT = readFixture("hooks-probe/transcript.jsonl");

const PONG = { taskId: "a5fd6f29192d6b105", toolUseId: "toolu_01DaQjvfNQDvgKAiv1WcJNYS", runId: "0mvcd1zga-1ef0f9de" };
const SLEEPER = { taskId: "a74a561c109a552e8", toolUseId: "toolu_01RDYCbJfdYE4q12sgc97ETw", runId: "0mvcd1zgk-b45a6052" };
const SEND_TOOL_USE_ID = "toolu_011NsVdGAR78VmzQ1hYsrnNm";
const AT = 1000;

function systemInfo(match: (msg: FixtureLine) => boolean): ClaudeTaskSystemInfo {
  const found = HOOKS_STREAM.find(({ msg }) => msg.type === "system" && match(msg));
  if (!found) throw new Error("fixture system line not found");
  const info = parseClaudeTaskSystemLine(JSON.stringify(JSON.parse(found.raw)));
  if (!info) throw new Error("fixture line is not a task system line");
  return info;
}

function toolResultFor(toolUseId: string): { text: string; structured: Record<string, unknown> } {
  for (const { raw } of HOOKS_STREAM) {
    const parsed = parseClaudeToolUseResult(raw);
    if (parsed?.toolUseId !== toolUseId) continue;
    const msg = JSON.parse(raw) as { message: { content: { content: { text: string }[] }[] } };
    return { text: msg.message.content[0].content[0].text, structured: parsed.result };
  }
  throw new Error("fixture tool result not found");
}

function queuedPrompt(match: (prompt: string) => boolean): string {
  for (const { msg } of HOOKS_TRANSCRIPT) {
    const prompt = msg.attachment?.type === "queued_command" ? msg.attachment.prompt : undefined;
    if (prompt !== undefined && match(prompt)) return prompt;
  }
  throw new Error("fixture queued_command prompt not found");
}

const COMPLETED_PROMPT = queuedPrompt((prompt) => prompt.includes("<status>completed</status>"));
const KILLED_PROMPT = queuedPrompt((prompt) => prompt.includes("<status>killed</status>"));

function userNotification(): string {
  for (const { msg } of HOOKS_TRANSCRIPT) {
    const content = msg.type === "user" ? msg.message?.content : undefined;
    if (typeof content === "string" && content.startsWith("<task-notification>")) return content;
  }
  throw new Error("fixture user notification not found");
}

describe("isClaudeSubagentTool", () => {
  it("matches Agent and Task case-insensitively", () => {
    expect(isClaudeSubagentTool("Agent")).toBe(true);
    expect(isClaudeSubagentTool("Task")).toBe(true);
    expect(isClaudeSubagentTool("agent")).toBe(true);
    expect(isClaudeSubagentTool("TASK")).toBe(true);
  });

  it("rejects every other tool", () => {
    expect(isClaudeSubagentTool("Bash")).toBe(false);
    expect(isClaudeSubagentTool("TaskStop")).toBe(false);
    expect(isClaudeSubagentTool("SendMessage")).toBe(false);
  });
});

describe("findClaudeTaskNotification nested content", () => {
  it("keeps a result that quotes result and usage tags and reads the real usage after it", () => {
    const text =
      "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n" +
      "<result>see <result>inner</result> and <usage><tool_uses>99</tool_uses></usage></result>\n" +
      "<usage><subagent_tokens>10</subagent_tokens><tool_uses>2</tool_uses><duration_ms>30</duration_ms></usage>\n</task-notification>";
    expect(findClaudeTaskNotification(text)).toStrictEqual({
      taskId: "t1",
      status: "completed",
      result: "see <result>inner</result> and <usage><tool_uses>99</tool_uses></usage>",
      usage: { tokens: 10, toolUses: 2, durationMs: 30 }
    });
  });
});

describe("findClaudeTaskNotification", () => {
  it("parses a queued_command attachment prompt from a real transcript", () => {
    expect(findClaudeTaskNotification(COMPLETED_PROMPT)).toStrictEqual({
      toolUseId: PONG.toolUseId,
      taskId: PONG.taskId,
      status: "completed",
      summary: 'Agent "pong" finished',
      result:
        'This agent\'s report was delivered to you as a message from "a5fd6f29192d6b105" (its SubagentHandback call). Read it there; it is not repeated here.\n',
      usage: { tokens: 27933, toolUses: 1, durationMs: 2135 }
    });
  });

  it("omits result and usage when the block has none and maps killed through the status", () => {
    expect(findClaudeTaskNotification(KILLED_PROMPT)).toStrictEqual({
      toolUseId: SLEEPER.toolUseId,
      taskId: SLEEPER.taskId,
      status: "killed",
      summary: 'Agent "sleeper" was stopped by Claude'
    });
  });

  it("finds the block inside a system-reminder wrapper preceded by other text", () => {
    const wrapped = `Earlier prose.\n<system-reminder>\nA background task finished.\n${COMPLETED_PROMPT}\n</system-reminder>\nLater prose.`;
    expect(findClaudeTaskNotification(wrapped)).toStrictEqual(findClaudeTaskNotification(COMPLETED_PROMPT));
  });

  it("takes the block to the end of the text when the closing tag is missing", () => {
    const full = userNotification();
    const truncated = findClaudeTaskNotification(full.slice(0, full.indexOf("<result>")));
    expect(truncated).toMatchObject({
      toolUseId: SEND_TOOL_USE_ID,
      taskId: PONG.taskId,
      status: "completed",
      summary: 'Agent "pong" finished'
    });
    expect(truncated?.result).toBeUndefined();

    expect(
      findClaudeTaskNotification(
        "<task-notification>\n<task-id>t1</task-id>\n<status>failed</status>\n<result>partial\ntext</result>"
      )
    ).toStrictEqual({ taskId: "t1", status: "failed", result: "partial\ntext" });
  });

  it("keeps the result raw, multi-line and untrimmed", () => {
    const text = "<task-notification>\n<task-id>t1</task-id>\n<result>\n  line one\nline two\n</result>\n</task-notification>";
    expect(findClaudeTaskNotification(text)?.result).toBe("\n  line one\nline two\n");
  });

  it("parses partial usage as integers", () => {
    const text = "<task-notification><task-id>t1</task-id><usage><tool_uses>3</tool_uses><duration_ms>42</duration_ms></usage></task-notification>";
    expect(findClaudeTaskNotification(text)?.usage).toStrictEqual({ toolUses: 3, durationMs: 42 });
  });

  it("ignores usage tags outside the usage block", () => {
    const text =
      "<task-notification><task-id>t1</task-id><result><subagent_tokens>5</subagent_tokens></result></task-notification>";
    expect(findClaudeTaskNotification(text)).toStrictEqual({ taskId: "t1", result: "<subagent_tokens>5</subagent_tokens>" });
  });

  it("accepts a block that only has a task id or only a tool-use id", () => {
    expect(findClaudeTaskNotification("<task-notification><task-id> t9 </task-id></task-notification>")).toStrictEqual({
      taskId: "t9"
    });
    expect(
      findClaudeTaskNotification("<task-notification><tool-use-id>toolu_9</tool-use-id></task-notification>")
    ).toStrictEqual({ toolUseId: "toolu_9" });
  });

  it("uses only the first block", () => {
    const text =
      "<task-notification><task-id>first</task-id></task-notification><task-notification><task-id>second</task-id></task-notification>";
    expect(findClaudeTaskNotification(text)).toStrictEqual({ taskId: "first" });
  });

  it("returns null without a block or without any identifier", () => {
    expect(findClaudeTaskNotification("plain text")).toBeNull();
    expect(findClaudeTaskNotification("<task-notification>\n<status>completed</status>\n</task-notification>")).toBeNull();
    expect(findClaudeTaskNotification("<task-id>t1</task-id>")).toBeNull();
    expect(findClaudeTaskNotification("<task-notification><task-id>  </task-id></task-notification>")).toBeNull();
  });
});

describe("claudeCallObservation", () => {
  it("marks Agent and Task calls as agent tasks with an explicit background flag", () => {
    const input = { description: "pong", prompt: "Reply PONG", subagent_type: "general-purpose" };
    expect(claudeCallObservation("Agent", PONG.toolUseId, { ...input, run_in_background: true }, AT)).toStrictEqual({
      kind: "call",
      toolUseId: PONG.toolUseId,
      taskKind: "agent",
      background: true,
      at: AT
    });
    expect(claudeCallObservation("Task", "toolu_2", { ...input, run_in_background: false }, AT)).toStrictEqual({
      kind: "call",
      toolUseId: "toolu_2",
      taskKind: "agent",
      background: false,
      at: AT
    });
  });

  it("leaves the background flag out while it is provisional", () => {
    expect(claudeCallObservation("Agent", "toolu_3", { description: "x" }, AT)).toStrictEqual({
      kind: "call",
      toolUseId: "toolu_3",
      taskKind: "agent",
      at: AT
    });
    expect(claudeCallObservation("agent", "toolu_4", { run_in_background: "true" }, AT)).toStrictEqual({
      kind: "call",
      toolUseId: "toolu_4",
      taskKind: "agent",
      at: AT
    });
    expect(claudeCallObservation("Agent", "toolu_5", null, AT)).toStrictEqual({
      kind: "call",
      toolUseId: "toolu_5",
      taskKind: "agent",
      at: AT
    });
  });

  it("marks only background Bash and PowerShell calls as shell tasks", () => {
    expect(claudeCallObservation("Bash", "toolu_6", { command: "sleep 20", run_in_background: true }, AT)).toStrictEqual({
      kind: "call",
      toolUseId: "toolu_6",
      taskKind: "shell",
      background: true,
      at: AT
    });
    expect(claudeCallObservation("powershell", "toolu_7", { command: "sleep 20", run_in_background: true }, AT)).toStrictEqual({
      kind: "call",
      toolUseId: "toolu_7",
      taskKind: "shell",
      background: true,
      at: AT
    });
    expect(claudeCallObservation("Bash", "toolu_8", { command: "ls", run_in_background: false }, AT)).toBeNull();
    expect(claudeCallObservation("Bash", "toolu_9", { command: "ls" }, AT)).toBeNull();
  });

  it("ignores other tools", () => {
    expect(claudeCallObservation("Read", "toolu_10", { run_in_background: true }, AT)).toBeNull();
    expect(claudeCallObservation("TaskStop", "toolu_11", { task_id: SLEEPER.taskId }, AT)).toBeNull();
    expect(claudeCallObservation("SendMessage", "toolu_12", { to: PONG.taskId }, AT)).toBeNull();
  });
});

describe("claudeToolResultObservation", () => {
  it("treats a structured async_launched result from the stream as a background acknowledgement", () => {
    const { text, structured } = toolResultFor(SLEEPER.toolUseId);
    expect(structured["status"]).toBe("async_launched");
    expect(claudeToolResultObservation(SLEEPER.toolUseId, text, false, structured, AT)).toStrictEqual({
      kind: "background",
      ref: { toolUseId: SLEEPER.toolUseId, cliTaskId: SLEEPER.taskId },
      background: true,
      at: AT
    });
  });

  it("recognizes remote_launched and isAsync acknowledgements without an agent id", () => {
    const ack = { kind: "background", ref: { toolUseId: "toolu_1" }, background: true, at: AT };
    expect(claudeToolResultObservation("toolu_1", "", false, { status: "remote_launched" }, AT)).toStrictEqual(ack);
    expect(claudeToolResultObservation("toolu_1", "", false, { isAsync: true, agentId: "" }, AT)).toStrictEqual(ack);
  });

  it("recognizes the text acknowledgement and reads the agent id from it", () => {
    const { text } = toolResultFor(PONG.toolUseId);
    expect(claudeToolResultObservation(PONG.toolUseId, text, false, undefined, AT)).toStrictEqual({
      kind: "background",
      ref: { toolUseId: PONG.toolUseId, cliTaskId: PONG.taskId },
      background: true,
      at: AT
    });
    expect(claudeToolResultObservation("toolu_1", "  \nAsync agent launched successfully.", false, undefined, AT)).toMatchObject({
      kind: "background"
    });
  });

  it("prefers the structured agent id over the one in the acknowledgement text", () => {
    const observation = claudeToolResultObservation(
      "toolu_1",
      "Async agent launched successfully.\nagentId: bbbbbbbb2 (internal ID)",
      false,
      { status: "async_launched", agentId: "aaaaaaaa1" },
      AT
    );
    expect(observation).toStrictEqual({
      kind: "background",
      ref: { toolUseId: "toolu_1", cliTaskId: "aaaaaaaa1" },
      background: true,
      at: AT
    });
  });

  it("ends a foreground result as completed with its output and links its agent id", () => {
    expect(claudeToolResultObservation("toolu_1", "PONG", false, { status: "completed", agentId: "a1" }, AT)).toStrictEqual({
      kind: "ended",
      ref: { toolUseId: "toolu_1", cliTaskId: "a1" },
      state: "completed",
      reason: "tool-result",
      output: "PONG",
      outputSource: "result",
      at: AT
    });
  });

  it("caps a long result at 8000 characters", () => {
    const observation = claudeToolResultObservation("toolu_1", "x".repeat(9000), false, undefined, AT);
    expect(observation.kind === "ended" ? observation.output?.length : undefined).toBe(8000);
    const notification = claudeNotificationObservation({ taskId: "t1", status: "completed", result: "y".repeat(9000) }, AT);
    expect(notification?.kind === "ended" ? notification.output?.length : undefined).toBe(8000);
  });

  it("ends an error result as failed", () => {
    expect(claudeToolResultObservation("toolu_1", "boom", true, undefined, AT)).toStrictEqual({
      kind: "ended",
      ref: { toolUseId: "toolu_1" },
      state: "failed",
      reason: "tool-result",
      output: "boom",
      outputSource: "result",
      at: AT
    });
  });

  it("omits the output when it is empty", () => {
    expect(claudeToolResultObservation("toolu_1", "", false, undefined, AT)).toStrictEqual({
      kind: "ended",
      ref: { toolUseId: "toolu_1" },
      state: "completed",
      reason: "tool-result",
      outputSource: "result",
      at: AT
    });
    expect(claudeToolResultObservation("toolu_1", " \n", true, undefined, AT)).not.toHaveProperty("output");
  });
});

describe("claudeNotificationObservation", () => {
  it("ends the task with the result as output and the run id on the ref", () => {
    const notification = findClaudeTaskNotification(COMPLETED_PROMPT);
    expect(notification).not.toBeNull();
    expect(claudeNotificationObservation(notification!, AT, PONG.runId)).toStrictEqual({
      kind: "ended",
      ref: { toolUseId: PONG.toolUseId, cliTaskId: PONG.taskId, runId: PONG.runId },
      state: "completed",
      reason: "cli",
      output: notification!.result,
      outputSource: "result",
      usage: { tokens: 27933, toolUses: 1, durationMs: 2135 },
      at: AT
    });
  });

  it("ends with an unknown outcome when the status is not one the CLI documents", () => {
    expect(claudeNotificationObservation({ taskId: "t1", status: "exploded" }, AT)).toMatchObject({ kind: "ended", state: "unknown" });
    expect(claudeNotificationObservation({ taskId: "t1" }, AT)).toMatchObject({ kind: "ended", state: "completed" });
  });

  it("maps a killed notification to stopped and falls back to the summary", () => {
    const notification = findClaudeTaskNotification(KILLED_PROMPT);
    expect(notification).not.toBeNull();
    expect(claudeNotificationObservation(notification!, AT)).toStrictEqual({
      kind: "ended",
      ref: { toolUseId: SLEEPER.toolUseId, cliTaskId: SLEEPER.taskId },
      state: "stopped",
      reason: "cli",
      output: 'Agent "sleeper" was stopped by Claude',
      outputSource: "summary",
      at: AT
    });
  });

  it("prefers the summary over a whitespace-only result", () => {
    expect(claudeNotificationObservation({ taskId: "t1", result: "\n  \n", summary: "done" }, AT)).toMatchObject({
      output: "done",
      outputSource: "summary"
    });
  });

  it("omits output and usage when the notification has neither", () => {
    expect(claudeNotificationObservation({ taskId: "t1", status: "failed" }, AT)).toStrictEqual({
      kind: "ended",
      ref: { cliTaskId: "t1" },
      state: "failed",
      reason: "cli",
      at: AT
    });
  });

  it("returns null for a non-terminal status", () => {
    expect(claudeNotificationObservation({ taskId: "t1", status: "running" }, AT)).toBeNull();
    expect(claudeNotificationObservation({ taskId: "t1", status: "in_progress" }, AT)).toBeNull();
  });
});

describe("claudeSystemTaskObservation edge signals", () => {
  const line = (msg: Record<string, unknown>): ClaudeTaskSystemInfo => {
    const info = parseClaudeTaskSystemLine(JSON.stringify({ type: "system", ...msg }));
    if (!info) throw new Error("not a task line");
    return info;
  };

  it("leaves ambient watcher tasks out of the roster and ignores their start", () => {
    const roster = line({ subtype: "background_tasks_changed", tasks: [{ task_id: "w1", ambient: true }, { task_id: "a1", run_id: "r1" }] });
    expect(claudeSystemTaskObservation(roster, AT)).toStrictEqual({ kind: "roster", tasks: [{ cliTaskId: "a1", runId: "r1" }], at: AT });
    const started = line({ subtype: "task_started", task_id: "w1", tool_use_id: "tu_w", ambient: true });
    expect(claudeSystemTaskObservation(started, AT)).toBeNull();
  });

  it("does not guess a task kind when task_type is missing", () => {
    const started = line({ subtype: "task_started", task_id: "t1", tool_use_id: "tu_1", is_backgrounded: true });
    expect(claudeSystemTaskObservation(started, AT)).toStrictEqual({
      kind: "started",
      ref: { toolUseId: "tu_1", cliTaskId: "t1" },
      background: true,
      at: AT
    });
  });

  it("uses the handback report a notification carries as the task's report", () => {
    const notification = line({
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "tu_1",
      status: "completed",
      summary: "This agent's report was delivered to you as a message",
      handback: "send",
      handback_report: { text: "PONG" }
    });
    expect(claudeSystemTaskObservation(notification, AT)).toMatchObject({
      kind: "ended",
      state: "completed",
      output: "PONG",
      outputSource: "report"
    });
  });
});

describe("claudeSystemTaskObservation", () => {
  it("maps background_tasks_changed to a roster", () => {
    const live = systemInfo((msg) => msg.subtype === "background_tasks_changed" && msg.tasks?.length === 1);
    expect(claudeSystemTaskObservation(live, AT)).toStrictEqual({
      kind: "roster",
      tasks: [{ cliTaskId: PONG.taskId, runId: PONG.runId }],
      at: AT
    });
    const empty = systemInfo((msg) => msg.subtype === "background_tasks_changed" && msg.tasks?.length === 0);
    expect(claudeSystemTaskObservation(empty, AT)).toStrictEqual({ kind: "roster", tasks: [], at: AT });
    expect(claudeSystemTaskObservation({ kind: "tasks" }, AT)).toStrictEqual({ kind: "roster", tasks: [], at: AT });
  });

  it("keeps every roster entry and omits a missing run id", () => {
    const both = systemInfo((msg) => msg.subtype === "background_tasks_changed" && msg.tasks?.length === 2);
    expect(claudeSystemTaskObservation(both, AT)).toStrictEqual({
      kind: "roster",
      tasks: [
        { cliTaskId: PONG.taskId, runId: PONG.runId },
        { cliTaskId: SLEEPER.taskId, runId: SLEEPER.runId }
      ],
      at: AT
    });
    expect(
      claudeSystemTaskObservation({ kind: "tasks", liveTaskEntries: [{ taskId: "a" }, { taskId: "b", runId: "r1" }] }, AT)
    ).toStrictEqual({ kind: "roster", tasks: [{ cliTaskId: "a" }, { cliTaskId: "b", runId: "r1" }], at: AT });
  });

  it("maps a real task_started line to a background agent start with run id", () => {
    const info = systemInfo((msg) => msg.subtype === "task_started" && msg.task_id === PONG.taskId);
    expect(claudeSystemTaskObservation(info, AT)).toStrictEqual({
      kind: "started",
      ref: { toolUseId: PONG.toolUseId, cliTaskId: PONG.taskId, runId: PONG.runId },
      taskKind: "agent",
      background: true,
      at: AT
    });
  });

  it("maps a local_bash task_started to a shell and drops an unknown background flag", () => {
    expect(
      claudeSystemTaskObservation({ kind: "started", taskId: "b1", toolUseId: "toolu_b", taskType: "local_bash" }, AT)
    ).toStrictEqual({
      kind: "started",
      ref: { toolUseId: "toolu_b", cliTaskId: "b1" },
      taskKind: "shell",
      at: AT
    });
    expect(claudeSystemTaskObservation({ kind: "started", toolUseId: "toolu_c", background: false }, AT)).toStrictEqual({
      kind: "started",
      ref: { toolUseId: "toolu_c" },
      background: false,
      at: AT
    });
  });

  it("ends the run on a terminal task_updated using its end time", () => {
    const completed = systemInfo(
      (msg) => msg.subtype === "task_updated" && msg.task_id === PONG.taskId && msg.patch?.status === "completed"
    );
    expect(claudeSystemTaskObservation(completed, AT)).toStrictEqual({
      kind: "ended",
      ref: { cliTaskId: PONG.taskId, runId: PONG.runId },
      state: "completed",
      reason: "cli",
      at: 1792239386375
    });
    const killed = systemInfo((msg) => msg.subtype === "task_updated" && msg.patch?.status === "killed");
    expect(claudeSystemTaskObservation(killed, AT)).toStrictEqual({
      kind: "ended",
      ref: { cliTaskId: SLEEPER.taskId, runId: SLEEPER.runId },
      state: "stopped",
      reason: "cli",
      at: 1792239389191
    });
  });

  it("falls back to the observation time when task_updated has no end time", () => {
    expect(claudeSystemTaskObservation({ kind: "updated", taskId: "t1", status: "failed" }, AT)).toStrictEqual({
      kind: "ended",
      ref: { cliTaskId: "t1" },
      state: "failed",
      reason: "cli",
      at: AT
    });
  });

  it("ignores task_updated without a terminal status", () => {
    expect(claudeSystemTaskObservation({ kind: "updated", taskId: "t1", status: "running" }, AT)).toBeNull();
    expect(claudeSystemTaskObservation({ kind: "updated", taskId: "t1", status: "mystery" }, AT)).toBeNull();
    expect(claudeSystemTaskObservation({ kind: "updated", taskId: "t1", endTime: 5 }, AT)).toBeNull();
  });

  it("ends the run on a real task_notification with the handback report it carries as output", () => {
    const info = systemInfo((msg) => msg.subtype === "task_notification" && msg.task_id === PONG.taskId && msg.status === "completed");
    expect(claudeSystemTaskObservation(info, AT)).toStrictEqual({
      kind: "ended",
      ref: { toolUseId: PONG.toolUseId, cliTaskId: PONG.taskId, runId: PONG.runId },
      state: "completed",
      reason: "cli",
      output: "PONG",
      outputSource: "report",
      usage: { tokens: 27933, toolUses: 1, durationMs: 2135 },
      at: AT
    });
  });

  it("maps a stopped task_notification to stopped", () => {
    const info = systemInfo((msg) => msg.subtype === "task_notification" && msg.status === "stopped");
    expect(claudeSystemTaskObservation(info, AT)).toStrictEqual({
      kind: "ended",
      ref: { toolUseId: SLEEPER.toolUseId, cliTaskId: SLEEPER.taskId, runId: SLEEPER.runId },
      state: "stopped",
      reason: "cli",
      output: "sleeper",
      outputSource: "summary",
      at: AT
    });
  });

  it("defaults a task_notification without status to completed and skips a running one", () => {
    expect(claudeSystemTaskObservation({ kind: "notification", taskId: "t1" }, AT)).toStrictEqual({
      kind: "ended",
      ref: { cliTaskId: "t1" },
      state: "completed",
      reason: "cli",
      at: AT
    });
    expect(claudeSystemTaskObservation({ kind: "notification", taskId: "t1", status: "running" }, AT)).toBeNull();
  });
});

describe("claudeHandbackObservation", () => {
  it("ends the run by origin id with the report as output", () => {
    expect(claudeHandbackObservation("origin-1", "PONG", AT)).toStrictEqual({
      kind: "ended",
      ref: { originId: "origin-1" },
      state: "completed",
      reason: "cli",
      output: "PONG",
      outputSource: "report",
      at: AT
    });
  });
});

describe("claudeResumeObservation", () => {
  it("starts a background run from the structured resumedAgentId of a real SendMessage result", () => {
    const { text, structured } = toolResultFor(SEND_TOOL_USE_ID);
    expect(claudeResumeObservation(SEND_TOOL_USE_ID, "ignored-recipient", text, structured, AT)).toStrictEqual({
      kind: "started",
      ref: { toolUseId: SEND_TOOL_USE_ID, cliTaskId: PONG.taskId },
      taskKind: "agent",
      background: true,
      at: AT
    });
  });

  it("falls back to the recipient when only the result text says the agent is resuming", () => {
    expect(claudeResumeObservation("toolu_s", PONG.taskId, "Resuming agent a5fd6f2 in the background", undefined, AT)).toStrictEqual({
      kind: "started",
      ref: { toolUseId: "toolu_s", cliTaskId: PONG.taskId },
      taskKind: "agent",
      background: true,
      at: AT
    });
    expect(claudeResumeObservation("toolu_s", PONG.taskId, "RESUMING AGENT now", {}, AT)).not.toBeNull();
  });

  it("does not treat a queued message as a resume", () => {
    expect(
      claudeResumeObservation("toolu_s", PONG.taskId, "Message queued for delivery to a5fd6f2", { success: true }, AT)
    ).toBeNull();
    expect(
      claudeResumeObservation("toolu_s", PONG.taskId, "Message queued for delivery", { resumedAgentId: "  " }, AT)
    ).toBeNull();
  });
});
