import type {
  ContextUsage,
  HistoryMessage,
  TaskSnapshot,
  ThreadEvent,
  ThreadItem,
  ThreadLastTurn,
  ThreadTopicData,
  TodoItem
} from "@cw-code/contracts";
import { overlayLiveTasks } from "../tasks/overlayLiveTasks.js";
import {
  ChangeSet,
  LOCAL_NOTICE_TURN_ID,
  TOOL_OUTPUT_LIMIT,
  TOOL_TEXT_LIMIT,
  appendAssistantText,
  appendReasoningText,
  bufferTask,
  closeReasoning,
  contextMeter,
  createThreadState,
  finalizeTurnTools,
  formatDuration,
  hasLoadedItems,
  historyAheadOfLive,
  insertItem,
  insertOrReplaceItem,
  lastItem,
  mergeToolPairs,
  orderedItems,
  putItem,
  removeItem,
  reseqItems,
  sumTurnUsage,
  takeBufferedTask,
  turnTokens,
  upsertToolCall,
  withBufferedTasks,
  withoutRetryNotice,
  type ItemFields,
  type ThreadChange,
  type ThreadState
} from "./threadItems.js";

export { createThreadState };
export type { ThreadChange, ThreadState };

const PENDING_PREFIX = "pending:";
const EMPTY_LAST_TURN: ThreadLastTurn = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: null,
  durationMs: null,
  tokens: 0
};

function setUsage(state: ThreadState, context: ContextUsage | null, lastTurn: ThreadLastTurn | null, changes: ChangeSet): void {
  state.usage = { context, meter: context ? contextMeter(context) : null, lastTurn };
  changes.touch("usage");
}

function setTodos(state: ThreadState, todos: TodoItem[], changes: ChangeSet): void {
  state.todos = todos;
  state.todosTouched = true;
  changes.touch("todos");
}

function closeTurn(state: ThreadState, turnId: string | undefined, now: number, changes: ChangeSet): void {
  const turn = state.turn;
  state.turn = null;
  changes.touch("turn");
  if (turn && turnId !== undefined) {
    state.durations = { ...state.durations, [turnId]: Math.max(0, now - turn.startedAt) };
    changes.touch("durations");
  }
}

function clearPendingRequests(state: ThreadState, changes: ChangeSet): void {
  if (state.approvals.length > 0) {
    state.approvals = [];
    changes.touch("approvals");
  }
  if (state.questions.length > 0) {
    state.questions = [];
    changes.touch("questions");
  }
}

function noticeFields(notice: { noticeId: string; text: string; severity: "info" | "warning" | "error" }): ItemFields {
  return {
    id: `notice-${notice.noticeId}`,
    role: "system",
    text: notice.text,
    turnId: LOCAL_NOTICE_TURN_ID,
    ...(notice.severity === "error" ? { isError: true } : notice.severity === "warning" ? { severity: "warning" as const } : {})
  };
}

export function appendNotice(
  state: ThreadState,
  notice: { noticeId: string; text: string; severity: "info" | "warning" | "error" }
): ThreadChange {
  const changes = new ChangeSet();
  insertOrReplaceItem(state, noticeFields(notice), changes);
  return changes.build();
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function appendResultText(state: ThreadState, turnId: string, resultText: string, changes: ChangeSet): void {
  if (!resultText.trim()) return;
  const shown = orderedItems(state)
    .filter((m) => m.role === "assistant" && m.turnId === turnId)
    .map((m) => m.text)
    .join("\n");
  if (shown.includes(resultText) || squash(shown).includes(squash(resultText))) return;
  const last = lastItem(state);
  const lastIsAssistant = !!last && last.role === "assistant" && last.turnId === turnId;
  const prefixSource =
    shown.trim() && resultText.startsWith(shown)
      ? shown
      : lastIsAssistant && last.text.trim() && resultText.startsWith(last.text)
        ? last.text
        : null;
  if (prefixSource === null) {
    appendAssistantText(state, turnId, resultText, changes);
    return;
  }
  const suffix = resultText.slice(prefixSource.length);
  if (suffix.trim()) appendAssistantText(state, turnId, suffix, changes);
}

function findToolResultTarget(state: ThreadState, toolCallId: string): ThreadItem | undefined {
  const candidates = [state.items.get(toolCallId), state.items.get(`${toolCallId}-r`)].filter(
    (m): m is ThreadItem => m !== undefined && m.role === "tool"
  );
  return candidates.sort((a, b) => a.seq - b.seq)[0];
}

function applyToolResult(
  state: ThreadState,
  event: Extract<ThreadEvent, { type: "tool.result" }>,
  now: number,
  changes: ChangeSet
): void {
  const call = findToolResultTarget(state, event.toolCallId);
  if (call) {
    putItem(
      state,
      {
        ...call,
        ...(call.id === `${event.toolCallId}-r` ? { text: event.output.slice(0, TOOL_TEXT_LIMIT) } : {}),
        toolOutput: event.output.slice(0, TOOL_OUTPUT_LIMIT),
        toolDone: true,
        toolCompletedAt: now,
        isError: call.isError === true || event.isError,
        ...(event.outputEmpty !== undefined ? { toolOutputEmpty: event.outputEmpty } : {}),
        ...(event.usage ? { toolUsage: event.usage } : {}),
        ...(event.agentId ? { subagentAgentId: event.agentId } : {}),
        ...(event.model ? { subagentModel: event.model } : {})
      },
      changes
    );
    return;
  }
  insertItem(
    state,
    {
      id: `${event.toolCallId}-r`,
      role: "tool",
      text: event.output.slice(0, TOOL_TEXT_LIMIT),
      turnId: event.turnId,
      isError: event.isError,
      ...(event.outputEmpty !== undefined ? { toolOutputEmpty: event.outputEmpty } : {}),
      ...(event.usage ? { toolUsage: event.usage } : {}),
      ...(event.agentId ? { subagentAgentId: event.agentId } : {}),
      ...(event.model ? { subagentModel: event.model } : {}),
      toolCompletedAt: now
    },
    changes
  );
}

function applyTurnDone(state: ThreadState, event: Extract<ThreadEvent, { type: "turn.done" }>, now: number, changes: ChangeSet): void {
  closeReasoning(state, now, changes);
  const backgroundTasks = event.backgroundTasks ?? 0;
  const busyMatch = state.turn !== null && state.turn.turnId === event.turnId;
  const isFinal = busyMatch && backgroundTasks === 0;
  const superseded = state.turn !== null && !busyMatch;
  if (isFinal) closeTurn(state, event.turnId, now, changes);
  if (busyMatch) clearPendingRequests(state, changes);
  finalizeTurnTools(state, event.turnId, now, changes);
  withoutRetryNotice(state, event.turnId, changes);
  if (!event.isError) appendResultText(state, event.turnId, event.resultText ?? "", changes);
  if (event.isError && !state.items.has(`${event.turnId}-e`)) {
    insertItem(
      state,
      {
        id: `${event.turnId}-e`,
        role: "system",
        text: `Error: ${event.resultText || "Claude reported an error with no output."}`,
        turnId: event.turnId,
        isError: true
      },
      changes
    );
  }
  if (superseded) return;
  const sum = sumTurnUsage(event.usage);
  setUsage(
    state,
    event.context ?? state.usage.context,
    { ...sum, durationMs: state.durations[event.turnId] ?? null, tokens: turnTokens(sum) },
    changes
  );
}

function applyTurnError(state: ThreadState, event: Extract<ThreadEvent, { type: "turn.error" }>, now: number, changes: ChangeSet): void {
  closeReasoning(state, now, changes);
  if (state.turn !== null && state.turn.turnId === event.turnId) closeTurn(state, event.turnId, now, changes);
  clearPendingRequests(state, changes);
  finalizeTurnTools(state, event.turnId, now, changes);
  withoutRetryNotice(state, event.turnId, changes);
  insertOrReplaceItem(
    state,
    {
      id: `${event.turnId}-e`,
      role: "system",
      text: `Error: ${event.message}`,
      turnId: event.turnId,
      isError: true,
      ...(event.retryable ? { retryable: true } : {})
    },
    changes
  );
}

function applyTurnRetry(state: ThreadState, event: Extract<ThreadEvent, { type: "turn.retry" }>, now: number, changes: ChangeSet): void {
  closeReasoning(state, now, changes);
  const id = `${event.turnId}-retry`;
  const attempt = event.attempt > 0 ? ` (attempt ${event.attempt})` : "";
  const wait = event.retryAt > now ? ` in ${formatDuration(event.retryAt - now)}` : "";
  const lines = [`Retrying${wait}${attempt}: ${event.message}`];
  if (event.detail) lines.push(event.detail);
  if (event.link) lines.push(event.link);
  const text = lines.join("\n");
  const existing = state.items.get(id);
  if (existing) putItem(state, { ...existing, text }, changes);
  else insertItem(state, { id, role: "system", text, turnId: event.turnId, severity: "warning" }, changes);
}

function applyCompaction(state: ThreadState, event: Extract<ThreadEvent, { type: "context.compacted" }>, now: number, changes: ChangeSet): void {
  closeReasoning(state, now, changes);
  insertOrReplaceItem(
    state,
    {
      id: `${event.turnId}-compaction`,
      role: "system",
      text: "Context compacted",
      turnId: event.turnId,
      compaction: event.compaction
    },
    changes
  );
  if (event.context) setUsage(state, event.context, state.usage.lastTurn ?? EMPTY_LAST_TURN, changes);
}

function applyQuestionResolved(
  state: ThreadState,
  event: Extract<ThreadEvent, { type: "question.resolved" }>,
  now: number,
  changes: ChangeSet
): void {
  closeReasoning(state, now, changes);
  state.questions = state.questions.filter((q) => q.requestId !== event.requestId);
  changes.touch("questions");
  if (!event.answers) return;
  insertOrReplaceItem(
    state,
    {
      id: `${event.requestId}-ans`,
      role: "tool",
      text: Object.entries(event.answers)
        .map(([q, a]) => `${q} → ${a}`)
        .join("\n"),
      turnId: event.turnId,
      toolCompletedAt: now
    },
    changes
  );
}

function applyTurnStarted(state: ThreadState, event: Extract<ThreadEvent, { type: "turn.started" }>, changes: ChangeSet): void {
  if (state.turn !== null && state.turn.turnId === null) {
    state.ignoredTurnStart = event;
    return;
  }
  if (state.turn?.turnId === event.turnId) return;
  state.turn = { phase: "running", turnId: event.turnId, startedAt: event.startedAt, auto: false };
  changes.touch("turn");
  setTodos(state, [], changes);
  const userId = `${event.turnId}-u`;
  if (event.prompt === "" || state.items.has(userId)) return;
  insertItem(state, { id: userId, role: "user", text: event.prompt, turnId: event.turnId, timestamp: event.startedAt }, changes);
}

function applyEvent(state: ThreadState, event: ThreadEvent, now: number, changes: ChangeSet): void {
  if (event.type === "task.updated") {
    const existing = state.items.get(event.task.id);
    if (!existing || existing.role !== "tool") {
      bufferTask(state, event.task);
      return;
    }
    putItem(state, { ...existing, task: event.task }, changes);
    return;
  }
  if (event.type === "session.notice") {
    insertOrReplaceItem(state, noticeFields(event), changes);
    return;
  }
  if (event.type === "turn.started") {
    applyTurnStarted(state, event, changes);
    return;
  }
  if (event.type === "turn.interrupted") {
    if (state.turn?.turnId !== event.turnId) return;
    closeTurn(state, event.turnId, now, changes);
    clearPendingRequests(state, changes);
    return;
  }
  if (event.type !== "turn.retry" && event.type !== "turn.done" && event.type !== "turn.error") {
    withoutRetryNotice(state, event.turnId, changes);
  }
  switch (event.type) {
    case "reasoning.delta":
      appendReasoningText(state, event.turnId, event.text, now, changes);
      return;
    case "assistant.delta":
      closeReasoning(state, now, changes);
      appendAssistantText(state, event.turnId, event.text, changes);
      return;
    case "context.compacted":
      applyCompaction(state, event, now, changes);
      return;
    case "approval.request":
      if (state.approvals.some((p) => p.requestId === event.request.requestId)) return;
      state.approvals = [...state.approvals, event.request];
      changes.touch("approvals");
      return;
    case "approval.resolved":
      state.approvals = state.approvals.filter((p) => p.requestId !== event.requestId);
      changes.touch("approvals");
      return;
    case "question.request":
      if (state.questions.some((q) => q.requestId === event.request.requestId)) return;
      state.questions = [...state.questions, event.request];
      changes.touch("questions");
      return;
    case "question.resolved":
      applyQuestionResolved(state, event, now, changes);
      return;
    case "tool.call": {
      closeReasoning(state, now, changes);
      const buffered = takeBufferedTask(state, event.toolCallId);
      upsertToolCall(state, buffered && !event.task ? { ...event, task: buffered } : event, now, changes);
      return;
    }
    case "tool.result":
      closeReasoning(state, now, changes);
      applyToolResult(state, event, now, changes);
      return;
    case "todo.updated":
      setTodos(state, event.todos, changes);
      return;
    case "turn.retry":
      applyTurnRetry(state, event, now, changes);
      return;
    case "turn.done":
      applyTurnDone(state, event, now, changes);
      return;
    case "turn.error":
      applyTurnError(state, event, now, changes);
      return;
    case "permission.mode.reported":
    case "session.branch.updated":
      return;
  }
}

export function reduceThreadEvent(state: ThreadState, event: ThreadEvent, now: number): ThreadChange {
  const changes = new ChangeSet();
  applyEvent(state, event, now, changes);
  return changes.build();
}

function claimTasks(state: ThreadState, history: HistoryMessage[], liveTasks: TaskSnapshot[]): ItemFields[] {
  const overlaid = overlayLiveTasks(history, liveTasks);
  return withBufferedTasks(state, mergeToolPairs(overlaid));
}

export function mergeHistory(state: ThreadState, history: HistoryMessage[], liveTasks: TaskSnapshot[]): ThreadChange {
  const changes = new ChangeSet();
  const firstLoad = !state.historyLoaded;
  state.historyLoaded = true;
  if (!firstLoad || history.length === 0) return changes.build();
  const merged = claimTasks(state, history, liveTasks);
  const current = orderedItems(state);
  reseqItems(state, hasLoadedItems(current) ? historyAheadOfLive(merged, current) : [...merged, ...current]);
  changes.reload();
  if (!state.todosTouched) {
    const seeded = [...merged].reverse().find((m) => m.todos !== undefined)?.todos;
    if (seeded !== undefined) setTodos(state, seeded, changes);
  }
  return changes.build();
}

export function replaceHistory(state: ThreadState, history: HistoryMessage[], liveTasks: TaskSnapshot[]): ThreadChange {
  const changes = new ChangeSet();
  reseqItems(state, claimTasks(state, history, liveTasks));
  state.historyLoaded = true;
  changes.reload();
  return changes.build();
}

export function beginTurn(
  state: ThreadState,
  input: { prompt: string; now: number; auto: boolean }
): { pendingId: string; previousTodos: TodoItem[]; change: ThreadChange } {
  if (state.turn !== null && state.turn.turnId === null) throw new Error("session busy (turn pending)");
  const changes = new ChangeSet();
  const previousTodos = state.todos;
  const pendingId = `${PENDING_PREFIX}${state.nextSeq}`;
  state.ignoredTurnStart = null;
  state.turn = { phase: "starting", turnId: null, startedAt: input.now, auto: input.auto };
  changes.touch("turn");
  setTodos(state, [], changes);
  insertItem(
    state,
    { id: pendingId, role: "user", text: input.prompt, turnId: pendingId, timestamp: input.now, pending: true },
    changes
  );
  return { pendingId, previousTodos, change: changes.build() };
}

function rekeyEcho(state: ThreadState, echo: ThreadItem, id: string, turnId: string): void {
  const { pending: _pending, ...settled } = echo;
  const entries = [...state.items.entries()].map(([key, item]): [string, ThreadItem] =>
    key === echo.id ? [id, { ...settled, id, turnId }] : [key, item]
  );
  state.items = new Map(entries);
}

export function commitTurn(state: ThreadState, pendingId: string, turnId: string): ThreadChange {
  const changes = new ChangeSet();
  state.ignoredTurnStart = null;
  if (state.turn !== null && state.turn.turnId === null) {
    state.turn = { ...state.turn, phase: "running", turnId };
    changes.touch("turn");
  }
  const echo = state.items.get(pendingId);
  if (!echo) return changes.build();
  const userId = `${turnId}-u`;
  if (state.items.has(userId)) {
    removeItem(state, pendingId, changes);
    return changes.build();
  }
  rekeyEcho(state, echo, userId, turnId);
  changes.remove(pendingId);
  changes.upsert(userId);
  return changes.build();
}

export function abortTurn(state: ThreadState, pendingId: string, previousTodos: TodoItem[]): ThreadChange {
  const changes = new ChangeSet();
  removeItem(state, pendingId, changes);
  if (state.turn === null || state.turn.turnId !== null) return changes.build();
  closeTurn(state, undefined, state.turn.startedAt, changes);
  if (previousTodos.length > 0 && state.todos.length === 0) setTodos(state, previousTodos, changes);
  const remoteStart = state.ignoredTurnStart;
  state.ignoredTurnStart = null;
  if (remoteStart) changes.absorb(reduceThreadEvent(state, remoteStart, remoteStart.startedAt));
  return changes.build();
}

export function toTopicData(
  state: ThreadState
): Pick<ThreadTopicData, "turn" | "durations" | "usage" | "todos" | "approvals" | "questions"> &
  Record<`item/${string}`, ThreadItem> {
  const items: Record<`item/${string}`, ThreadItem> = {};
  for (const item of orderedItems(state)) items[`item/${item.id}`] = item;
  return {
    turn: state.turn,
    durations: state.durations,
    usage: state.usage,
    todos: state.todos,
    approvals: state.approvals,
    questions: state.questions,
    ...items
  };
}
