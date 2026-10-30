import { describe, expect, it, vi } from "bun:test";
import { advanceTimersByTimeAsync } from "../../../tests/testing.js";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSettings, HistoryMessage, TaskSnapshot, ThreadEvent } from "@cw-code/contracts";
import { buildClaudeArgs, CLAUDE_IDLE_EVICT_MS, ClaudeCliDriver, claudeSettingsPath, mapClaudeEffort, mapClaudePermission, mergeClaudeAllowRule, subagentToolsResult } from "./ClaudeCliDriver.js";
import { readClaudeHistoryFile } from "./claudeHistory.js";
import { SYNTHETIC_FULL_ACCESS_DESCRIPTION } from "../permissions.js";

const SETTINGS: AppSettings = {
  claudeBinaryPath: "claude",
  opencodeBinaryPath: "opencode",
  codexBinaryPath: "codex",
  claudeExtraArgs: "",
  opencodeExtraArgs: "",
  codexExtraArgs: "",
  claudeDefaultModel: "",
  codexDefaultModel: "",
  opencodeDefaultModel: "",
  claudeEnabledModels: [],
  claudeCustomModel: { id: "", name: "" },
  claudeReasoningExpanded: false,
  claudeChromeEnabled: false,
  opencodeReasoningExpanded: false,
  codexReasoningExpanded: false,
  opencodeGoUsage: false,
  updateChannel: null,
  updateBackgroundDownload: true,
  harnessUpdateChecks: true,
  gitBinaryPath: "git",
  githubCliBinaryPath: "gh",
  sourceControlRefreshIntervalSeconds: 30,
  defaultUseWorktree: true,
  prFinishedSessionStatus: "idle",
  idleResolveAfterDays: 30,
  holdingHours: 6,
  holdingAutoExpireEnabled: false,
  autoTitleEnabled: true,
  autoTitleDriver: "claude",
  autoTitleModel: "claude-sonnet-5",
  autoTitleEffort: "low",
  prRefreshIntervalSeconds: 120,
  prCloneRoot: "~/.cw-code/repos",
  prCloneIncludeOwner: true,
  prAttributionEnabled: true,
  prAttributionText: "",
  prWorkflows: [],
  githubSavedViews: [],
  fontFamilySans: "",
  fontFamilyMono: "",
  fontFamilyPrompt: "",
  fontFamilyTerminal: "",
  fontSizeInterface: 16,
  fontSizeCode: 14,
  fontSizePrompt: 14,
  fontSizeTerminal: 14,
  typographyAdvanced: false,
  panelAnimationMs: 0,
  themeId: "dark",
  customThemes: [],
  serverBindHost: "",
  keepServerRunning: false,
  serverPublicUrl: "",
  notificationSounds: {
    done: { enabled: true, sound: "felt-chord", volume: 60 },
    question: { enabled: true, sound: "triple-tap", volume: 60 },
    prUpdate: { enabled: true, sound: "tock-down", volume: 60 }
  }
};

describe("mapClaudePermission", () => {
  it("passes through supported modes", () => {
    expect(mapClaudePermission("auto")).toBe("auto");
    expect(mapClaudePermission("acceptEdits")).toBe("acceptEdits");
    expect(mapClaudePermission("manual")).toBe("manual");
  });

  it("maps bypass to manual so the CLI prompts and the driver auto-accepts", () => {
    expect(mapClaudePermission("bypassPermissions")).toBe("manual");
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

  it("spawns a bypass session with the manual permission flag", () => {
    const args = buildClaudeArgs({ permissionMode: "bypassPermissions" });
    const modePos = args.indexOf("--permission-mode");
    expect(args[modePos + 1]).toBe("manual");
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

  it("lists permission modes with full access marked synthetic", async () => {
    const { driver } = makeDriver();
    const modes = await driver.listPermissionModes();
    expect(modes.map((m) => m.id)).toEqual(["manual", "acceptEdits", "auto", "bypassPermissions"]);
    expect(modes.map((m) => m.label)).toEqual(["Manual", "Accept edits", "Auto", "Bypass permissions"]);
    expect(modes.map((m) => m.native)).toEqual([true, true, true, false]);
    expect(modes.find((m) => m.id === "bypassPermissions")?.description).toBe(SYNTHETIC_FULL_ACCESS_DESCRIPTION);
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

function makeDriver(
  isInWorkingSet: (sessionId: string) => boolean = () => false,
  getSettings: () => AppSettings = () => SETTINGS,
  claudePluginDir: () => string | null = () => null
) {
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
    getSettings,
    spawnFn,
    (proc) => killed.push(proc),
    isInWorkingSet,
    claudePluginDir
  );
  return { driver, events, children, spawnCalls, killed };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
}

const END_TIME = Date.now() + 60_000;

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

function taskStartedLine(taskId: string, toolUseId: string, taskType?: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    ...(taskType ? { task_type: taskType } : {}),
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

function taskUpdates(events: ThreadEvent[], id: string): TaskSnapshot[] {
  return events.flatMap((event) => (event.type === "task.updated" && event.task.id === id ? [event.task] : []));
}

function finalTask(events: ThreadEvent[], id: string): TaskSnapshot | undefined {
  return taskUpdates(events, id).at(-1);
}

function streamFixture(name: string): string[] {
  const path = fileURLToPath(new URL(`./__fixtures__/tasks/${name}/stream.jsonl`, import.meta.url));
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function replayFixture(name: string): HistoryMessage[] {
  const source = fileURLToPath(new URL(`./__fixtures__/tasks/${name}`, import.meta.url));
  const transcript = readFileSync(join(source, "transcript.jsonl"), "utf8");
  const cursor = (JSON.parse(transcript.split("\n").find((line) => line.includes('"sessionId"')) ?? "{}") as { sessionId?: string }).sessionId ?? name;
  const dir = mkdtempSync(join(tmpdir(), "cw-claude-parity-"));
  writeFileSync(join(dir, `${cursor}.jsonl`), transcript);
  mkdirSync(join(dir, cursor, "subagents"), { recursive: true });
  for (const meta of readdirSync(join(source, "subagents"))) {
    writeFileSync(join(dir, cursor, "subagents", meta), readFileSync(join(source, "subagents", meta)));
  }
  return readClaudeHistoryFile(join(dir, `${cursor}.jsonl`), cursor);
}

async function feedLines(child: FakeChild, lines: string[]): Promise<void> {
  for (const line of lines) {
    child.stdout.write(`${line}\n`);
    await settle();
  }
}

describe("ClaudeCliDriver persistent process", () => {
  it("keeps API limit errors separate from prose and later task reports", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    const limit = "You've hit your session limit · resets 6:50pm (America/Sao_Paulo)";
    children[0].stdout.write(`${taskStartedLine("task-1", "call-1")}\n`);
    children[0].stdout.write(`${JSON.stringify({
      type: "assistant", isApiErrorMessage: true, error: "rate_limit",
      message: { content: [{ type: "text", text: limit }] }
    })}\n`);
    children[0].stdout.write(`${taskNotificationLine("task-1", "call-1", "Run typecheck, log to scratchpad")}\n`);
    children[0].stdout.write(`${resultLine({ result: "" })}\n`);
    await settle();
    expect(events.filter((event) => event.type === "assistant.delta")).toEqual([]);
    expect(toolResults(events)).toEqual([]);
    expect(finalTask(events, "call-1")).toMatchObject({ state: "completed", output: "Run typecheck, log to scratchpad" });
    expect(turnDones(events)).toContainEqual(expect.objectContaining({ isError: true, resultText: limit }));
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "continue" });
    await settle();
    children[0].stdout.write(`${resultLine()}\n`);
    await settle();
    expect(turnDones(events).at(-1)).toEqual(expect.objectContaining({ isError: false }));
    driver.dispose();
  });

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

  it("launches with --chrome only while Claude in Chrome is enabled, respawning when it changes", async () => {
    let settings: AppSettings = { ...SETTINGS, claudeChromeEnabled: true };
    const { driver, children, spawnCalls } = makeDriver(() => false, () => settings);
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "first" });
    await settle();
    children[0].stdout.write(`${resultLine()}\n`);
    await settle();
    expect(spawnCalls[0]?.args).toContain("--chrome");

    settings = { ...SETTINGS, claudeChromeEnabled: false };
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "second" });
    await settle();
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]?.args).not.toContain("--chrome");
    driver.dispose();
  });

  it("respawns the process when the session's agent token changes, keeping it while the token stays", async () => {
    const { driver, children, spawnCalls } = makeDriver();
    const turn = async (token: string, child: number): Promise<void> => {
      driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go", env: { CW_AGENT_TOKEN: token } });
      await settle();
      children[child]?.stdout.write(`${resultLine()}\n`);
      await settle();
    };
    await turn("token-a", 0);
    await turn("token-a", 0);
    expect(spawnCalls).toHaveLength(1);
    await turn("token-b", 1);
    expect(spawnCalls).toHaveLength(2);
    driver.dispose();
  });

  it("never launches auto-title turns with --chrome", async () => {
    const { driver, spawnCalls } = makeDriver(() => false, () => ({ ...SETTINGS, claudeChromeEnabled: true }));
    driver.startTurn({ sessionId: "title:s1", cwd: "C:\\proj", prompt: "title this", maxTurns: 1 });
    await settle();
    expect(spawnCalls[0]?.args).not.toContain("--chrome");
    driver.dispose();
  });

  it("launches regular turns with the cw plugin directory", async () => {
    const { driver, spawnCalls } = makeDriver(() => false, () => SETTINGS, () => "C:\\plugin");
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "work" });
    await settle();
    const args = spawnCalls[0]?.args ?? [];
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe("C:\\plugin");
    driver.dispose();
  });

  it("never launches auto-title turns with the cw plugin directory", async () => {
    const { driver, spawnCalls } = makeDriver(() => false, () => SETTINGS, () => "C:\\plugin");
    driver.startTurn({ sessionId: "title:s1", cwd: "C:\\proj", prompt: "title this", maxTurns: 1 });
    await settle();
    expect(spawnCalls[0]?.args).not.toContain("--plugin-dir");
    driver.dispose();
  });

  it("launches without the plugin directory while it is unavailable", async () => {
    const { driver, spawnCalls } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "work" });
    await settle();
    expect(spawnCalls[0]?.args).not.toContain("--plugin-dir");
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

  it("auto-answers control requests for a bypass session without emitting an approval", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go", permissionMode: "bypassPermissions" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: "req-1",
        request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tu-1", input: { command: "rm -rf tmp" } }
      })}\n`
    );
    await settle();
    const lines = children[0].written.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: { command: "rm -rf tmp" } }
      }
    });
    expect(events.some((event) => event.type === "approval.request")).toBe(false);
    driver.dispose();
  });

  it("emits the reported permission mode when it changes and clears it when init omits it", async () => {
    const { driver, events, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go", permissionMode: "bypassPermissions" });
    await settle();
    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "init", permissionMode: "manual" })}\n`);
    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "init", permissionMode: "manual" })}\n`);
    await settle();
    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "init", permissionMode: "acceptEdits" })}\n`);
    await settle();
    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
    await settle();
    expect(events.filter((event) => event.type === "permission.mode.reported")).toEqual([
      { type: "permission.mode.reported", turnId: handle.turnId, mode: "manual" },
      { type: "permission.mode.reported", turnId: handle.turnId, mode: "acceptEdits" },
      { type: "permission.mode.reported", turnId: handle.turnId, mode: null }
    ]);
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
    const taskId = "aa6598debd48b1c22";
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
    expect(results.filter((event) => event.toolCallId === agentCallId).map((event) => event.output)).toEqual([
      expect.stringContaining("Async agent launched successfully")
    ]);
    expect(results.some((event) => event.output === notificationText)).toBe(false);
    expect(taskUpdates(events, agentCallId).some((task) => task.output === notificationText)).toBe(false);
    expect(finalTask(events, agentCallId)).toMatchObject({
      cliTaskId: taskId,
      kind: "agent",
      background: true,
      state: "completed",
      runCount: 1,
      output: report,
      usage: { tokens: 1200, toolUses: 3, durationMs: 900 }
    });
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
    children[0].stdout.write(`${taskStartedLine("task-bash", "call-bash", "local_bash")}\n`);
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
      expect.stringContaining("Async agent launched successfully")
    ]);
    expect(results.filter((event) => event.toolCallId === "call-bash").map((event) => event.output)).toEqual([
      expect.stringContaining("Command running in background")
    ]);
    expect(finalTask(events, "call-agent")).toMatchObject({ kind: "agent", state: "completed", output: "agent report" });
    expect(finalTask(events, "call-bash")).toMatchObject({ kind: "shell", state: "unknown", endReason: "roster" });
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([2, 0]);
    driver.dispose();
  });

  it("keeps the turn working while a SendMessage-resumed agent runs in the background", async () => {
    const { driver, events, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    const taskId = "ab7488a5ab7cc189e";
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { subagent_type: "general-purpose", run_in_background: false } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: "agent-call", task_type: "local_agent", is_backgrounded: false })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", parent_tool_use_id: "agent-call", message: { content: [{ type: "tool_use", id: "handback-1", name: "SubagentHandback", input: { message: "READY" } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: "agent-call", status: "completed" })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "agent-call", content: [{ type: "text", text: "This agent's report was delivered to you as a message." }] }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "send-call", name: "SendMessage", input: { to: taskId, message: "keep going" } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: taskId, task_type: "local_agent", subagent_type: "general-purpose" }] })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: "send-call", task_type: "local_agent", is_backgrounded: true })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "send-call", content: [{ type: "text", text: JSON.stringify({ success: true, message: "Resuming agent ab7488a" }) }] }] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "waiting", num_turns: 3 })}\n`);
    await settle();

    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([1]);
    expect(driver.liveTasks("s1")).toEqual([
      expect.objectContaining({ id: "agent-call", cliTaskId: taskId, background: true, state: "running", runCount: 2 })
    ]);

    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", parent_tool_use_id: "agent-call", message: { content: [{ type: "tool_use", id: "handback-2", name: "SubagentHandback", input: { message: "DONE" } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: "send-call", status: "completed" })}\n`
    );
    children[0].stdout.write(`${taskChangeLineWithIds([])}\n`);
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "agent finished", num_turns: 4 })}\n`
    );
    await settle();

    const dones = turnDones(events);
    expect(dones.map((event) => event.backgroundTasks)).toEqual([1, 0]);
    expect(dones[1]).toMatchObject({ turnId: handle.turnId, resultText: "agent finished" });
    expect(finalTask(events, "agent-call")).toMatchObject({ state: "completed", runCount: 2, output: "DONE" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.call", toolCallId: "send-call", parentToolCallId: "agent-call" }));
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
    expect(finalTask(events, "agent-call")).toMatchObject({ state: "completed", output: "final report" });
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

    expect(toolResults(events)).toEqual([]);
    expect(finalTask(events, toolCallId)).toMatchObject({
      cliTaskId: taskId,
      kind: "agent",
      state: "completed",
      endReason: "cli",
      output: "notification report"
    });
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
    expect(finalTask(events, "call-1")).toMatchObject({
      cliTaskId: "foreground-task",
      background: false,
      state: "completed",
      endReason: "tool-result",
      output: "foreground report"
    });
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

    expect(toolResults(events).filter((event) => event.toolCallId === "agent-call")).toEqual([]);
    expect(taskUpdates(events, "agent-call").map((task) => [task.state, task.output])).toEqual([
      ["running", undefined],
      ["completed", "short summary"],
      ["completed", "full Handback report"]
    ]);
    expect(finalTask(events, "agent-call")).toMatchObject({ usage: { tokens: 1200 } });
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
    expect(finalTask(events, "foreground-call")).toMatchObject({ state: "completed", output: "foreground report" });
    expect(events.some((event) => event.type === "task.updated" && event.task.id !== "foreground-call")).toBe(false);

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

    expect(toolResults(events)).toEqual([]);
    expect(finalTask(events, "call-a")).toMatchObject({ cliTaskId: "task-a", state: "completed", output: "mapped report" });
    expect(finalTask(events, "call-b")).toMatchObject({ cliTaskId: "task-b", state: "unknown", endReason: "roster" });
    expect(finalTask(events, "call-b")).not.toHaveProperty("output");
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
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "completed", end_time: END_TIME } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary: "DONE" })}\n`
    );
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: undefined, session_id: "native-1" })}\n`
    );
    await settle();

    expect(toolResults(events)).toEqual([]);
    expect(finalTask(events, toolCallId)).toMatchObject({ cliTaskId: taskId, state: "completed", endedAt: END_TIME, output: "DONE" });
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
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "agent-1", patch: { status: "completed", end_time: END_TIME } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: "call-1", status: "completed", summary: "DONE", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 900 } })}\n`
    );
    await settle();
    expect(toolResults(events)).toEqual([]);
    expect(finalTask(events, "call-1")).toEqual({
      id: "call-1",
      cliTaskId: "agent-1",
      kind: "agent",
      background: true,
      state: "completed",
      endReason: "cli",
      runCount: 1,
      startedAt: expect.any(Number),
      endedAt: END_TIME,
      output: "DONE",
      usage: { tokens: 1200, toolUses: 3, durationMs: 900 }
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "task.updated", sessionId: "s1", task: expect.objectContaining({ id: "call-1" }) }));
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
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "agent-2", patch: { status: "failed", end_time: END_TIME } })}\n`
    );
    await settle();
    expect(toolResults(events)).toEqual([]);
    expect(finalTask(events, "call-2")).toMatchObject({ kind: "agent", state: "failed", endReason: "cli", endedAt: END_TIME });
    expect(finalTask(events, "call-2")).not.toHaveProperty("output");
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

    expect(toolResults(events)).toEqual([]);
    expect(taskUpdates(events, "call-1").map((task) => [task.state, task.output])).toEqual([
      ["running", undefined],
      ["failed", undefined],
      ["failed", "Permission denied reading C:/secret.txt"]
    ]);
    expect(finalTask(events, "call-1")).toMatchObject({ usage: { tokens: 1200, toolUses: 3, durationMs: 900 } });
    driver.dispose();
  });

  it("keeps the turn active until a background shell notification completes", async () => {
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
      expect.objectContaining({ turnId: handle.turnId, resultText: "STARTED", backgroundTasks: 1 })
    ]);

    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] })}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "bash-1", patch: { status: "completed", end_time: END_TIME } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bash-1", tool_use_id: "call-bash", status: "completed", summary: "Background command \"sleep 20\" completed (exit code 0)" })}\n`
    );
    children[0].stdout.write(
      `${resultLine({ origin: { kind: "task-notification" }, result: "Background task completed.", num_turns: 1 })}\n`
    );
    await settle();

    expect(turnDones(events)).toEqual([
      expect.objectContaining({ turnId: handle.turnId, resultText: "STARTED", backgroundTasks: 1 }),
      expect.objectContaining({ turnId: handle.turnId, resultText: "Background task completed.", backgroundTasks: 0 })
    ]);
    expect(toolResults(events).filter((event) => event.toolCallId === "call-bash").map((event) => event.output)).toEqual([
      "Command running in background with ID: bash-1.",
      "Background command \"sleep 20\" completed (exit code 0)"
    ]);
    expect(finalTask(events, "call-bash")).toMatchObject({
      cliTaskId: "bash-1",
      kind: "shell",
      state: "completed",
      output: "Background command \"sleep 20\" completed (exit code 0)"
    });
    expect(killed).toEqual([]);
    driver.dispose();
  });

  it("does not evict a shell watcher during a long CI wait", async () => {
    vi.useFakeTimers();
    try {
      const { driver, events, children, killed } = makeDriver();
      const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "start CI" });
      await settle();
      children[0].stdout.write(
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-bash", name: "Bash", input: { command: "wait for CI", run_in_background: true } }] } })}\n`
      );
      children[0].stdout.write(
        `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "call-bash", task_type: "local_bash" })}\n`
      );
      children[0].stdout.write(`${resultLine({ result: "Waiting for CI" })}\n`);
      await settle();

      await advanceTimersByTimeAsync(CLAUDE_IDLE_EVICT_MS * 2);
      expect(killed).toHaveLength(0);

      children[0].stdout.write(
        `${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] })}\n`
      );
      children[0].stdout.write(
        `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bash-1", tool_use_id: "call-bash", status: "completed", summary: "CI passed" })}\n`
      );
      children[0].stdout.write(
        `${resultLine({ origin: { kind: "task-notification" }, result: "CI passed" })}\n`
      );
      await settle();

      expect(turnDones(events).map((event) => [event.turnId, event.resultText, event.backgroundTasks])).toEqual([
        [handle.turnId, "Waiting for CI", 1],
        [handle.turnId, "CI passed", 0]
      ]);
      expect(finalTask(events, "call-bash")).toMatchObject({ kind: "shell", state: "completed", output: "CI passed" });
      await advanceTimersByTimeAsync(CLAUDE_IDLE_EVICT_MS);
      expect(killed).toHaveLength(1);
      driver.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels failed non-Agent background tasks without Agent metadata", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "call-bash", task_type: "local_bash", is_backgrounded: true })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "bash-1", patch: { status: "failed", end_time: END_TIME } })}\n`
    );
    await settle();
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.result",
      toolCallId: "call-bash",
      output: "Background task failed",
      isError: true
    }));
    expect(toolResults(events)[0]).not.toHaveProperty("agentId");
    expect(finalTask(events, "call-bash")).toMatchObject({ kind: "shell", state: "failed", endReason: "cli" });
    driver.dispose();
  });

  it("emits a shell result again only when its text changes", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(`${taskStartedLine("bash-1", "call-bash", "local_bash")}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "bash-1", patch: { status: "killed" } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "bash-1", patch: { status: "killed", end_time: END_TIME } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bash-1", tool_use_id: "call-bash", status: "killed", summary: "Background command was stopped" })}\n`
    );
    await settle();
    expect(toolResults(events).map((event) => [event.output, event.isError])).toEqual([
      ["Background task stopped", true],
      ["Background command was stopped", true]
    ]);
    driver.dispose();
  });

  it("closes a foreground Agent with its turn while a background Agent keeps running", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "fg-call", name: "Agent", input: { run_in_background: false } },
        { type: "tool_use", id: "bg-call", name: "Agent", input: { run_in_background: true } }
      ] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "waiting" })}\n`);
    await settle();

    expect(finalTask(events, "fg-call")).toMatchObject({ state: "unknown", endReason: "no-record" });
    expect(taskUpdates(events, "bg-call")).toEqual([]);
    expect(driver.liveTasks("s1").find((task) => task.id === "bg-call")).toMatchObject({ state: "running" });
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([1]);
    driver.dispose();
  });

  it("carries the task snapshot on Agent calls and lists live tasks per session", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "call-1", name: "Agent", input: { run_in_background: true } },
        { type: "tool_use", id: "call-read", name: "Read", input: { path: "a.ts" } }
      ] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine("task-1", "call-1", "local_agent")}\n`);
    await settle();

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.call",
      toolCallId: "call-1",
      task: expect.objectContaining({ id: "call-1", kind: "agent", background: true, state: "running", runCount: 1 })
    }));
    expect(events.find((event) => event.type === "tool.call" && event.toolCallId === "call-read")).not.toHaveProperty("task");
    expect(driver.liveTasks("s1")).toEqual([
      expect.objectContaining({ id: "call-1", cliTaskId: "task-1", kind: "agent", state: "running" })
    ]);
    expect(driver.liveTasks("other")).toEqual([]);
    driver.dispose();
  });

  it("interrupts open tasks when the process exits mid-background-task", async () => {
    const { driver, events, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Agent", input: { run_in_background: true } }] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine("task-1", "call-1", "local_agent")}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-1"])}\n`);
    children[0].stdout.write(`${resultLine({ result: "waiting" })}\n`);
    await settle();
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([1]);

    children[0].emit("close", 1);
    await settle();

    expect(events.filter((event) => event.type === "task.updated").at(-1)).toMatchObject({
      turnId: handle.turnId,
      sessionId: "s1",
      task: { id: "call-1", state: "interrupted", endReason: "process-exit" }
    });
    expect(driver.liveTasks("s1")).toEqual([]);
    driver.dispose();
  });

  it("interrupts open tasks on stopSession without a synthetic shell result", async () => {
    const { driver, events, children, killed } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "call-agent", name: "Agent", input: { run_in_background: true } },
        { type: "tool_use", id: "call-bash", name: "Bash", input: { command: "sleep 20", run_in_background: true } }
      ] } })}\n`
    );
    await settle();

    driver.stopSession("s1");

    expect(finalTask(events, "call-agent")).toMatchObject({ state: "interrupted", endReason: "process-exit" });
    expect(finalTask(events, "call-bash")).toMatchObject({ kind: "shell", state: "interrupted", endReason: "process-exit" });
    expect(toolResults(events)).toEqual([]);
    expect(killed).toEqual([children[0]]);
    const updates = events.filter((event) => event.type === "task.updated").length;
    children[0].emit("close", null);
    await settle();
    expect(events.filter((event) => event.type === "task.updated")).toHaveLength(updates);
  });

  it("replays the recorded hooks-probe stream to final task states", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    await feedLines(children[0], streamFixture("hooks-probe"));

    expect(finalTask(events, "toolu_01DaQjvfNQDvgKAiv1WcJNYS")).toMatchObject({
      cliTaskId: "a5fd6f29192d6b105",
      kind: "agent",
      background: true,
      state: "completed",
      runCount: 2,
      output: "PONG2"
    });
    expect(finalTask(events, "toolu_01RDYCbJfdYE4q12sgc97ETw")).toMatchObject({
      cliTaskId: "a74a561c109a552e8",
      kind: "agent",
      state: "stopped",
      runCount: 1,
      output: "sleeper"
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool.call", name: "SubagentHandback" }));
    expect(toolResults(events).filter((event) => event.toolCallId === "toolu_01DaQjvfNQDvgKAiv1WcJNYS").map((event) => event.output)).toEqual([
      expect.stringContaining("Async agent launched successfully")
    ]);
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([0]);
    driver.dispose();
  });

  it("replays the recorded handback-probe stream with the Handback report as output", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    await feedLines(children[0], streamFixture("handback-probe"));

    expect(finalTask(events, "toolu_019cYvRiA4JYiUUSq18cKuos")).toMatchObject({
      cliTaskId: "a087ca34d38140971",
      kind: "agent",
      background: true,
      state: "completed",
      runCount: 1,
      output: "PONG",
      usage: expect.objectContaining({ tokens: expect.any(Number) })
    });
    expect(toolResults(events).filter((event) => event.toolCallId === "toolu_013xAq8DwJuD54JEueDV4y3d")).toEqual([]);
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([0, 0]);
    driver.dispose();
  });

  it.each(["hooks-probe", "handback-probe"])("ends every %s task in the same state live and replayed from its transcript", async (probe) => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    await feedLines(children[0], streamFixture(probe));
    driver.dispose();

    const replayed = replayFixture(probe).flatMap((message) => (message.task ? [message.task] : []));
    const agents = replayed.filter((task) => task.kind === "agent");
    expect(agents.length).toBeGreaterThan(0);
    const comparable = (task: TaskSnapshot | undefined) =>
      task && { state: task.state, runCount: task.runCount, kind: task.kind, background: task.background, cliTaskId: task.cliTaskId };
    for (const task of agents) {
      expect(comparable(finalTask(events, task.id)), task.id).toEqual(comparable(task));
      if (task.output === "PONG" || task.output === "PONG2") expect(finalTask(events, task.id)?.output).toBe(task.output);
    }
  });

  it("emits no shell result for a shell task known only by its CLI task id", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "bash-orphan", task_type: "local_bash", is_backgrounded: true })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_updated", task_id: "bash-orphan", patch: { status: "failed", end_time: END_TIME } })}\n`
    );
    await settle();

    expect(finalTask(events, "bash-orphan")).toMatchObject({ kind: "shell", state: "failed" });
    expect(toolResults(events)).toEqual([]);
    driver.dispose();
  });

  it("ends a background shell whose launch was denied instead of holding the session", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "sleep 100", run_in_background: true } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", is_error: true, content: "The user doesn't want to proceed with this tool use." }] } })}\n`
    );
    children[0].stdout.write(`${resultLine()}\n`);
    await settle();

    expect(finalTask(events, "bash-1")).toMatchObject({ kind: "shell", state: "failed", endReason: "tool-result" });
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([0]);
    expect(driver.activity().busySessionIds).toEqual([]);
    driver.dispose();
  });

  it("closes agents nested in a background agent once that agent is stopped", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    const write = (line: unknown) => children[0].stdout.write(`${JSON.stringify(line)}\n`);
    write({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-bg", name: "Agent", input: { run_in_background: true } }] } });
    write({ type: "system", subtype: "task_started", task_id: "t-bg", tool_use_id: "call-bg", task_type: "local_agent", is_backgrounded: true });
    write({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t-bg" }] });
    write({ type: "assistant", parent_tool_use_id: "call-bg", message: { content: [{ type: "tool_use", id: "call-nested", name: "Agent", input: { prompt: "x" } }] } });
    write(JSON.parse(resultLine()));
    await settle();
    write({ type: "system", subtype: "task_updated", task_id: "t-bg", patch: { status: "killed" } });
    write({ type: "system", subtype: "task_notification", task_id: "t-bg", tool_use_id: "call-bg", status: "stopped" });
    write({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    write(JSON.parse(resultLine({ origin: { kind: "task-notification" } })));
    await settle();

    expect(finalTask(events, "call-bg")).toMatchObject({ state: "stopped" });
    expect(finalTask(events, "call-nested")).toMatchObject({ state: "unknown", endReason: "no-record" });
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([1, 0]);
    expect(driver.liveTasks("s1").filter((task) => task.state === "running")).toEqual([]);
    driver.dispose();
  });

  it("does not answer a later turn with an earlier turn's subagent report", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "one" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-fg", name: "Agent", input: { run_in_background: false } }] } })}\n`
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-fg", content: "REPORT FROM TURN ONE" }] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "turn one answer" })}\n`);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "two" });
    await settle();
    children[0].stdout.write(`${resultLine({ subtype: "error_during_execution", is_error: true, result: undefined })}\n`);
    await settle();

    expect(children).toHaveLength(1);
    expect(turnDones(events).at(-1)).toMatchObject({ isError: true, resultText: "" });
    driver.dispose();
  });

  it("lists only running or current-turn tasks live once a reused process starts a new turn", async () => {
    const { driver, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "one" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "call-fg", name: "Agent", input: { run_in_background: false } },
        { type: "tool_use", id: "call-bg", name: "Agent", input: { run_in_background: true } }
      ] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine("task-bg", "call-bg")}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-bg"])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-fg", content: "first report" }] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "turn one" })}\n`);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 5));

    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "two" });
    await settle();

    expect(children).toHaveLength(1);
    expect(driver.liveTasks("s1").map((task) => [task.id, task.state])).toEqual([["call-bg", "running"]]);
    driver.dispose();
  });

  it("labels a foreground agent cut off by an interrupt as interrupted", async () => {
    const { driver, events, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-fg", name: "Agent", input: { run_in_background: false } }] } })}\n`
    );
    await settle();
    driver.interrupt(handle.turnId);
    children[0].stdout.write(`${resultLine({ subtype: "error_during_execution", is_error: true })}\n`);
    await settle();

    expect(finalTask(events, "call-fg")).toMatchObject({ state: "interrupted", endReason: "interrupt" });
    driver.dispose();
  });

  it("closes a top-level foreground agent with its turn but not one nested in a running background agent", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "call-bg", name: "Agent", input: { run_in_background: true } },
        { type: "tool_use", id: "call-fg", name: "Agent", input: { run_in_background: false } }
      ] } })}\n`
    );
    children[0].stdout.write(`${taskStartedLine("task-bg", "call-bg")}\n`);
    children[0].stdout.write(`${taskChangeLineWithIds(["task-bg"])}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "assistant", parent_tool_use_id: "call-bg", message: { content: [{ type: "tool_use", id: "call-nested", name: "Agent", input: { run_in_background: false } }] } })}\n`
    );
    children[0].stdout.write(`${resultLine({ result: "waiting" })}\n`);
    await settle();

    expect(finalTask(events, "call-fg")).toMatchObject({ state: "unknown", endReason: "no-record" });
    expect(finalTask(events, "call-nested")?.state ?? "running").toBe("running");
    expect(finalTask(events, "call-bg")).toMatchObject({ state: "running" });
    expect(turnDones(events).map((event) => event.backgroundTasks)).toEqual([1]);
    driver.dispose();
  });

  it("emits turn.error with stderr when the process closes mid-turn", async () => {
    const { driver, events, children } = makeDriver();
    const handle = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "cli-session-1" })}\n`);
    children[0].stderr.write("Sandbox disabled");
    await settle();
    children[0].emit("close", 1);
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        turnId: handle.turnId,
        message: "claude exited before completing the turn (code 1)",
        resumeCursor: "cli-session-1"
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
      await advanceTimersByTimeAsync(CLAUDE_IDLE_EVICT_MS);
      expect(killed).toHaveLength(1);
      driver.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a working-set session's process warm across repeated idle timeouts", async () => {
    vi.useFakeTimers();
    try {
      const { driver, children, killed } = makeDriver(() => true);
      driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
      await settle();
      children[0].stdout.write(`${resultLine()}\n`);
      await settle();
      for (let hour = 0; hour < 12; hour += 1) {
        await advanceTimersByTimeAsync(CLAUDE_IDLE_EVICT_MS);
        expect(killed).toHaveLength(0);
      }
      driver.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts a session that left the working set on the next idle timeout", async () => {
    vi.useFakeTimers();
    try {
      let inWorkingSet = true;
      const { driver, children, killed } = makeDriver(() => inWorkingSet);
      driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
      await settle();
      children[0].stdout.write(`${resultLine()}\n`);
      await settle();
      await advanceTimersByTimeAsync(CLAUDE_IDLE_EVICT_MS);
      expect(killed).toHaveLength(0);
      inWorkingSet = false;
      await advanceTimersByTimeAsync(CLAUDE_IDLE_EVICT_MS);
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

describe("ClaudeCliDriver shutdown", () => {
  it("reports every busy session and the processes it owns", () => {
    const { driver } = makeDriver();
    driver.startTurn({ sessionId: "sess_1", prompt: "work", cwd: "C:\\proj" });
    driver.startTurn({ sessionId: "title:sess_1", prompt: "title", cwd: "C:\\titles", maxTurns: 1 });
    expect(driver.activity()).toEqual({ busySessionIds: ["sess_1", "title:sess_1"], ownedProcesses: 2 });
    driver.dispose();
  });

  it("reports a session busy while output after a completed turn is still arriving", async () => {
    const { driver, children } = makeDriver();
    driver.startTurn({ sessionId: "sess_1", prompt: "work", cwd: "C:\\proj" });
    await settle();
    children[0].stdout.write(`${resultLine()}\n`);
    await settle();
    expect(driver.activity().busySessionIds).toEqual([]);
    children[0].stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "late" }] } })}\n`);
    await settle();
    expect(driver.activity().busySessionIds).toEqual(["sess_1"]);
    driver.dispose();
  });

  it("reports a session busy after an interrupt until the CLI acknowledges it", async () => {
    const { driver, children } = makeDriver();
    const { turnId } = driver.startTurn({ sessionId: "sess_1", prompt: "work", cwd: "C:\\proj" });
    await settle();
    driver.interrupt(turnId);
    expect(driver.activity().busySessionIds).toEqual(["sess_1"]);
    children[0].stdout.write(`${resultLine()}\n`);
    await settle();
    expect(driver.activity().busySessionIds).toEqual([]);
    driver.dispose();
  });

  it("closes stdin of every owned process and waits for them to exit without killing", async () => {
    const { driver, children, killed } = makeDriver();
    driver.startTurn({ sessionId: "sess_1", prompt: "work", cwd: "C:\\proj" });
    driver.startTurn({ sessionId: "sess_2", prompt: "more", cwd: "C:\\proj" });
    const pending = driver.shutdown({ timeoutMs: 1000 });
    for (const child of children) {
      expect(child.stdin.writableEnded).toBe(true);
      child.exitCode = 0;
      child.emit("exit", 0);
    }
    expect(await pending).toEqual({ timedOut: false });
    expect(killed).toEqual([]);
    driver.dispose();
    expect(killed).toEqual([]);
  });

  it("does not re-arm idle eviction while shutting down", async () => {
    vi.useFakeTimers();
    try {
      const { driver, children, killed } = makeDriver();
      driver.startTurn({ sessionId: "sess_1", prompt: "work", cwd: "C:\\proj" });
      const pending = driver.shutdown({ timeoutMs: 60 * 60 * 1000 });
      children[0].stdout.write(`${resultLine()}\n`);
      await advanceTimersByTimeAsync(CLAUDE_IDLE_EVICT_MS * 2);
      expect(killed).toEqual([]);
      expect(driver.activity().ownedProcesses).toBe(1);
      children[0].exitCode = 0;
      children[0].emit("exit", 0);
      expect(await pending).toEqual({ timedOut: false });
      expect(killed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a timeout and leaves the stragglers for dispose to force-stop", async () => {
    const { driver, children, killed } = makeDriver();
    driver.startTurn({ sessionId: "sess_1", prompt: "work", cwd: "C:\\proj" });
    expect(await driver.shutdown({ timeoutMs: 10 })).toEqual({ timedOut: true });
    expect(killed).toEqual([]);
    driver.dispose();
    expect(killed).toEqual([children[0]]);
    expect(driver.activity().ownedProcesses).toBe(0);
  });
});

describe("ClaudeCliDriver compaction", () => {
  function modelResultLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "native-1",
      result: "",
      num_turns: 1,
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 500,
          costUSD: 0.02,
          contextWindow: 200000,
          thinkingTokens: 0
        }
      },
      usage: {
        iterations: [
          { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 }
        ]
      },
      ...overrides
    });
  }

  it("emits context.compacted and reports postTokens as the new context on a compact turn", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "hello" });
    await settle();
    children[0].stdout.write(`${modelResultLine()}\n`);
    await settle();

    const second = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "/compact" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        session_id: "native-1",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 633409,
          post_tokens: 16048,
          cumulative_dropped_tokens: 617361
        }
      })}\n`
    );
    children[0].stdout.write(`${modelResultLine({ num_turns: 0, usage: { iterations: [] } })}\n`);
    await settle();

    expect(events).toContainEqual({
      type: "context.compacted",
      turnId: second.turnId,
      compaction: {
        trigger: "manual",
        preTokens: 633409,
        postTokens: 16048,
        droppedTokens: 617361
      },
      context: { usedTokens: 16048, windowTokens: 200000 }
    });
    const done = turnDones(events).find((event) => event.turnId === second.turnId);
    expect(done?.context).toEqual({ usedTokens: 16048, windowTokens: 200000 });
    driver.dispose();
  });

  it("does not carry a compact context into the following turn", async () => {
    const { driver, events, children } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "hello" });
    await settle();
    children[0].stdout.write(`${modelResultLine()}\n`);
    await settle();

    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "/compact" });
    await settle();
    children[0].stdout.write(
      `${JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 100, post_tokens: 10 }
      })}\n`
    );
    children[0].stdout.write(`${modelResultLine({ num_turns: 0, usage: { iterations: [] } })}\n`);
    await settle();

    const third = driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "again" });
    await settle();
    children[0].stdout.write(`${modelResultLine({ result: "ok" })}\n`);
    await settle();

    const done = turnDones(events).find((event) => event.turnId === third.turnId);
    expect(done?.context).toEqual({ usedTokens: 620, windowTokens: 200000 });
    driver.dispose();
  });
});
