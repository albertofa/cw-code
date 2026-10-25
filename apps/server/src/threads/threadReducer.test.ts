import { describe, expect, it } from "bun:test";
import type { ApprovalRequest, HistoryMessage, QuestionRequest, TaskSnapshot, ThreadEvent } from "@cw-code/contracts";
import {
  abortTurn,
  appendNotice,
  beginTurn,
  commitTurn,
  createThreadState,
  mergeHistory,
  reduceThreadEvent,
  replaceHistory,
  toTopicData,
  type ThreadState
} from "./threadReducer.js";
import { orderedItems } from "./threadItems.js";

const NOW = 10_000;

function apply(state: ThreadState, event: ThreadEvent, now = NOW) {
  return reduceThreadEvent(state, event, now);
}

function items(state: ThreadState) {
  return orderedItems(state);
}

function turnDone(partial: Partial<Extract<ThreadEvent, { type: "turn.done" }>> = {}): ThreadEvent {
  return {
    type: "turn.done",
    turnId: "turn-1",
    sessionId: "s",
    resumeCursor: "cursor-1",
    resultText: "",
    usage: [],
    numTurns: 1,
    isError: false,
    backgroundTasks: 0,
    ...partial
  };
}

function toolCall(partial: Partial<Extract<ThreadEvent, { type: "tool.call" }>> = {}): ThreadEvent {
  return { type: "tool.call", turnId: "turn-1", toolCallId: "call_1", name: "Agent", input: { description: "Review" }, ...partial };
}

function started(turnId = "turn-1", startedAt = 1000, prompt = "hello"): ThreadEvent {
  return { type: "turn.started", turnId, sessionId: "s", prompt, startedAt };
}

describe("thread reducer tool.result", () => {
  it("stores tool usage and preserves the parent tool call id", () => {
    const state = createThreadState();
    apply(state, toolCall({ toolCallId: "call_1", name: "task", input: { prompt: "review" }, parentToolCallId: "parent_1" }));
    apply(state, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "done",
      isError: false,
      usage: { tokens: 1200, toolUses: 3, durationMs: 900 }
    });
    const [message] = items(state);
    expect(message.toolUsage).toEqual({ tokens: 1200, toolUses: 3, durationMs: 900 });
    expect(message.parentToolCallId).toBe("parent_1");
    expect(message.toolDone).toBe(true);
    expect(message.toolOutput).toBe("done");
    expect(message.toolCompletedAt).toBe(NOW);
  });

  it("stores the subagent model reported with the tool result", () => {
    const state = createThreadState();
    apply(state, toolCall({ name: "task" }));
    apply(state, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "done",
      isError: false,
      agentId: "agent-1",
      model: "claude-sonnet-4-5"
    });
    const [message] = items(state);
    expect(message.subagentModel).toBe("claude-sonnet-4-5");
    expect(message.subagentAgentId).toBe("agent-1");
  });

  it("truncates the stored output to 8000 and an orphan result text to 1000", () => {
    const state = createThreadState();
    apply(state, toolCall({ toolCallId: "call_1" }));
    apply(state, { type: "tool.result", turnId: "turn-1", toolCallId: "call_1", output: "x".repeat(9000), isError: false });
    apply(state, { type: "tool.result", turnId: "turn-1", toolCallId: "orphan", output: "y".repeat(2000), isError: false });
    expect(state.items.get("call_1")?.toolOutput).toHaveLength(8000);
    expect(state.items.get("orphan-r")?.text).toHaveLength(1000);
  });

  it("updates a result-only row when a later task notification has details", () => {
    const state = createThreadState();
    apply(state, { type: "tool.result", turnId: "turn-1", toolCallId: "call_1", output: "Subagent failed", isError: true });
    apply(state, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "Permission denied reading C:/secret.txt",
      isError: true,
      usage: { tokens: 1200 }
    });
    expect(items(state)).toEqual([
      expect.objectContaining({
        id: "call_1-r",
        text: "Permission denied reading C:/secret.txt",
        toolUsage: { tokens: 1200 },
        isError: true
      })
    ]);
  });

  it("appends turn.done resultText when streaming deltas missed the final message", () => {
    const state = createThreadState();
    apply(state, { type: "assistant.delta", turnId: "turn-1", text: "Confirmed: short status. " });
    apply(state, toolCall({ name: "Write", input: { file_path: "plan.md" } }));
    apply(state, { type: "tool.result", turnId: "turn-1", toolCallId: "call_1", output: "File created", isError: false });
    apply(state, turnDone({ resultText: "I checked both drafts against master. Full plan is in the scratchpad file." }));
    const texts = items(state)
      .filter((m) => m.role === "assistant")
      .map((m) => m.text);
    expect(texts.join("\n")).toContain("I checked both drafts against master");
  });

  it("does not duplicate turn.done resultText already shown via deltas", () => {
    const state = createThreadState();
    apply(state, { type: "assistant.delta", turnId: "turn-1", text: "Done" });
    apply(state, turnDone({ resultText: "Done" }));
    expect(items(state).filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(["Done"]);
  });

  it("appends only the unseen suffix when resultText extends the streamed text", () => {
    const state = createThreadState();
    apply(state, { type: "assistant.delta", turnId: "turn-1", text: "Part one." });
    const change = apply(state, turnDone({ resultText: "Part one. Part two." }));
    expect(items(state).filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(["Part one. Part two."]);
    expect(change.appended).toEqual([{ id: "turn-1-a", text: " Part two." }]);
  });

  it("does not duplicate turn.done resultText spanning interim and final assistant messages", () => {
    const state = createThreadState();
    apply(state, { type: "assistant.delta", turnId: "turn-1", text: "Checking the wiring in theme.css." });
    apply(state, toolCall({ name: "Read", input: { file_path: "theme.css" } }));
    apply(state, { type: "tool.result", turnId: "turn-1", toolCallId: "call_1", output: "ok", isError: false });
    apply(state, { type: "assistant.delta", turnId: "turn-1", text: "Refining the token map." });
    apply(state, turnDone({ resultText: "Checking the wiring in theme.css.\nRefining the token map." }));
    const texts = items(state)
      .filter((m) => m.role === "assistant")
      .map((m) => m.text);
    expect(texts.join("\n")).toBe("Checking the wiring in theme.css.\nRefining the token map.");
  });

  it("clears the retry notice once the turn resumes with tool activity", () => {
    const state = createThreadState();
    apply(state, {
      type: "turn.retry",
      turnId: "turn-1",
      attempt: 1,
      message: "Rate limit exceeded. Please retry after a brief wait.",
      retryAt: NOW + 2000
    });
    expect(state.items.has("turn-1-retry")).toBe(true);
    expect(state.items.get("turn-1-retry")).toMatchObject({
      severity: "warning",
      text: "Retrying in 2s (attempt 1): Rate limit exceeded. Please retry after a brief wait."
    });
    const change = apply(state, toolCall({ name: "Edit", input: {} }));
    expect(state.items.has("turn-1-retry")).toBe(false);
    expect(change.removed).toEqual(["turn-1-retry"]);
  });

  it("clears the retry notice on assistant progress and re-shows the next retry", () => {
    const state = createThreadState();
    const retry = (attempt: number): ThreadEvent => ({
      type: "turn.retry",
      turnId: "turn-1",
      attempt,
      message: "Rate limit exceeded.",
      retryAt: 0
    });
    apply(state, retry(1));
    apply(state, { type: "assistant.delta", turnId: "turn-1", text: "resumed" });
    expect(state.items.has("turn-1-retry")).toBe(false);
    apply(state, retry(2));
    expect(state.items.has("turn-1-retry")).toBe(true);
  });

  it("removes the retry notice on turn.done and replaces it on a repeated retry", () => {
    const state = createThreadState();
    const retry: ThreadEvent = { type: "turn.retry", turnId: "turn-1", attempt: 1, message: "first", retryAt: 0 };
    apply(state, retry);
    apply(state, { ...retry, message: "second" } as ThreadEvent);
    expect(items(state)).toHaveLength(1);
    expect(state.items.get("turn-1-retry")?.text).toBe("Retrying (attempt 1): second");
    apply(state, turnDone());
    expect(state.items.has("turn-1-retry")).toBe(false);
  });
});

describe("thread reducer reasoning", () => {
  it("keeps reasoning open across approvals and closes it on the next assistant text", () => {
    const state = createThreadState();
    apply(state, { type: "reasoning.delta", turnId: "turn-1", text: "thinking" }, 1000);
    const request: ApprovalRequest = { requestId: "r1", kind: "command", title: "Run", decisions: ["accept"] };
    apply(state, { type: "approval.request", turnId: "turn-1", request }, 2000);
    expect(state.items.get("turn-1-th")?.reasoningMs).toBeUndefined();
    const change = apply(state, { type: "assistant.delta", turnId: "turn-1", text: "answer" }, 4000);
    expect(state.items.get("turn-1-th")?.reasoningMs).toBe(3000);
    expect(change.upserted).toEqual(["turn-1-th", "turn-1-a"]);
  });

  it("reports reasoning deltas as appends to the open block", () => {
    const state = createThreadState();
    const first = apply(state, { type: "reasoning.delta", turnId: "turn-1", text: "a" });
    const second = apply(state, { type: "reasoning.delta", turnId: "turn-1", text: "b" });
    expect(first.upserted).toEqual(["turn-1-th"]);
    expect(second).toMatchObject({ upserted: [], appended: [{ id: "turn-1-th", text: "b" }] });
  });
});

describe("thread reducer task snapshots", () => {
  function snapshot(partial: Partial<TaskSnapshot> = {}): TaskSnapshot {
    return { id: "call_1", kind: "agent", background: true, state: "running", runCount: 1, ...partial };
  }

  function historyCall(task: TaskSnapshot): HistoryMessage {
    return { id: "call_1", role: "tool", text: 'Agent {"description":"Review"}', turnId: "turn-1", toolName: "Agent", task };
  }

  function updateTask(state: ThreadState, task: TaskSnapshot) {
    return apply(state, { type: "task.updated", turnId: "turn-1", sessionId: "s", task });
  }

  it("stores the snapshot carried by a tool call and replaces it on a replayed call", () => {
    const state = createThreadState();
    apply(state, toolCall({ task: snapshot() }));
    expect(items(state)[0].task).toEqual(snapshot());
    const completed = snapshot({ state: "completed", endedAt: 5000 });
    apply(state, toolCall({ task: completed }));
    expect(items(state)).toHaveLength(1);
    expect(items(state)[0].task).toEqual(completed);
  });

  it("keeps the stored snapshot when a replayed call carries none", () => {
    const state = createThreadState();
    apply(state, toolCall({ task: snapshot() }));
    apply(state, toolCall());
    expect(items(state)[0].task).toEqual(snapshot());
  });

  it("patches the matching tool message on task.updated", () => {
    const state = createThreadState();
    apply(state, toolCall({ task: snapshot() }));
    const completed = snapshot({ state: "completed", endedAt: 5000, output: "Approve." });
    const change = updateTask(state, completed);
    expect(items(state)).toHaveLength(1);
    expect(items(state)[0]).toMatchObject({ id: "call_1", toolName: "Agent", task: completed });
    expect(change.upserted).toEqual(["call_1"]);
  });

  it("ignores task.updated for an unknown tool call without reporting a change", () => {
    const state = createThreadState();
    apply(state, toolCall({ task: snapshot() }));
    const change = updateTask(state, snapshot({ id: "other", state: "failed" }));
    expect(change).toEqual({ upserted: [], removed: [], appended: [], fields: [], reloaded: false });
    expect(items(state)[0].task?.state).toBe("running");
  });

  it("ignores task.updated for a thread without items", () => {
    const state = createThreadState();
    updateTask(state, snapshot());
    expect(items(state)).toEqual([]);
  });

  it("applies a task.updated that arrived before its tool call unless the call carries a newer snapshot", () => {
    const state = createThreadState();
    const completed = snapshot({ state: "completed", endedAt: 5000 });
    updateTask(state, completed);
    expect(items(state)).toEqual([]);

    apply(state, toolCall());
    expect(items(state)[0].task).toEqual(completed);

    const later = snapshot({ state: "running", runCount: 2 });
    const other = createThreadState();
    updateTask(other, snapshot({ state: "completed", runCount: 1 }));
    apply(other, toolCall({ task: later }));
    expect(items(other)[0].task).toEqual(later);

    const failed = snapshot({ state: "failed" });
    apply(other, toolCall({ task: failed }));
    expect(items(other)[0].task).toEqual(failed);
  });

  it("keeps only the latest buffered snapshot per task", () => {
    const state = createThreadState();
    updateTask(state, snapshot({ state: "running", runCount: 1 }));
    updateTask(state, snapshot({ state: "completed", runCount: 1, endedAt: 5000 }));
    apply(state, toolCall());
    expect(items(state)[0].task).toEqual(snapshot({ state: "completed", runCount: 1, endedAt: 5000 }));
  });

  it("lets a task.updated that arrived while history was loading win over the stale history snapshot", () => {
    const state = createThreadState();
    const completed = snapshot({ state: "completed", endedAt: 5000 });
    updateTask(state, completed);
    mergeHistory(state, [historyCall(snapshot())], []);
    expect(items(state)).toHaveLength(1);
    expect(items(state)[0].task).toEqual(completed);
  });

  it("applies a buffered snapshot to the history that replaces the thread", () => {
    const state = createThreadState();
    const failed = snapshot({ state: "failed", endedAt: 5000 });
    updateTask(state, failed);
    replaceHistory(state, [historyCall(snapshot())], []);
    expect(items(state)).toHaveLength(1);
    expect(items(state)[0].task).toEqual(failed);
  });

  it("leaves history snapshots untouched when nothing was buffered for them", () => {
    const state = createThreadState();
    const running = snapshot();
    updateTask(state, snapshot({ id: "other", state: "failed" }));
    mergeHistory(state, [historyCall(running)], []);
    expect(items(state)[0].task).toEqual(running);
  });

  it("drops buffered snapshots the merged history did not claim", () => {
    const state = createThreadState();
    updateTask(state, snapshot({ id: "outside_window", state: "failed" }));
    mergeHistory(state, [historyCall(snapshot())], []);
    apply(state, toolCall({ turnId: "turn-2", toolCallId: "outside_window", input: { description: "Later" } }));
    expect(state.items.get("outside_window")?.task).toBeUndefined();
  });

  it("keeps at most 200 buffered snapshots per thread, dropping the oldest", () => {
    const state = createThreadState();
    for (let i = 0; i <= 200; i += 1) updateTask(state, snapshot({ id: `call_${i}`, state: "completed" }));
    apply(state, toolCall({ toolCallId: "call_0", input: {} }));
    apply(state, toolCall({ toolCallId: "call_200", input: {} }));
    expect(state.items.get("call_0")?.task).toBeUndefined();
    expect(state.items.get("call_200")?.task?.state).toBe("completed");
  });

  it("finalizes unanswered subagent calls on turn.done even with background tasks", () => {
    const state = createThreadState();
    apply(state, toolCall({ task: snapshot() }));
    apply(state, turnDone({ backgroundTasks: 1 }));
    const [message] = items(state);
    expect(message.toolDone).toBe(true);
    expect(message.task?.state).toBe("running");
  });

  it("overlays live tasks onto history and lets buffered snapshots win over them", () => {
    const state = createThreadState();
    updateTask(state, snapshot({ state: "failed" }));
    mergeHistory(state, [historyCall(snapshot({ state: "unknown", runCount: 1 }))], [snapshot({ state: "completed" })]);
    expect(items(state)[0].task?.state).toBe("failed");

    const other = createThreadState();
    mergeHistory(other, [historyCall(snapshot({ state: "unknown", runCount: 1 }))], [snapshot({ state: "completed" })]);
    expect(items(other)[0].task?.state).toBe("completed");
  });
});

describe("thread reducer context.compacted", () => {
  const compacted = (context?: { usedTokens: number; windowTokens: number }): ThreadEvent => ({
    type: "context.compacted",
    turnId: "turn-1",
    compaction: { trigger: "manual", preTokens: 633409, postTokens: 16048, droppedTokens: 617361 },
    ...(context ? { context } : {})
  });

  it("adds a compaction marker and updates the context ring", () => {
    const state = createThreadState();
    const change = apply(state, compacted({ usedTokens: 16048, windowTokens: 200000 }));
    expect(items(state).map(({ seq: _seq, ...rest }) => rest)).toEqual([
      {
        id: "turn-1-compaction",
        role: "system",
        text: "Context compacted",
        turnId: "turn-1",
        compaction: { trigger: "manual", preTokens: 633409, postTokens: 16048, droppedTokens: 617361 }
      }
    ]);
    expect(state.usage.context).toEqual({ usedTokens: 16048, windowTokens: 200000 });
    expect(state.usage.meter).toEqual({ percent: 16048 / 200000, severity: null });
    expect(change.fields).toEqual(["usage"]);
  });

  it("dedupes repeated markers and preserves the previous last-turn totals", () => {
    const state = createThreadState();
    state.usage = {
      context: null,
      meter: null,
      lastTurn: {
        inputTokens: 1,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        outputTokens: 4,
        reasoningTokens: 5,
        costUsd: 0.1,
        durationMs: null,
        tokens: 10
      }
    };
    for (let i = 0; i < 2; i += 1) {
      apply(state, {
        type: "context.compacted",
        turnId: "turn-1",
        compaction: { trigger: "auto" },
        context: { usedTokens: 100, windowTokens: 200000 }
      });
    }
    expect(items(state)).toHaveLength(1);
    expect(state.usage.lastTurn?.costUsd).toBe(0.1);
    expect(state.usage.context).toEqual({ usedTokens: 100, windowTokens: 200000 });
  });

  it("seeds zeroed last-turn totals when none existed and leaves usage alone without context", () => {
    const state = createThreadState();
    apply(state, compacted());
    expect(state.usage).toEqual({ context: null, meter: null, lastTurn: null });
    apply(state, compacted({ usedTokens: 170000, windowTokens: 200000 }));
    expect(state.usage.lastTurn).toMatchObject({ tokens: 0, costUsd: null, durationMs: null });
    expect(state.usage.meter?.severity).toBe("warn");
  });
});

describe("thread reducer session notices", () => {
  it("replaces a notice by id and keeps it out of the loaded-history check", () => {
    const state = createThreadState();
    const notice = { type: "session.notice" as const, turnId: "setup:1", sessionId: "sess_n", noticeId: "setup:1" };
    apply(state, { ...notice, text: "Setup script running…", severity: "info" });
    apply(state, { ...notice, text: "Setup script failed with exit code 1.", severity: "error" });
    expect(items(state)).toHaveLength(1);
    expect(items(state)[0]).toEqual({
      id: "notice-setup:1",
      seq: 1,
      role: "system",
      text: "Setup script failed with exit code 1.",
      turnId: "worktree-cleanup",
      isError: true
    });
  });

  it("marks warnings and shares the path with appendNotice", () => {
    const state = createThreadState();
    const change = appendNotice(state, { noticeId: "n1", text: "careful", severity: "warning" });
    expect(change.upserted).toEqual(["notice-n1"]);
    expect(state.items.get("notice-n1")).toMatchObject({ severity: "warning" });
    expect(state.items.get("notice-n1")?.isError).toBeUndefined();
  });
});

describe("thread reducer turns, approvals and questions", () => {
  it("tracks the turn from turn.started to turn.done with its duration and usage", () => {
    const state = createThreadState();
    apply(state, started("turn-1", 1000, "do it"));
    expect(state.turn).toEqual({ phase: "running", turnId: "turn-1", startedAt: 1000, auto: false });
    expect(state.items.get("turn-1-u")).toMatchObject({ role: "user", text: "do it", timestamp: 1000 });

    const change = apply(
      state,
      turnDone({
        usage: [
          { model: "m", inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40, reasoningTokens: 5, costUsd: 0.5 }
        ],
        context: { usedTokens: 90, windowTokens: 100 }
      }),
      4500
    );
    expect(state.turn).toBeNull();
    expect(state.durations).toEqual({ "turn-1": 3500 });
    expect(state.usage.context).toEqual({ usedTokens: 90, windowTokens: 100 });
    expect(state.usage.meter?.severity).toBe("warn");
    expect(state.usage.lastTurn).toMatchObject({ costUsd: 0.5, durationMs: 3500, tokens: 100, reasoningTokens: 5 });
    expect(change.fields).toEqual(expect.arrayContaining(["turn", "durations", "usage"]));
  });

  it("keeps the turn open for a done event with background tasks and ignores a superseded done's usage", () => {
    const state = createThreadState();
    apply(state, started("turn-2", 1000));
    apply(state, turnDone({ turnId: "turn-2", backgroundTasks: 2 }));
    expect(state.turn?.turnId).toBe("turn-2");
    const before = state.usage;
    apply(state, turnDone({ turnId: "turn-old" }));
    expect(state.turn?.turnId).toBe("turn-2");
    expect(state.usage).toBe(before);
  });

  it("closes the turn on interruption and clears pending requests, ignoring other turns", () => {
    const state = createThreadState();
    apply(state, started("turn-1", 1000, ""));
    apply(state, { type: "approval.request", turnId: "turn-1", request: { requestId: "a", kind: "command", title: "t", decisions: [] } });
    apply(state, { type: "turn.interrupted", turnId: "other", sessionId: "s" }, 2000);
    expect(state.turn).not.toBeNull();
    apply(state, { type: "turn.interrupted", turnId: "turn-1", sessionId: "s" }, 2000);
    expect(state.turn).toBeNull();
    expect(state.durations).toEqual({ "turn-1": 1000 });
    expect(state.approvals).toEqual([]);
    expect(state.items.size).toBe(0);
  });

  it("adds the error item and finalizes tools on turn.error", () => {
    const state = createThreadState();
    apply(state, started("turn-1", 1000, ""));
    apply(state, toolCall({ name: "Bash", input: { command: "ls" } }));
    apply(state, { type: "turn.error", turnId: "turn-1", message: "boom", retryable: true }, 3000);
    expect(state.turn).toBeNull();
    expect(state.items.get("call_1")).toMatchObject({ toolDone: true, toolCompletedAt: 3000 });
    expect(state.items.get("turn-1-e")).toMatchObject({ role: "system", text: "Error: boom", isError: true, retryable: true });
  });

  it("adds the error item on an erroring turn.done once", () => {
    const state = createThreadState();
    apply(state, turnDone({ isError: true, resultText: "" }));
    apply(state, turnDone({ isError: true, resultText: "" }));
    expect(items(state).filter((m) => m.id === "turn-1-e")).toHaveLength(1);
    expect(state.items.get("turn-1-e")?.text).toBe("Error: Claude reported an error with no output.");
  });

  it("dedupes approvals and questions and records answers as a tool note", () => {
    const state = createThreadState();
    const approval: ApprovalRequest = { requestId: "a1", kind: "command", title: "Run", decisions: ["accept"] };
    apply(state, { type: "approval.request", turnId: "turn-1", request: approval });
    apply(state, { type: "approval.request", turnId: "turn-1", request: approval });
    expect(state.approvals).toEqual([approval]);
    apply(state, { type: "approval.resolved", turnId: "turn-1", requestId: "a1" });
    expect(state.approvals).toEqual([]);

    const question: QuestionRequest = { requestId: "q1", turnId: "turn-1", questions: [] };
    apply(state, { type: "question.request", turnId: "turn-1", request: question });
    apply(state, { type: "question.request", turnId: "turn-1", request: question });
    expect(state.questions).toEqual([question]);
    const change = apply(state, {
      type: "question.resolved",
      turnId: "turn-1",
      requestId: "q1",
      answers: { Pick: "A", Other: "B" }
    });
    expect(state.questions).toEqual([]);
    expect(state.items.get("q1-ans")).toMatchObject({ role: "tool", text: "Pick → A\nOther → B", turnId: "turn-1", toolCompletedAt: NOW });
    expect(change.upserted).toEqual(["q1-ans"]);
    apply(state, { type: "question.resolved", turnId: "turn-1", requestId: "q2", answers: null });
    expect(state.items.has("q2-ans")).toBe(false);
  });

  it("replaces todos on todo.updated", () => {
    const state = createThreadState();
    const todos = [{ content: "a", status: "pending" as const }];
    const change = apply(state, { type: "todo.updated", turnId: "turn-1", todos });
    expect(state.todos).toEqual(todos);
    expect(change.fields).toEqual(["todos"]);
  });
});

describe("thread reducer begin, commit and abort", () => {
  it("creates a pending echo and starts the turn in the starting phase", () => {
    const state = createThreadState();
    const { pendingId, change } = beginTurn(state, { prompt: "hi", now: 500, auto: true });
    expect(state.turn).toEqual({ phase: "starting", turnId: null, startedAt: 500, auto: true });
    expect(state.items.get(pendingId)).toMatchObject({ role: "user", text: "hi", pending: true, timestamp: 500 });
    expect(change.upserted).toEqual([pendingId]);
    expect(change.fields).toEqual(expect.arrayContaining(["turn", "todos"]));
    expect(() => beginTurn(state, { prompt: "again", now: 600, auto: false })).toThrow("session busy");
  });

  it("re-keys the echo on commit keeping its seq and clearing pending", () => {
    const state = createThreadState();
    apply(state, { type: "assistant.delta", turnId: "old", text: "earlier" });
    const { pendingId } = beginTurn(state, { prompt: "hi", now: 500, auto: false });
    const echoSeq = state.items.get(pendingId)?.seq;
    apply(state, toolCall({ turnId: "turn-1", toolCallId: "early_call" }));

    const change = commitTurn(state, pendingId, "turn-1");

    expect(state.items.has(pendingId)).toBe(false);
    const echo = state.items.get("turn-1-u");
    expect(echo).toMatchObject({ role: "user", text: "hi", turnId: "turn-1", timestamp: 500, seq: echoSeq });
    expect(echo?.pending).toBeUndefined();
    expect(items(state).map((m) => m.id)).toEqual(["old-a", "turn-1-u", "early_call"]);
    expect(state.turn).toEqual({ phase: "running", turnId: "turn-1", startedAt: 500, auto: false });
    expect(change).toMatchObject({ removed: [pendingId], upserted: ["turn-1-u"], fields: ["turn"] });
  });

  it("drops the echo on commit when the turn.started path already created the user item", () => {
    const state = createThreadState();
    const { pendingId } = beginTurn(state, { prompt: "hi", now: 500, auto: false });
    state.items.set("turn-1-u", { id: "turn-1-u", seq: 99, role: "user", text: "hi", turnId: "turn-1" });
    const change = commitTurn(state, pendingId, "turn-1");
    expect(items(state).map((m) => m.id)).toEqual(["turn-1-u"]);
    expect(change.removed).toEqual([pendingId]);
  });

  it("ignores turn.started while the turn is pending", () => {
    const state = createThreadState();
    const { pendingId } = beginTurn(state, { prompt: "hi", now: 500, auto: false });
    const change = apply(state, started("turn-1", 600, "hi"));
    expect(change).toEqual({ upserted: [], removed: [], appended: [], fields: [], reloaded: false });
    expect(state.turn?.turnId).toBeNull();
    commitTurn(state, pendingId, "turn-1");
    expect(items(state).map((m) => m.id)).toEqual(["turn-1-u"]);
  });

  it("removes the echo on abort and restores the previous todos", () => {
    const state = createThreadState();
    const todos = [{ content: "keep", status: "in_progress" as const }];
    apply(state, { type: "todo.updated", turnId: "turn-0", todos });
    const { pendingId, previousTodos } = beginTurn(state, { prompt: "hi", now: 500, auto: false });
    expect(state.todos).toEqual([]);

    const change = abortTurn(state, pendingId, previousTodos);

    expect(state.items.size).toBe(0);
    expect(state.turn).toBeNull();
    expect(state.todos).toEqual(todos);
    expect(change.removed).toEqual([pendingId]);
    expect(change.fields).toEqual(expect.arrayContaining(["turn", "todos"]));
  });

  it("applies a turn.started ignored during the pending phase when the start fails", () => {
    const state = createThreadState();
    const { pendingId, previousTodos } = beginTurn(state, { prompt: "hi", now: 500, auto: false });
    apply(state, started("remote-1", 600, "remote prompt"));
    abortTurn(state, pendingId, previousTodos);
    expect(state.turn).toEqual({ phase: "running", turnId: "remote-1", startedAt: 600, auto: false });
    expect(items(state).map((m) => m.id)).toEqual(["remote-1-u"]);
  });

  it("only removes the echo when the turn was already superseded", () => {
    const state = createThreadState();
    const { pendingId, previousTodos } = beginTurn(state, { prompt: "hi", now: 500, auto: false });
    state.turn = { phase: "running", turnId: "other", startedAt: 700, auto: false };
    abortTurn(state, pendingId, previousTodos);
    expect(state.turn?.turnId).toBe("other");
    expect(state.items.size).toBe(0);
  });

  it("inserts the user item on commit when the history was replaced during the pending window", () => {
    const state = createThreadState();
    const { pendingId } = beginTurn(state, { prompt: "hi", now: 500, auto: false });
    replaceHistory(state, [{ id: "h1", role: "assistant", text: "old", turnId: "h0" }], []);
    expect(state.items.has(pendingId)).toBe(false);

    const change = commitTurn(state, pendingId, "turn-1");

    expect(items(state).map((m) => m.id)).toEqual(["h1", "turn-1-u"]);
    expect(state.items.get("turn-1-u")).toMatchObject({ role: "user", text: "hi", turnId: "turn-1", timestamp: 500 });
    expect(state.items.get("turn-1-u")?.pending).toBeUndefined();
    expect(change.upserted).toEqual(["turn-1-u"]);
    expect(state.turn).toEqual({ phase: "running", turnId: "turn-1", startedAt: 500, auto: false });
  });

  it("restores the running turn when a start sent during it fails", () => {
    const state = createThreadState();
    apply(state, started("turn-0", 100, "first"));
    const running = state.turn;
    const begun = beginTurn(state, { prompt: "second", now: 500, auto: false });
    expect(begun.previousTurn).toEqual(running);

    abortTurn(state, begun.pendingId, begun.previousTodos, begun.previousTurn);

    expect(state.turn).toEqual(running);
    expect(items(state).map((m) => m.id)).toEqual(["turn-0-u"]);
  });

  it("does not restore a running turn that settled while the failed start was pending", () => {
    for (const settle of [
      turnDone({ turnId: "turn-0" }),
      { type: "turn.error", turnId: "turn-0", message: "x" } satisfies ThreadEvent,
      { type: "turn.interrupted", turnId: "turn-0", sessionId: "s" } satisfies ThreadEvent
    ]) {
      const state = createThreadState();
      apply(state, started("turn-0", 100, "first"));
      const begun = beginTurn(state, { prompt: "second", now: 500, auto: false });
      apply(state, settle);

      abortTurn(state, begun.pendingId, begun.previousTodos, begun.previousTurn);

      expect(state.turn).toBeNull();
    }
  });
});

describe("thread reducer item indexes", () => {
  it("keeps appending to the last assistant item after the newest item is removed", () => {
    const state = createThreadState();
    apply(state, { type: "assistant.delta", turnId: "turn-1", text: "one" });
    apply(state, { type: "turn.retry", turnId: "turn-1", attempt: 1, retryAt: 0, message: "overloaded" });
    const change = apply(state, { type: "assistant.delta", turnId: "turn-1", text: " two" });
    expect(change.appended).toEqual([{ id: "turn-1-a", text: " two" }]);
    expect(items(state).map((m) => [m.id, m.text])).toEqual([["turn-1-a", "one two"]]);
  });

  it("closes open reasoning once and appends after a re-keyed echo", () => {
    const state = createThreadState();
    const { pendingId } = beginTurn(state, { prompt: "hi", now: 500, auto: false });
    commitTurn(state, pendingId, "turn-1");
    apply(state, { type: "reasoning.delta", turnId: "turn-1", text: "think" }, 1000);
    const closing = apply(state, { type: "assistant.delta", turnId: "turn-1", text: "a" }, 1500);
    expect(state.items.get("turn-1-th")?.reasoningMs).toBe(500);
    expect(closing.upserted).toEqual(["turn-1-th", "turn-1-a"]);
    const next = apply(state, { type: "assistant.delta", turnId: "turn-1", text: "b" }, 2000);
    expect(next).toEqual({ upserted: [], removed: [], appended: [{ id: "turn-1-a", text: "b" }], fields: [], reloaded: false });
    expect(state.openReasoningIds.size).toBe(0);
    expect(state.lastItemId).toBe("turn-1-a");
  });

  it("rebuilds the indexes when history is reloaded", () => {
    const state = createThreadState();
    apply(state, { type: "reasoning.delta", turnId: "turn-1", text: "think" }, 1000);
    replaceHistory(state, [{ id: "h1", role: "assistant", text: "old", turnId: "h0" }], []);
    expect(state.openReasoningIds.size).toBe(0);
    expect(state.lastItemId).toBe("h1");
  });
});

describe("thread reducer history", () => {
  it("merges history ahead of live turns received before the thread was opened, once", () => {
    const state = createThreadState();
    const history: HistoryMessage[] = [
      { id: "h1", role: "user", text: "earlier", turnId: "h1", timestamp: 100 },
      { id: "h2", role: "user", text: "live prompt as transcribed", turnId: "h2", timestamp: 250 }
    ];
    apply(state, started("turn_live", 200, "live prompt"));

    const first = mergeHistory(state, history, []);
    const second = mergeHistory(state, history, []);

    expect(items(state).map((m) => m.id)).toEqual(["h1", "turn_live-u"]);
    expect(items(state).map((m) => m.seq)).toEqual([1, 2]);
    expect(state.nextSeq).toBe(3);
    expect(first.reloaded).toBe(true);
    expect(second.reloaded).toBe(false);
    expect(state.historyLoaded).toBe(true);
  });

  it("puts history first and live items after it, claiming buffered tasks", () => {
    const state = createThreadState();
    const task: TaskSnapshot = { id: "h-call", kind: "agent", background: true, state: "completed", runCount: 1 };
    apply(state, { type: "task.updated", turnId: "t0", sessionId: "s", task });
    apply(state, { type: "assistant.delta", turnId: "live", text: "streaming" });
    const history: HistoryMessage[] = [
      { id: "h-user", role: "user", text: "q", turnId: "t0", timestamp: 1 },
      { id: "h-call", role: "tool", text: "Agent {}", turnId: "t0", toolName: "Agent", timestamp: 2 },
      { id: "h-call-r", role: "tool", text: "done", turnId: "t0", toolName: "Agent", timestamp: 3 }
    ];

    const change = mergeHistory(state, history, []);

    expect(items(state).map((m) => m.id)).toEqual(["h-user", "h-call", "live-a"]);
    expect(items(state).map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(state.items.get("h-call")).toMatchObject({ task, toolOutput: "done", toolDone: true });
    expect(state.bufferedTasks.size).toBe(0);
    expect(change.reloaded).toBe(true);
  });

  it("keeps local notices after the history and out of the loaded check", () => {
    const state = createThreadState();
    appendNotice(state, { noticeId: "n", text: "setup", severity: "info" });
    mergeHistory(state, [{ id: "h1", role: "user", text: "q", turnId: "h1" }], []);
    expect(items(state).map((m) => m.id)).toEqual(["h1", "notice-n"]);
  });

  it("seeds todos from the last history item unless todos were already touched", () => {
    const todos = [{ content: "from history", status: "pending" as const }];
    const history: HistoryMessage[] = [
      { id: "h1", role: "user", text: "q", turnId: "h1" },
      { id: "h2", role: "tool", text: "TodoWrite", turnId: "h1", todos }
    ];
    const fresh = createThreadState();
    const change = mergeHistory(fresh, history, []);
    expect(fresh.todos).toEqual(todos);
    expect(change.fields).toEqual(["todos"]);

    const touched = createThreadState();
    apply(touched, started("turn-1", 1000, "p"));
    mergeHistory(touched, history, []);
    expect(touched.todos).toEqual([]);
  });

  it("does nothing for empty history but marks the thread loaded", () => {
    const state = createThreadState();
    const change = mergeHistory(state, [], []);
    expect(change.reloaded).toBe(false);
    expect(state.historyLoaded).toBe(true);
  });

  it("replaces every item on replaceHistory and reseqs from 1", () => {
    const state = createThreadState();
    apply(state, { type: "assistant.delta", turnId: "live", text: "x" });
    const change = replaceHistory(
      state,
      [
        { id: "h1", role: "user", text: "q", turnId: "h1" },
        { id: "h2", role: "assistant", text: "a", turnId: "h1" }
      ],
      []
    );
    expect(items(state).map((m) => [m.id, m.seq])).toEqual([["h1", 1], ["h2", 2]]);
    expect(state.nextSeq).toBe(3);
    expect(change.reloaded).toBe(true);
    expect(state.historyLoaded).toBe(true);
  });
});

describe("toTopicData", () => {
  it("keys items by id in seq order next to the runtime fields", () => {
    const state = createThreadState();
    apply(state, { type: "assistant.delta", turnId: "t1", text: "hi" });
    const data = toTopicData(state);
    expect(Object.keys(data).filter((k) => k.startsWith("item/"))).toEqual(["item/t1-a"]);
    expect(data["item/t1-a"]).toMatchObject({ seq: 1, text: "hi" });
    expect(data.turn).toBeNull();
    expect(data.todos).toEqual([]);
  });
});
