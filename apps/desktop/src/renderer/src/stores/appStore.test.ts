import "../../../../tests/dom.js";
import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { HistoryMessage, TaskSnapshot, UpdateActionResult, UpdateState } from "@cw-code/contracts";
import { DEFAULT_COMPOSER, useAppStore } from "./appStore.js";
import { applyInstalledHarnesses } from "../server/appBridge.js";

describe("appStore tool.result", () => {
  beforeEach(() => {
    useAppStore.setState({ messagesBySession: {}, busyTurns: {}, pendingApprovals: {}, pendingQuestions: {} });
  });

  it("stores tool usage and preserves the parent tool call id", () => {
    const session = "sess_usage";
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "task",
      input: { prompt: "review" },
      parentToolCallId: "parent_1"
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "done",
      isError: false,
      usage: { tokens: 1200, toolUses: 3, durationMs: 900 }
    });
    const message = useAppStore.getState().messagesBySession[session][0];
    expect(message.toolUsage).toEqual({ tokens: 1200, toolUses: 3, durationMs: 900 });
    expect(message.parentToolCallId).toBe("parent_1");
    expect(message.toolDone).toBe(true);
    expect(message.toolOutput).toBe("done");
  });

  it("stores the subagent model reported with the tool result", () => {
    const session = "sess_model";
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "task",
      input: { description: "review" }
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "done",
      isError: false,
      agentId: "agent-1",
      model: "claude-sonnet-4-5"
    });
    const message = useAppStore.getState().messagesBySession[session][0];
    expect(message.subagentModel).toBe("claude-sonnet-4-5");
    expect(message.subagentAgentId).toBe("agent-1");
  });

  it("updates a result-only row when a later task notification has details", () => {
    const session = "sess_task_failure";
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "Subagent failed",
      isError: true
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "Permission denied reading C:/secret.txt",
      isError: true,
      usage: { tokens: 1200 }
    });

    expect(useAppStore.getState().messagesBySession[session]).toEqual([
      expect.objectContaining({
        id: "call_1-r",
        text: "Permission denied reading C:/secret.txt",
        toolUsage: { tokens: 1200 },
        isError: true
      })
    ]);
  });

  it("appends turn.done resultText when streaming deltas missed the final message", () => {
    const session = "sess_result";
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "Confirmed: short status. "
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "Write",
      input: { file_path: "plan.md" }
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "File created",
      isError: false
    });
    useAppStore.getState().applyEvent(session, {
      type: "turn.done",
      turnId: "turn-1",
      sessionId: session,
      resumeCursor: "cursor-1",
      resultText: "I checked both drafts against master. Full plan is in the scratchpad file.",
      usage: [],
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    const texts = useAppStore
      .getState()
      .messagesBySession[session].filter((m) => m.role === "assistant")
      .map((m) => m.text);
    expect(texts.join("\n")).toContain("I checked both drafts against master");
  });

  it("does not duplicate turn.done resultText already shown via deltas", () => {
    const session = "sess_result_dup";
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "Done"
    });
    useAppStore.getState().applyEvent(session, {
      type: "turn.done",
      turnId: "turn-1",
      sessionId: session,
      resumeCursor: "cursor-1",
      resultText: "Done",
      usage: [],
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    const texts = useAppStore
      .getState()
      .messagesBySession[session].filter((m) => m.role === "assistant")
      .map((m) => m.text);
    expect(texts).toEqual(["Done"]);
  });

  it("does not duplicate turn.done resultText spanning interim and final assistant messages", () => {
    const session = "sess_result_span";
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "Checking the wiring in theme.css."
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "Read",
      input: { file_path: "theme.css" }
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "ok",
      isError: false
    });
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "Refining the token map."
    });
    useAppStore.getState().applyEvent(session, {
      type: "turn.done",
      turnId: "turn-1",
      sessionId: session,
      resumeCursor: "cursor-1",
      resultText: "Checking the wiring in theme.css.\nRefining the token map.",
      usage: [],
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    const texts = useAppStore
      .getState()
      .messagesBySession[session].filter((m) => m.role === "assistant")
      .map((m) => m.text);
    expect(texts.join("\n")).toBe("Checking the wiring in theme.css.\nRefining the token map.");
  });

  it("clears the retry notice once the turn resumes with tool activity", () => {
    const session = "sess_retry_resume";
    useAppStore.getState().applyEvent(session, {
      type: "turn.retry",
      turnId: "turn-1",
      attempt: 1,
      message: "Rate limit exceeded. Please retry after a brief wait.",
      retryAt: Date.now() + 2000
    });
    expect(useAppStore.getState().messagesBySession[session].some((m) => m.id === "turn-1-retry")).toBe(true);
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "Edit",
      input: {}
    });
    expect(useAppStore.getState().messagesBySession[session].some((m) => m.id === "turn-1-retry")).toBe(false);
  });

  it("clears the retry notice on assistant progress and re-shows the next retry", () => {
    const session = "sess_retry_progress";
    useAppStore.getState().applyEvent(session, {
      type: "turn.retry",
      turnId: "turn-1",
      attempt: 1,
      message: "Rate limit exceeded.",
      retryAt: 0
    });
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "resumed"
    });
    expect(useAppStore.getState().messagesBySession[session].some((m) => m.id === "turn-1-retry")).toBe(false);
    useAppStore.getState().applyEvent(session, {
      type: "turn.retry",
      turnId: "turn-1",
      attempt: 2,
      message: "Rate limit exceeded.",
      retryAt: 0
    });
    expect(useAppStore.getState().messagesBySession[session].some((m) => m.id === "turn-1-retry")).toBe(true);
  });
});

describe("appStore task snapshots", () => {
  let session = "";
  let sessionSeq = 0;

  function snapshot(partial: Partial<TaskSnapshot> = {}): TaskSnapshot {
    return { id: "call_1", kind: "agent", background: true, state: "running", runCount: 1, ...partial };
  }

  function historyCall(task: TaskSnapshot): HistoryMessage {
    return {
      id: "call_1",
      role: "tool",
      text: 'Agent {"description":"Review"}',
      turnId: "turn-1",
      toolName: "Agent",
      task
    };
  }

  function updateTask(task: TaskSnapshot): void {
    useAppStore.getState().applyEvent(session, { type: "task.updated", turnId: "turn-1", sessionId: session, task });
  }

  function callSubagent(task?: TaskSnapshot): void {
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "Agent",
      input: { description: "Review" },
      ...(task ? { task } : {})
    });
  }

  beforeEach(() => {
    sessionSeq += 1;
    session = `sess_tasks_${sessionSeq}`;
    useAppStore.setState({
      messagesBySession: {},
      loadingHistory: {},
      busyTurns: {},
      pendingApprovals: {},
      pendingQuestions: {}
    });
  });

  it("stores the snapshot carried by a tool call and replaces it on a replayed call", () => {
    callSubagent(snapshot());
    expect(useAppStore.getState().messagesBySession[session][0].task).toEqual(snapshot());

    const completed = snapshot({ state: "completed", endedAt: 5000 });
    callSubagent(completed);
    const messages = useAppStore.getState().messagesBySession[session];
    expect(messages).toHaveLength(1);
    expect(messages[0].task).toEqual(completed);
  });

  it("keeps the stored snapshot when a replayed call carries none", () => {
    callSubagent(snapshot());
    callSubagent();
    expect(useAppStore.getState().messagesBySession[session][0].task).toEqual(snapshot());
  });

  it("patches the matching tool message on task.updated", () => {
    callSubagent(snapshot());
    const completed = snapshot({ state: "completed", endedAt: 5000, output: "Approve." });
    useAppStore.getState().applyEvent(session, { type: "task.updated", turnId: "turn-1", sessionId: session, task: completed });
    const messages = useAppStore.getState().messagesBySession[session];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "call_1", toolName: "Agent", task: completed });
  });

  it("ignores task.updated for an unknown tool call without writing state", () => {
    callSubagent(snapshot());
    const before = useAppStore.getState().messagesBySession;
    useAppStore.getState().applyEvent(session, {
      type: "task.updated",
      turnId: "turn-1",
      sessionId: session,
      task: snapshot({ id: "other", state: "failed" })
    });
    expect(useAppStore.getState().messagesBySession).toBe(before);
    expect(useAppStore.getState().messagesBySession[session][0].task?.state).toBe("running");
  });

  it("ignores task.updated for a session without messages", () => {
    const before = useAppStore.getState().messagesBySession;
    useAppStore.getState().applyEvent("sess_empty", { type: "task.updated", turnId: "turn-1", sessionId: "sess_empty", task: snapshot() });
    expect(useAppStore.getState().messagesBySession).toBe(before);
  });

  it("applies a task.updated that arrived before its tool call unless the call carries a newer snapshot", () => {
    const completed = snapshot({ state: "completed", endedAt: 5000 });
    updateTask(completed);
    expect(useAppStore.getState().messagesBySession[session]).toBeUndefined();

    callSubagent();
    expect(useAppStore.getState().messagesBySession[session][0].task).toEqual(completed);

    const later = snapshot({ state: "running", runCount: 2 });
    updateTask(snapshot({ state: "completed", runCount: 1 }));
    useAppStore.setState({ messagesBySession: {} });
    callSubagent(later);
    expect(useAppStore.getState().messagesBySession[session][0].task).toEqual(later);

    const failed = snapshot({ state: "failed" });
    callSubagent(failed);
    expect(useAppStore.getState().messagesBySession[session][0].task).toEqual(failed);
  });

  it("keeps only the latest buffered snapshot per task", () => {
    updateTask(snapshot({ state: "running", runCount: 1 }));
    updateTask(snapshot({ state: "completed", runCount: 1, endedAt: 5000 }));
    callSubagent();
    expect(useAppStore.getState().messagesBySession[session][0].task).toEqual(
      snapshot({ state: "completed", runCount: 1, endedAt: 5000 })
    );
  });

  it("lets a task.updated that arrived while history was loading win over the stale history snapshot", async () => {
    let resolveHistory: (history: HistoryMessage[]) => void = () => {};
    const getHistory = vi.fn(() => new Promise<HistoryMessage[]>((resolve) => (resolveHistory = resolve)));
    (window as unknown as { cw: unknown }).cw = { getHistory };

    const loading = useAppStore.getState().ensureHistory(session);
    const completed = snapshot({ state: "completed", endedAt: 5000 });
    updateTask(completed);
    resolveHistory([historyCall(snapshot())]);
    await loading;

    const messages = useAppStore.getState().messagesBySession[session];
    expect(messages).toHaveLength(1);
    expect(messages[0].task).toEqual(completed);
  });

  it("applies a buffered snapshot to the history returned by retryConnection", async () => {
    const retryConnection = vi.fn(async () => ({ status: "done" as const, history: [historyCall(snapshot())] }));
    (window as unknown as { cw: unknown }).cw = { retryConnection, activeTurns: async () => [] };

    const failed = snapshot({ state: "failed", endedAt: 5000 });
    updateTask(failed);
    await useAppStore.getState().retryConnection(session);

    const messages = useAppStore.getState().messagesBySession[session];
    expect(messages).toHaveLength(1);
    expect(messages[0].task).toEqual(failed);
  });

  it("leaves history snapshots untouched when nothing was buffered for them", async () => {
    const running = snapshot();
    (window as unknown as { cw: unknown }).cw = { getHistory: async () => [historyCall(running)] };
    updateTask(snapshot({ id: "other", state: "failed" }));

    await useAppStore.getState().ensureHistory(session);

    expect(useAppStore.getState().messagesBySession[session][0].task).toEqual(running);
  });

  it("drops buffered snapshots the merged history did not claim", async () => {
    (window as unknown as { cw: unknown }).cw = { getHistory: async () => [historyCall(snapshot())] };
    updateTask(snapshot({ id: "outside_window", state: "failed" }));

    await useAppStore.getState().ensureHistory(session);
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-2",
      toolCallId: "outside_window",
      name: "Agent",
      input: { description: "Later" }
    });

    expect(useAppStore.getState().messagesBySession[session].find((m) => m.id === "outside_window")?.task).toBeUndefined();
  });

  it("keeps at most 200 buffered snapshots per session, dropping the oldest", () => {
    for (let i = 0; i <= 200; i += 1) updateTask(snapshot({ id: `call_${i}`, state: "completed" }));
    const call = (id: string) =>
      useAppStore.getState().applyEvent(session, { type: "tool.call", turnId: "turn-1", toolCallId: id, name: "Agent", input: {} });

    call("call_0");
    call("call_200");

    const messages = useAppStore.getState().messagesBySession[session];
    expect(messages.find((m) => m.id === "call_0")?.task).toBeUndefined();
    expect(messages.find((m) => m.id === "call_200")?.task?.state).toBe("completed");
  });

  it("finalizes unanswered subagent calls on turn.done even with background tasks", () => {
    callSubagent(snapshot());
    useAppStore.getState().applyEvent(session, {
      type: "turn.done",
      turnId: "turn-1",
      sessionId: session,
      resumeCursor: "cursor-1",
      resultText: "",
      usage: [],
      numTurns: 1,
      isError: false,
      backgroundTasks: 1
    });
    const message = useAppStore.getState().messagesBySession[session][0];
    expect(message.toolDone).toBe(true);
    expect(message.task?.state).toBe("running");
  });
});

const pushRecentModel = vi.fn(async () => {});

function installPushRecentModel(): void {
  pushRecentModel.mockClear();
  (window as unknown as { cw: unknown }).cw = { ...(window as unknown as { cw: object }).cw, pushRecentModel };
}

describe("appStore pending model per harness", () => {
  beforeEach(() => {
    installPushRecentModel();
    useAppStore.setState({
      activeProjectId: "proj_1",
      pendingDriver: "opencode",
      lastDriver: "opencode",
      installedHarnesses: null,
      pendingPrefs: { ...DEFAULT_COMPOSER }
    });
  });

  it("remembers the outgoing model and leaves the next harness model for the composer to pick", () => {
    useAppStore.setState({ pendingPrefs: { ...DEFAULT_COMPOSER, model: "alpha/m1" } });
    useAppStore.getState().setPendingDriver("claude");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
    expect(pushRecentModel).toHaveBeenCalledWith("opencode", "alpha/m1");
  });

  it("clears the model when the next harness has no remembered model", () => {
    useAppStore.setState({ pendingPrefs: { ...DEFAULT_COMPOSER, model: "sonnet" } });
    useAppStore.getState().setPendingDriver("codex");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
  });

  it("does not seed a recent model over the harness default when opening a new session", () => {
    useAppStore.setState({
      pendingDriver: "claude",
      lastDriver: "claude",
      pendingPrefs: { ...DEFAULT_COMPOSER, model: "sonnet" },
      defaultModelByDriver: { claude: "", opencode: "beta/m2", codex: "" }
    });
    useAppStore.getState().startNewSession("opencode");
    expect(useAppStore.getState().pendingDriver).toBe("opencode");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
    expect(pushRecentModel).toHaveBeenCalledWith("claude", "sonnet");
  });

  it("opens a new session on an installed harness when the requested one is not installed", () => {
    useAppStore.setState({ installedHarnesses: ["claude"] });
    useAppStore.getState().startNewSession("codex");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
  });

  it("moves the pending harness when availability drops it", () => {
    applyInstalledHarnesses(["claude", "codex"]);
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().lastDriver).toBe("claude");
  });
});

describe("appStore applySession", () => {
  it("replaces the stored session so removed keys disappear", () => {
    const base = {
      id: "sess_apply",
      projectId: "proj_apply",
      driver: "claude" as const,
      title: "Linked",
      status: "idle" as const,
      resumeCursor: "",
      createdAt: 1,
      updatedAt: 1
    };
    const other = { ...base, id: "sess_other" };
    const prs = [{ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 }, origin: "opened" as const, lastSeenSha: "a", lastSeenAt: 1 }];
    useAppStore.setState({ sessionsByProject: { proj_apply: [{ ...base, prs }, other] } });
    useAppStore.getState().applySession({ ...base, updatedAt: 2 });
    const [updated, untouched] = useAppStore.getState().sessionsByProject.proj_apply;
    expect(updated).toEqual({ ...base, updatedAt: 2 });
    expect("prs" in updated).toBe(false);
    expect(untouched).toBe(other);
  });

  it("applies the server's status even while a turn is busy for that session", () => {
    const base = {
      id: "sess_busy",
      projectId: "proj_busy",
      driver: "claude" as const,
      title: "Busy",
      status: "working" as const,
      resumeCursor: "",
      createdAt: 1,
      updatedAt: 1
    };
    useAppStore.setState({ sessionsByProject: { proj_busy: [base] }, busyTurns: { sess_busy: "turn_1" } });
    useAppStore.getState().applySession({ ...base, status: "input-required", title: "Renamed", updatedAt: 2 });
    expect(useAppStore.getState().sessionsByProject.proj_busy[0]).toEqual({ ...base, status: "input-required", title: "Renamed", updatedAt: 2 });
  });
});

describe("appStore sendPromptTo", () => {
  it("rejects a second send while the first is still starting, without superseding it", async () => {
    let resolveStart: (turnId: string) => void = () => {};
    const startTurn = vi.fn(() => new Promise<string>((resolve) => (resolveStart = resolve)));
    const interrupt = vi.fn(async () => {});
    const activeTurns = async () => [{ sessionId: "sess_race", turnId: "turn_1", startedAt: 1 }];
    (window as unknown as { cw: unknown }).cw = { startTurn, interrupt, activeTurns };
    useAppStore.setState({ busyTurns: {}, messagesBySession: {}, sessionsByProject: {} });

    const first = useAppStore.getState().sendPromptTo("sess_race", "auto follow-up");
    await expect(useAppStore.getState().sendPromptTo("sess_race", "workflow prompt")).rejects.toThrow("session busy (turn pending)");
    resolveStart("turn_1");
    await first;

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();
    expect(useAppStore.getState().busyTurns.sess_race).toBe("turn_1");
  });
});

describe("appStore history behind live turns", () => {
  beforeEach(() => {
    useAppStore.setState({ messagesBySession: {}, loadingHistory: {}, historyLoadedBySession: {}, busyTurns: {} });
  });

  it("merges history ahead of live turns received before the session was opened, once", async () => {
    const history: HistoryMessage[] = [
      { id: "h1", role: "user", text: "earlier", turnId: "h1", timestamp: 100 },
      { id: "h2", role: "user", text: "live prompt as transcribed", turnId: "h2", timestamp: 250 }
    ];
    const getHistory = vi.fn(async () => history);
    (window as unknown as { cw: unknown }).cw = { getHistory };
    useAppStore.getState().applyEvent("sess_remote", { type: "turn.started", turnId: "turn_live", sessionId: "sess_remote", prompt: "live prompt", startedAt: 200 });

    await useAppStore.getState().ensureHistory("sess_remote");
    await useAppStore.getState().ensureHistory("sess_remote");

    expect(useAppStore.getState().messagesBySession.sess_remote.map((m) => m.id)).toEqual(["h1", "turn_live-u"]);
    expect(getHistory).toHaveBeenCalledTimes(1);
  });
});

describe("appStore context.compacted", () => {
  beforeEach(() => {
    useAppStore.setState({ messagesBySession: {}, turnUsageBySession: {} });
  });

  it("adds a compaction marker and updates the context ring", () => {
    const session = "sess_compact";
    useAppStore.getState().applyEvent(session, {
      type: "context.compacted",
      turnId: "turn-1",
      compaction: { trigger: "manual", preTokens: 633409, postTokens: 16048, droppedTokens: 617361 },
      context: { usedTokens: 16048, windowTokens: 200000 }
    });
    expect(useAppStore.getState().messagesBySession[session]).toEqual([
      {
        id: "turn-1-compaction",
        role: "system",
        text: "Context compacted",
        turnId: "turn-1",
        compaction: { trigger: "manual", preTokens: 633409, postTokens: 16048, droppedTokens: 617361 }
      }
    ]);
    expect(useAppStore.getState().turnUsageBySession[session]?.context).toEqual({
      usedTokens: 16048,
      windowTokens: 200000
    });
  });

  it("dedupes repeated markers and preserves the previous last-turn totals", () => {
    const session = "sess_compact_dedupe";
    useAppStore.setState({
      turnUsageBySession: {
        [session]: {
          lastTurn: {
            inputTokens: 1,
            cacheReadTokens: 2,
            cacheWriteTokens: 3,
            outputTokens: 4,
            reasoningTokens: 5,
            costUsd: 0.1
          }
        }
      }
    });
    for (let i = 0; i < 2; i += 1) {
      useAppStore.getState().applyEvent(session, {
        type: "context.compacted",
        turnId: "turn-1",
        compaction: { trigger: "auto" },
        context: { usedTokens: 100, windowTokens: 200000 }
      });
    }
    expect(useAppStore.getState().messagesBySession[session]).toHaveLength(1);
    expect(useAppStore.getState().turnUsageBySession[session]?.lastTurn.costUsd).toBe(0.1);
    expect(useAppStore.getState().turnUsageBySession[session]?.context).toEqual({
      usedTokens: 100,
      windowTokens: 200000
    });
  });
});

describe("appStore preview per session", () => {
  beforeEach(() => {
    useAppStore.setState({ previewBySession: {} });
  });

  it("keeps preview targets independent and closes only the requested session", () => {
    useAppStore.getState().openPreview("sess_a", "src/a.ts", "C:\\a");
    useAppStore.getState().openPreview("sess_b", "src/b.ts", "C:\\b");
    const previews = useAppStore.getState().previewBySession;
    expect(previews.sess_a.path).toBe("src/a.ts");
    expect(previews.sess_b.path).toBe("src/b.ts");

    useAppStore.getState().closePreview("sess_a");
    const remaining = useAppStore.getState().previewBySession;
    expect(remaining.sess_a).toBeUndefined();
    expect(remaining.sess_b.path).toBe("src/b.ts");
  });
});

describe("appStore updates slice", () => {
  function updateState(seq: number, phase: UpdateState["phase"] = "idle"): UpdateState {
    return {
      seq,
      phase,
      runningVersion: "1.0.0",
      channel: "stable",
      availableVersion: null,
      downloadedVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      progress: null,
      checkedAt: null,
      error: null,
      disabledReason: null,
      autoDownload: false
    };
  }

  function installUpdatesBridge(snapshot: Promise<UpdateState>, result?: UpdateActionResult) {
    const calls: string[] = [];
    let emit: (state: UpdateState) => void = () => {};
    const updates = {
      onChanged: (cb: (state: UpdateState) => void) => {
        calls.push("onChanged");
        emit = cb;
        return () => calls.push("off");
      },
      getState: () => {
        calls.push("getState");
        return snapshot;
      },
      check: async () => result,
      download: async () => result,
      setChannel: async () => result
    };
    (window as unknown as { cw: { updates: typeof updates } }).cw = { updates };
    return { calls, emit: (state: UpdateState) => emit(state) };
  }

  beforeEach(() => {
    useAppStore.setState({ updates: null });
  });

  it("subscribes before fetching the snapshot and keeps the newest state", async () => {
    let resolveSnapshot: (state: UpdateState) => void = () => {};
    const bridge = installUpdatesBridge(new Promise((resolve) => (resolveSnapshot = resolve)));
    const off = useAppStore.getState().subscribeUpdates();
    expect(bridge.calls).toEqual(["onChanged", "getState"]);
    bridge.emit(updateState(3, "checking"));
    resolveSnapshot(updateState(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().updates).toMatchObject({ seq: 3, phase: "checking" });
    bridge.emit(updateState(1, "up-to-date"));
    expect(useAppStore.getState().updates?.seq).toBe(3);
    bridge.emit(updateState(4, "available"));
    expect(useAppStore.getState().updates).toMatchObject({ seq: 4, phase: "available" });
    off();
    expect(bridge.calls).toContain("off");
  });

  it("applies the state carried by action results through the same ordering rule", async () => {
    installUpdatesBridge(Promise.resolve(updateState(0)), {
      ok: false,
      code: "busy",
      message: "An update is downloading",
      state: updateState(7, "downloading")
    });
    useAppStore.getState().applyUpdateState(updateState(9, "ready"));
    const result = await useAppStore.getState().checkForUpdates();
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(useAppStore.getState().updates).toMatchObject({ seq: 9, phase: "ready" });
  });
});

describe("appStore project defaults", () => {
  const plain = { id: "proj_1", rootPath: "C:/code/plain", name: "plain" };
  const tuned = {
    id: "proj_2",
    rootPath: "C:/code/tuned",
    name: "tuned",
    settings: { defaultDriver: "claude" as const, defaultModel: "claude-opus-5-5[1m]", defaultEffort: "high" as const, defaultPermissionMode: "acceptEdits" as const }
  };

  beforeEach(() => {
    installPushRecentModel();
    useAppStore.setState({
      projects: [plain, tuned],
      sessionsByProject: { proj_1: [], proj_2: [] },
      activeProjectId: "proj_2",
      activeSessionId: null,
      pendingDriver: null,
      lastDriver: "opencode",
      installedHarnesses: null,
      pendingPrefs: { ...DEFAULT_COMPOSER, model: "alpha/m1" }
    });
  });

  it("starts a new session with the project's harness, model, effort and permission mode", () => {
    useAppStore.getState().startNewSession();
    const state = useAppStore.getState();
    expect(state.pendingDriver).toBe("claude");
    expect(state.pendingPrefs).toEqual({ model: "claude-opus-5-5[1m]", effort: "high", permissionMode: "acceptEdits" });
  });

  it("lets an explicit harness win and leaves its model to the composer", () => {
    useAppStore.getState().startNewSession("codex");
    const state = useAppStore.getState();
    expect(state.pendingDriver).toBe("codex");
    expect(state.pendingPrefs).toEqual({ model: undefined, effort: "high", permissionMode: "acceptEdits" });
  });

  it("applies the defaults when the new-session composer switches to the project, and keeps choices for projects without them", async () => {
    useAppStore.setState({ activeProjectId: "proj_1", pendingDriver: "opencode" });
    await useAppStore.getState().setPendingProject("proj_2");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().pendingPrefs.model).toBe("claude-opus-5-5[1m]");
    useAppStore.getState().setPendingPrefs({ effort: "low" });
    await useAppStore.getState().setPendingProject("proj_1");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().pendingPrefs).toEqual({ model: "claude-opus-5-5[1m]", effort: "low", permissionMode: "acceptEdits" });
  });

  it("falls back to an installed harness when the project's default is missing", () => {
    useAppStore.setState({ installedHarnesses: ["codex"] });
    useAppStore.getState().startNewSession();
    expect(useAppStore.getState().pendingDriver).toBe("codex");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
  });
});

describe("appStore session notices", () => {
  beforeEach(() => {
    useAppStore.setState({ messagesBySession: {} });
  });

  it("replaces a notice by id and keeps it out of the loaded-history check", () => {
    const notice = { type: "session.notice" as const, turnId: "setup:1", sessionId: "sess_n", noticeId: "setup:1" };
    useAppStore.getState().applyEvent("sess_n", { ...notice, text: "Setup script running…", severity: "info" });
    useAppStore.getState().applyEvent("sess_n", { ...notice, text: "Setup script failed with exit code 1.", severity: "error" });
    const messages = useAppStore.getState().messagesBySession["sess_n"];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ id: "notice-setup:1", role: "system", text: "Setup script failed with exit code 1.", turnId: "worktree-cleanup", isError: true });
  });
});
