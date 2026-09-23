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
  gitBinaryPath: "git",
  githubCliBinaryPath: "gh",
  sourceControlRefreshIntervalSeconds: 30,
  defaultUseWorktree: true,
  holdingHours: 6,
  autoTitleEnabled: true,
  autoTitleDriver: "claude",
  autoTitleModel: "claude-sonnet-5",
  autoTitleEffort: "low"
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

  it("ignores task notification results even when they report turns", async () => {
    const { driver, events, children, killed } = makeDriver();
    driver.startTurn({ sessionId: "s1", cwd: "C:\\proj", prompt: "go" });
    await settle();
    children[0].stdout.write(`${resultLine({ origin: { kind: "task-notification" }, num_turns: 3 })}\n`);
    await settle();
    expect(events.filter((event) => event.type === "turn.done")).toEqual([]);
    expect(killed).toEqual([]);
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
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: "agent-2", tool_use_id: "call-2", is_backgrounded: true })}\n`
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
