import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import { buildClaudeArgs, CLAUDE_IDLE_EVICT_MS, ClaudeCliDriver, claudeSettingsPath, mapClaudeEffort, mapClaudePermission, mergeClaudeAllowRule, subagentToolsResult } from "./ClaudeCliDriver.js";

const SETTINGS: AppSettings = {
  claudeBinaryPath: "claude",
  opencodeBinaryPath: "opencode",
  codexBinaryPath: "codex",
  claudeExtraArgs: "",
  opencodeExtraArgs: "",
  codexExtraArgs: "",
  claudeDefaultModel: "",
  claudeEnabledModels: [],
  claudeCustomModel: { id: "", name: "" },
  claudeReasoningExpanded: false,
  opencodeReasoningExpanded: false,
  codexReasoningExpanded: false,
  opencodeGoUsage: false,
  gitBinaryPath: "git",
  githubCliBinaryPath: "gh",
  sourceControlRefreshIntervalSeconds: 30,
  defaultUseWorktree: true,
  holdingHours: 6,
  holdingAutoExpireEnabled: false,
  autoTitleEnabled: true,
  autoTitleDriver: "claude",
  autoTitleModel: "claude-sonnet-5",
  autoTitleEffort: "low",
  prRefreshIntervalSeconds: 120,
  prCloneRoot: "~/.cw-code/repos",
  prAttributionEnabled: true,
  prAttributionText: "",
  prWorkflows: []
};

describe("mapClaudePermission", () => {
  it("passes through supported modes", () => {
    expect(mapClaudePermission("auto")).toBe("auto");
    expect(mapClaudePermission("acceptEdits")).toBe("acceptEdits");
    expect(mapClaudePermission("bypassPermissions")).toBe("bypassPermissions");
    expect(mapClaudePermission("manual")).toBe("manual");
  });

  it("falls back to auto for unknown values", () => {
    expect(mapClaudePermission("default")).toBe("auto");
    expect(mapClaudePermission("")).toBe("auto");
    expect(mapClaudePermission("plan")).toBe("auto");
  });
});

describe("mapClaudeEffort", () => {
  it("passes through supported levels", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(mapClaudeEffort(level)).toBe(level);
    }
  });

  it("falls back to medium for unknown values", () => {
    expect(mapClaudeEffort("ultra")).toBe("medium");
  });

  it("maps minimal to low since Claude has no minimal level", () => {
    expect(mapClaudeEffort("minimal")).toBe("low");
  });
});

describe("buildClaudeArgs", () => {
  it("includes model, effort, and permission flags", () => {
    const args = buildClaudeArgs({
      model: "claude-fable-5",
      effort: "high",
      permissionMode: "auto"
    });
    expect(args).toContain("--model");
    expect(args).toContain("claude-fable-5");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("auto");
  });

  it("always uses streaming input with the stdio permission host", () => {
    const args = buildClaudeArgs({});
    expect(args).toContain("-p");
    expect(args).not.toContain("hello");
    const inputPos = args.indexOf("--input-format");
    expect(args[inputPos + 1]).toBe("stream-json");
    const hostPos = args.indexOf("--permission-prompt-tool");
    expect(args[hostPos + 1]).toBe("stdio");
  });

  it("omits unset optionals", () => {
    const args = buildClaudeArgs({});
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--permission-mode");
  });
});

describe("claudeSettingsPath", () => {
  it("points at .claude/settings.json under the turn cwd", () => {
    expect(claudeSettingsPath(join("C:", "proj"))).toBe(join("C:", "proj", ".claude", "settings.json"));
  });
});

describe("subagentToolsResult", () => {
  it("maps a sidecar agent to the bridge result", () => {
    expect(
      subagentToolsResult({
        model: "claude-sonnet-5",
        effort: "high",
        totalTokens: 136099,
        total: 1,
        items: [{ id: "tu1", name: "Read", input: { path: "a.ts" }, output: "file" }]
      })
    ).toEqual({
      items: [{ id: "tu1", name: "Read", input: { path: "a.ts" }, output: "file" }],
      model: "claude-sonnet-5",
      effort: "high",
      tokens: 136099
    });
  });

  it("returns an empty list when the sidecar is missing", () => {
    expect(subagentToolsResult(undefined)).toEqual({ items: [] });
  });
});

describe("mergeClaudeAllowRule", () => {
  it("creates the permissions allow list from scratch", () => {
    expect(mergeClaudeAllowRule(null, "Bash")).toEqual({ permissions: { allow: ["Bash"] } });
  });

  it("dedupes an existing rule instead of appending twice", () => {
    expect(mergeClaudeAllowRule({ permissions: { allow: ["Bash"] } }, "Bash")).toEqual({
      permissions: { allow: ["Bash"] }
    });
  });

  it("appends new rules while preserving other settings", () => {
    expect(
      mergeClaudeAllowRule({ model: "sonnet", permissions: { allow: ["Read"], deny: ["Bash(sudo *)"] } }, "Bash")
    ).toEqual({
      model: "sonnet",
      permissions: { allow: ["Read", "Bash"], deny: ["Bash(sudo *)"] }
    });
  });

  it("tolerates missing or non-object settings", () => {
    expect(mergeClaudeAllowRule(undefined, "Edit")).toEqual({ permissions: { allow: ["Edit"] } });
    expect(mergeClaudeAllowRule({ permissions: null }, "Edit")).toEqual({
      permissions: { allow: ["Edit"] }
    });
  });

  it("lists native permission modes including full access", async () => {
    const { driver } = makeDriver();
    const modes = await driver.listPermissionModes();
    expect(modes.map((m) => m.id)).toEqual(["manual", "acceptEdits", "auto", "bypassPermissions"]);
    expect(modes.map((m) => m.label)).toEqual(["Manual", "Accept edits", "Auto", "Bypass permissions"]);
    expect(modes.every((m) => m.native)).toBe(true);
    driver.dispose();
  });
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = undefined;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  written = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written += chunk.toString();
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

type ClaudeSpawnFn = ConstructorParameters<typeof ClaudeCliDriver>[2];

function makeDriver() {
  const events: ThreadEvent[] = [];
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const killed: unknown[] = [];
  const spawnFn = ((command: string, args: readonly string[]) => {
    spawnCalls.push({ command, args: [...args] });
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as ClaudeSpawnFn;
  const driver = new ClaudeCliDriver(
    (event) => events.push(event),
    () => SETTINGS,
    spawnFn,
    (proc) => killed.push(proc)
  );
  return { driver, events, children, spawnCalls, killed };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
}

function resultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "native-1",
    result: "done",
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 4 },
    ...overrides
  });
}

function taskChangeLine(count: number): string {
  return JSON.stringify({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: Array.from({ length: count }, (_, index) => ({ id: `task-${index}` }))
  });
}

function taskChangeLineWithIds(ids: string[]): string {
  return JSON.stringify({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: ids.map((task_id) => ({ task_id }))
  });
}

function taskStartedLine(taskId: string, toolUseId: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    is_backgrounded: true
  });
}

function taskNotificationLine(taskId: string, toolUseId: string, result: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<result>${result}</result>\n</task-notification>`
    }
  });
}

function toolResults(events: ThreadEvent[]): Array<Extract<ThreadEvent, { type: "tool.result" }>> {
  return events.filter((event): event is Extract<ThreadEvent, { type: "tool.result" }> => event.type === "tool.result");
}

function turnDones(events: ThreadEvent[]): Array<Extract<ThreadEvent, { type: "turn.done" }>> {
  return events.filter((event): event is Extract<ThreadEvent, { type: "turn.done" }> => event.type === "turn.done");
}

describe("ClaudeCliDriver persistent process", () => {
  it("reuses one process for a second turn in the same session", async () => {
    const { driver, events, children, spawnCalls } = makeDriver();
    const first = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "first prompt" });
    await settle();
    children[0].stdout.write(`${resultLine()}\n`);
    await settle();
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.done", turnId: first.turnId }));

    const second = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "second prompt" });
    await settle();
    expect(spawnCalls).toHaveLength(1);
    expect(second.turnId).not.toBe(first.turnId);
    expect(children[0].written).toContain('"first prompt"');
    expect(children[0].written).toContain('"second prompt"');

    children[0].stdout.write(
      `${JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "hello" } } })}\n`
    );
    await settle();
    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.turnId).toBe(second.turnId);
    driver.dispose();
  });

  it("keeps the process and stdin open after a result line", async () => {
    const { driver, events, children, killed } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(`${resultLine()}\n`);
    await settle();
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.done", backgroundTasks: 0 }));
    expect(children[0].stdin.writableEnded).toBe(false);
    expect(killed).toEqual([]);
    driver.dispose();
  });

  it("reports live background task counts and follows task changes", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(`${taskChangeLine(2)}\n`);
    children[0].stdout.write(`${resultLine()}\n`);
    await settle();
    const dones = events.filter((event) => event.type === "turn.done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ backgroundTasks: 2 });

    children[0].stdout.write(`${taskChangeLine(0)}\n`);
    children[0].stdout.write(`${resultLine({ num_turns: 2 })}\n`);
    await settle();
    const after = events.filter((event) => event.type === "turn.done");
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ backgroundTasks: 0, numTurns: 2 });
    driver.dispose();
  });

  it("ignores task notification results while background work remains", async () => {
    const { driver, events, children, killed } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(`${taskChangeLine(1)}\n`);
    children[0].stdout.write(`${resultLine({ origin: { kind: "task-notification" }, num_turns: 3 })}\n`);
    await settle();
    expect(events.filter((event) => event.type === "turn.done")).toEqual([]);
    expect(killed).toEqual([]);
    driver.dispose();
  });

  it("replays a Handback before the final task-notification result", async () => {
    const { driver, events, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    const agentCallId = "agent-call";
    const handbackCallId = "handback-call";
    const taskId = "agent-1";
    const report = "All paths absolute from repo root.\n\n## 1. Contracts\nThe report is the parent Agent result.\n\n## 2. Driver\nThe Handback is terminal.";
    const notificationText = "The report was delivered in the Handback and is not repeated here.";
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: agentCallId, name: "Agent", input: { run_in_background: true } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ tool_use_id: agentCallId, content: [{ type: "text", text: "Async agent launched successfully.\nagentId: aa6598debd48b1c22\nThe agent is working in the background." }] }] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine(taskId, agentCallId)}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds([taskId])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", parent_tool_use_id: agentCallId, message: { content: [{ type: "tool_use", id: handbackCallId, name: "SubagentHandback", input: { message: report } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary: notificationText, usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 900 } })}\n`
    );
    children[0].stdout.write(`${taskNotificationLine(taskId, agentCallId, notificationText)}\n`);
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "final answer", session_id: "native-1", total_cost_usd: 0.04, usage: { input_tokens: 100, output_tokens: 20 }, num_turns: 2 })}\n`
    );
    await settle();

    const results = toolResults(events);
    const parentResults = results.filter((event) => event.toolCallId === agentCallId);
    expect(parentResults).toEqual([
      expect.objectContaining({ output: expect.stringContaining("Async agent launched successfully") }),
      expect.objectContaining({ output: report }),
      expect.objectContaining({ output: report, usage: { tokens: 1200, toolUses: 3, durationMs: 900 } })
    ]);
    expect(results.some((event) => event.output === notificationText)).toBe(false);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool.call", name: "SubagentHandback" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool.result", toolCallId: handbackCallId }));
    const dones = turnDones(events);
    expect(dones).toHaveLength(1);
    expect(dones.map((event) => event.backgroundTasks)).toEqual([0]);
    expect(dones[0]).toMatchObject({ turnId: handle.turnId, resultText: "final answer", backgroundTasks: 0 });
    driver.dispose();
  });

  it("keeps unmapped live tasks while removing an absent mapped Agent without terminalizing Bash", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "call-agent", name: "Agent", input: { run_in_background: true } },
        { type: "tool_use", id: "call-bash", name: "Bash", input: { run_in_background: true } }
      ] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine("task-agent", "call-agent")}\n`);
    children[0].stdout.write(`${taskStartedLine("task-bash", "call-bash")}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "call-agent", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: aa6598debd48b1c22\nThe agent is working in the background." }] }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "call-bash", content: "Command running in background with ID: bash-1. Output is being written to a file." }] } })}\n`
    );
    children[0].stdout.write(`${taskChangeLineWithIds(["task-agent", "task-bash", "task-unmapped"])}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-bash", "task-unmapped"])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", parent_tool_use_id: "call-agent", message: { content: [{ type: "tool_use", id: "handback-agent", name: "SubagentHandback", input: { message: "agent report" } }] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "still running", num_turns: 2 })}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds([])}\n`);
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "final answer", session_id: "native-1", num_turns: 3 })}\n`
    );
    await settle();

    const results = toolResults(events);
    expect(results.filter((event) => event.toolCallId === "call-agent").map((event) => event.output)).toEqual([
      expect.stringContaining("Async agent launched successfully"),
      "agent report"
    ]);
    expect(results.some((event) => event.toolCallId === "call-bash" && event.output.includes("Command running in background"))).toBe(true);
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([2, 0]);
    driver.dispose();
  });

  it("emits a later final task-notification once after an initial result with live work", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { run_in_background: true } }] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine("task-1", "agent-call")}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-1"])}\n`);
    children[0].stdout.write(`${resultLine({ result: "initial result", num_turns: 1 })}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", parent_tool_use_id: "agent-call", message: { content: [{ type: "tool_use", id: "handback-call", name: "SubagentHandback", input: { message: "final report" } }] } })}\n`
    );
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "final answer", session_id: "native-1", num_turns: 2, total_cost_usd: 0.02, usage: { input_tokens: 20, output_tokens: 5 } })}\n`
    );
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "duplicate", session_id: "native-1", num_turns: 3, total_cost_usd: 0.03, usage: { input_tokens: 30, output_tokens: 9 } })}\n`
    );
    await settle();

    expect(turnDones(events).map((event) => [event.resultText, event.backgroundTasks, event.numTurns])).toEqual([
      ["initial result", 1, 1],
      ["final answer", 0, 2]
    ]);
    driver.dispose();
  });

  it("releases a task started without an Agent call from an ID-bearing notification", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    const taskId = "task-1";
    const toolCallId = "call-1";
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolCallId, task_type: "local_agent", is_backgrounded: true })}\n`
    );
    children[0].stdout.write(`${taskChangeLineWithIds([taskId])}\n`);
    children[0].stdout.write(`${taskNotificationLine(taskId, toolCallId, "notification report")}\n`);
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "final answer", session_id: "native-1" })}\n`
    );
    await settle();

    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId, output: "notification report", isError: false });
    expect(events.some((event) => event.type === "tool.call")).toBe(false);
    const dones = turnDones(events);
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ resultText: "final answer", backgroundTasks: 0 });
    driver.dispose();
  });

  it("drops provisional Agent tracking when task_started is not backgrounded", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Agent", input: { run_in_background: true } }] } })}\n`
    );
    children[0].stdout.write(`${taskChangeLineWithIds(["other-task"])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "foreground-task", tool_use_id: "call-1", task_type: "local_agent", is_backgrounded: false })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "call-1", content: "foreground report" }] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "waiting" })}\n`);
    await settle();

    expect(toolResults(events)).toContainEqual(expect.objectContaining({
      toolCallId: "call-1",
      output: "foreground report",
      isError: false
    }));
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([1]);
    driver.dispose();
  });

  it("uses a later Handback report after an earlier task notification", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { run_in_background: true } }] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine("task-1", "agent-call")}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-1"])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", summary: "short summary", usage: { total_tokens: 1200 } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", parent_tool_use_id: "agent-call", message: { content: [{ type: "tool_use", id: "handback-call", name: "SubagentHandback", input: { message: "full Handback report" } }] } })}\n`
    );
    await settle();

    expect(toolResults(events).filter((event) => event.toolCallId === "agent-call")).toEqual([
      expect.objectContaining({ output: "short summary", usage: { tokens: 1200 } }),
      expect.objectContaining({ output: "full Handback report" })
    ]);
    driver.dispose();
  });

  it("does not complete another background task when a foreground Agent returns", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(`${taskChangeLineWithIds(["other-task"])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "foreground-call", name: "Agent", input: { prompt: "read a file" } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "foreground-call", content: "foreground report" }] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "waiting" })}\n`);
    await settle();

    expect(turnDones(events).map((event) => [event.resultText, event.backgroundTasks])).toEqual([["waiting", 1]]);

    children[0].stdout.write(`${taskChangeLineWithIds([])}\n`);
    children[0].stdout.write(`${resultLine({ origin: { kind: "task-notification" }, result: "finished" })}\n`);
    await settle();
    expect(turnDones(events).map((event) => [event.resultText, event.backgroundTasks])).toEqual([
      ["waiting", 1],
      ["finished", 0]
    ]);
    driver.dispose();
  });

  it("removes the completed mapped call when a task snapshot shrinks", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "call-a", name: "Agent", input: {} },
        { type: "tool_use", id: "call-b", name: "Agent", input: {} }
      ] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine("task-a", "call-a")}\n`);
    children[0].stdout.write(`${taskStartedLine("task-b", "call-b")}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-a", "task-b"])}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-a"])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", parent_tool_use_id: "call-a", message: { content: [{ type: "tool_use", id: "handback-a", name: "SubagentHandback", input: { message: "mapped report" } }] } })}\n`
    );
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "final answer", session_id: "native-1" })}\n`
    );
    await settle();

    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: "call-a", output: "mapped report" });
    expect(results.some((event) => event.toolCallId === "call-b")).toBe(false);
    const dones = turnDones(events);
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ resultText: "final answer", backgroundTasks: 0 });
    driver.dispose();
  });

  it("retains task mapping through an ID-less notification and a report-less result", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    const taskId = "task-1";
    const toolCallId = "call-1";
    children[0].stdout.write(`${taskStartedLine(taskId, toolCallId)}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds([taskId])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "completed", end_time: 1000 } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary: "DONE" })}\n`
    );
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: undefined, session_id: "native-1" })}\n`
    );
    await settle();

    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId, output: "DONE", isError: false });
    const dones = turnDones(events);
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ resultText: "DONE", backgroundTasks: 0 });
    driver.dispose();
  });

  it("completes a background task from task_notification with usage", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "call-1", is_backgrounded: true, prompt: "review" })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "agent-1", patch: { status: "completed", end_time: 1000 } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: "call-1", status: "completed", summary: "DONE", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 900 } })}\n`
    );
    await settle();
    expect(events).toContainEqual({
      type: "tool.result",
      turnId: expect.any(String),
      toolCallId: "call-1",
      output: "DONE",
      isError: false,
      usage: { tokens: 1200, toolUses: 3, durationMs: 900 },
      agentId: "agent-1"
    });
    driver.dispose();
  });

  it("marks a failed task from task_updated when no notification follows", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "agent-2", tool_use_id: "call-2", task_type: "local_agent", is_backgrounded: true })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "agent-2", patch: { status: "failed", end_time: 1000 } })}\n`
    );
    await settle();
    expect(events).toContainEqual({
      type: "tool.result",
      turnId: expect.any(String),
      toolCallId: "call-2",
      output: "Subagent failed",
      isError: true
    });
    driver.dispose();
  });

  it("replaces a failed task update with the later notification details", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "call-1", task_type: "local_agent", is_backgrounded: true })}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-1"])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "task-1", patch: { status: "failed" } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "task-1", status: "failed", summary: "Permission denied reading C:/secret.txt", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 900 } })}\n`
    );
    await settle();

    expect(toolResults(events).filter((event) => event.toolCallId === "call-1")).toEqual([
      expect.objectContaining({ output: "Subagent failed", isError: true }),
      expect.objectContaining({
        output: "Permission denied reading C:/secret.txt",
        isError: true,
        usage: { tokens: 1200, toolUses: 3, durationMs: 900 }
      })
    ]);
    driver.dispose();
  });

  it("finishes the turn at its result while a background shell keeps running", async () => {
    const { driver, events, children, killed } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-bash", name: "Bash", input: { command: "sleep 20", run_in_background: true } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bash-1", task_type: "local_bash", description: "sleep 20" }] })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "call-bash", task_type: "local_bash", is_backgrounded: true })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "call-bash", content: "Command running in background with ID: bash-1." }] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "STARTED", num_turns: 2 })}\n`);
    await settle();

    expect(turnDones(events)).toEqual([
      expect.objectContaining({ turnId: handle.turnId, resultText: "STARTED", backgroundTasks: 0 })
    ]);

    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] })}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "bash-1", patch: { status: "completed", end_time: 1000 } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bash-1", tool_use_id: "call-bash", status: "completed", summary: "Background command \"sleep 20\" completed (exit code 0)" })}\n`
    );
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "Background task completed.", num_turns: 1 })}\n`
    );
    await settle();

    expect(turnDones(events)).toHaveLength(1);
    expect(toolResults(events).filter((event) => event.toolCallId === "call-bash").map((event) => event.output)).toEqual([
      "Command running in background with ID: bash-1.",
      "Background command \"sleep 20\" completed (exit code 0)"
    ]);
    expect(killed).toEqual([]);
    driver.dispose();
  });

  it("keeps a newer prompt open when an earlier shell's notification turn finishes first", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "start shell" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bash-1", task_type: "local_bash" }] })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "call-bash", task_type: "local_bash", is_backgrounded: true })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "STARTED" })}\n`);
    await settle();

    const second = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "second prompt" });
    await settle();
    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] })}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bash-1", tool_use_id: "call-bash", status: "completed", summary: "Background command completed (exit code 0)" })}\n`
    );
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "Background task completed." })}\n`
    );
    await settle();
    expect(turnDones(events).map((event) => event.resultText)).toEqual(["STARTED"]);

    children[0].stdout.write(`${resultLine({ result: "SECOND" })}\n`);
    await settle();
    expect(turnDones(events).map((event) => [event.turnId, event.resultText])).toEqual([
      [expect.any(String), "STARTED"],
      [second.turnId, "SECOND"]
    ]);
    driver.dispose();
  });

  it("labels failed non-Agent background tasks without Agent metadata", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "call-bash", task_type: "local_bash", is_backgrounded: true })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "bash-1", patch: { status: "failed", end_time: 1000 } })}\n`
    );
    await settle();
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.result",
      toolCallId: "call-bash",
      output: "Background task failed",
      isError: true
    }));
    driver.dispose();
  });

  it("emits turn.error with stderr when the process closes mid-turn", async () => {
    const { driver, events, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stderr.write("Sandbox disabled");
    await settle();
    children[0].emit("close", 1);
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        turnId: handle.turnId,
        message: "claude exited before completing the turn (code 1)"
      })
    );
  });

  it("keeps the real stderr when boilerplate is mixed in", async () => {
    const { driver, events, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stderr.write("Sandbox disabled: sandbox is enabled\nEPIPE: broken pipe\n");
    await settle();
    children[0].emit("close", 1);
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.error", turnId: handle.turnId, message: "EPIPE: broken pipe" })
    );
  });

  it("writes the exact control request on interrupt", async () => {
    const { driver, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    driver.interrupt(handle.turnId);
    await settle();
    const lines = children[0].written.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(
      /^\{"type":"control_request","request_id":"[0-9a-f-]{36}","request":\{"subtype":"interrupt"\}\}$/
    );
    driver.dispose();
  });

  it("evicts an idle process after the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const { driver, children, killed } = makeDriver();
      driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
      await settle();
      children[0].stdout.write(`${resultLine()}\n`);
      await settle();
      expect(killed).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(CLAUDE_IDLE_EVICT_MS);
      expect(killed).toHaveLength(1);
      driver.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ClaudeCliDriver getAccountUsage", () => {
  it("resolves a not-installed state instead of throwing when spawnFn throws ENOENT synchronously", async () => {
    const events: ThreadEvent[] = [];
    const spawnFn = (() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as unknown as ClaudeSpawnFn;
    const driver = new ClaudeCliDriver((event) => events.push(event), () => SETTINGS, spawnFn, () => {});
    await expect(driver.getAccountUsage()).resolves.toEqual({
      status: "unavailable",
      reason: "not-installed",
      message: "Claude isn't installed. Set its path in Settings → Harnesses → Claude."
    });
    driver.dispose();
  });

  it("resolves an error state instead of throwing when spawnFn throws a non-ENOENT error synchronously", async () => {
    const events: ThreadEvent[] = [];
    const spawnFn = (() => {
      throw new Error("boom");
    }) as unknown as ClaudeSpawnFn;
    const driver = new ClaudeCliDriver((event) => events.push(event), () => SETTINGS, spawnFn, () => {});
    await expect(driver.getAccountUsage()).resolves.toEqual({
      status: "error",
      message: "failed to spawn claude: boom"
    });
    driver.dispose();
  });
});
