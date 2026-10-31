import { describe, expect, it } from "bun:test";
import type { SubagentSummary } from "@cw-code/contracts";
import { backgroundWaitLabel, cwSubagentWork, liveBackgroundWork, sameBackgroundWork } from "./backgroundWork.js";
import type { ChatMessage } from "../stores/appStore.js";
import type { TaskSnapshot } from "../cw.js";

let seq = 0;
function tool(partial: Partial<ChatMessage>, task?: Partial<TaskSnapshot>): ChatMessage {
  const id = partial.id ?? `toolu_${seq}`;
  return {
    role: "tool",
    text: "",
    turnId: "t1",
    seq: seq++,
    id,
    toolDone: true,
    ...(task ? { task: { id, kind: "shell", background: true, state: "running", runCount: 1, ...task } } : {}),
    ...partial
  };
}

describe("liveBackgroundWork", () => {
  it("lists only running background tasks", () => {
    const items = [
      tool({ toolName: "Bash", toolInput: { command: "ls" } }),
      tool({ toolName: "Bash", toolInput: { command: "sleep 1" } }, { background: false }),
      tool({ toolName: "Bash", toolInput: { command: "sleep 2" } }, { state: "completed" }),
      tool({ id: "live", toolName: "Bash", toolInput: { command: "sleep 3" } }, { startedAt: 100 })
    ];

    expect(liveBackgroundWork(items)).toEqual([{ id: "live", kind: "shell", label: "sleep 3", startedAt: 100 }]);
  });

  it("labels a shell by its description and keeps the command as detail", () => {
    const items = [
      tool({ toolName: "Bash", toolInput: { description: "Wait for the deploy", command: "for i in $(seq 1 90);\n  do sleep 20; done" } }, {})
    ];

    expect(liveBackgroundWork(items)[0]).toMatchObject({
      label: "Wait for the deploy",
      detail: "for i in $(seq 1 90); do sleep 20; done"
    });
  });

  it("labels a subagent by description or prompt and falls back to the tool name", () => {
    const items = [
      tool({ toolName: "Agent", toolInput: { description: "Review diff", prompt: "Review it" } }, { kind: "agent" }),
      tool({ toolName: "Agent", toolInput: { input: { prompt: "Audit the API" } } }, { kind: "agent" }),
      tool({ toolName: "PowerShell" }, {})
    ];

    expect(liveBackgroundWork(items).map((w) => [w.label, w.detail])).toEqual([
      ["Review diff", "Review it"],
      ["Audit the API", undefined],
      ["PowerShell", undefined]
    ]);
  });
});

describe("cwSubagentWork", () => {
  function summary(id: string, status: SubagentSummary["status"], extra: Partial<SubagentSummary> = {}): SubagentSummary {
    return { id, driver: "opencode", title: `Task ${id}`, status, isolation: "shared", pendingRequests: 0, createdAt: 1, updatedAt: 2, ...extra };
  }

  it("lists working and input-required subagents with their harness, model and turn start", () => {
    const work = cwSubagentWork([
      summary("a", "working", { model: "opencode-go/deepseek-v4.1-flash", turnStartedAt: 900 }),
      summary("b", "done"),
      summary("c", "input-required", { driver: "codex" }),
      summary("d", "archived")
    ]);

    expect(work).toEqual([
      { id: "cw:a", kind: "agent", label: "Task a · OpenCode", detail: "opencode-go/deepseek-v4.1-flash", startedAt: 900 },
      { id: "cw:c", kind: "agent", label: "Task c · Codex" }
    ]);
    expect(backgroundWaitLabel(work)).toBe("waiting on 2 background subagents");
  });
});

describe("sameBackgroundWork", () => {
  it("compares the rendered fields", () => {
    const a = [{ id: "x", kind: "shell" as const, label: "a", startedAt: 1 }];

    expect(sameBackgroundWork(a, [{ ...a[0] }])).toBe(true);
    expect(sameBackgroundWork(a, [{ ...a[0], label: "b" }])).toBe(false);
    expect(sameBackgroundWork(a, [])).toBe(false);
  });
});

describe("backgroundWaitLabel", () => {
  it("names the kind and count", () => {
    const shell = { id: "s", kind: "shell" as const, label: "s" };
    const agent = { id: "a", kind: "agent" as const, label: "a" };

    expect(backgroundWaitLabel([])).toBeUndefined();
    expect(backgroundWaitLabel([shell])).toBe("waiting on 1 background command");
    expect(backgroundWaitLabel([agent, agent])).toBe("waiting on 2 background subagents");
    expect(backgroundWaitLabel([shell, agent])).toBe("waiting on 2 background tasks");
  });
});
