import type {
  ApprovalRequest,
  ContextMeter,
  QuestionRequest,
  TaskSnapshot,
  ThreadEvent,
  ThreadItem,
  ThreadTurn,
  ThreadUsage,
  TodoItem,
  TokenCounts,
  TurnModelUsage
} from "@cw-code/contracts";

export const LOCAL_NOTICE_TURN_ID = "worktree-cleanup";
export const TOOL_OUTPUT_LIMIT = 8000;
export const TOOL_TEXT_LIMIT = 1000;
export const BUFFERED_TASKS_PER_SESSION = 200;

export type ToolCallEvent = Extract<ThreadEvent, { type: "tool.call" }>;
export type TurnStartedEvent = Extract<ThreadEvent, { type: "turn.started" }>;
export type ItemFields = Omit<ThreadItem, "seq">;
export type ThreadField = "turn" | "durations" | "usage" | "todos" | "approvals" | "questions";

export interface ThreadState {
  items: Map<string, ThreadItem>;
  nextSeq: number;
  turn: ThreadTurn | null;
  durations: Record<string, number>;
  usage: ThreadUsage;
  todos: TodoItem[];
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
  bufferedTasks: Map<string, TaskSnapshot>;
  historyLoaded: boolean;
  todosTouched: boolean;
  ignoredTurnStart: TurnStartedEvent | null;
}

export interface ThreadChange {
  upserted: string[];
  removed: string[];
  appended: Array<{ id: string; text: string }>;
  fields: ThreadField[];
  reloaded: boolean;
}

export class ChangeSet {
  private readonly upserted = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly appended: Array<{ id: string; text: string }> = [];
  private readonly fields = new Set<ThreadField>();
  private reloaded = false;

  upsert(id: string): void {
    this.removed.delete(id);
    this.upserted.add(id);
  }

  remove(id: string): void {
    this.upserted.delete(id);
    this.removed.add(id);
  }

  append(id: string, text: string): void {
    this.appended.push({ id, text });
  }

  touch(field: ThreadField): void {
    this.fields.add(field);
  }

  reload(): void {
    this.reloaded = true;
  }

  absorb(change: ThreadChange): void {
    for (const id of change.upserted) this.upsert(id);
    for (const id of change.removed) this.remove(id);
    for (const entry of change.appended) this.append(entry.id, entry.text);
    for (const field of change.fields) this.touch(field);
    if (change.reloaded) this.reloaded = true;
  }

  build(): ThreadChange {
    return {
      upserted: [...this.upserted],
      removed: [...this.removed],
      appended: this.appended.filter((entry) => !this.upserted.has(entry.id) && !this.removed.has(entry.id)),
      fields: [...this.fields],
      reloaded: this.reloaded
    };
  }
}

export function createThreadState(): ThreadState {
  return {
    items: new Map(),
    nextSeq: 1,
    turn: null,
    durations: {},
    usage: { context: null, meter: null, lastTurn: null },
    todos: [],
    approvals: [],
    questions: [],
    bufferedTasks: new Map(),
    historyLoaded: false,
    todosTouched: false,
    ignoredTurnStart: null
  };
}

export function orderedItems(state: ThreadState): ThreadItem[] {
  return [...state.items.values()].sort((a, b) => a.seq - b.seq);
}

export function lastItem(state: ThreadState): ThreadItem | undefined {
  let last: ThreadItem | undefined;
  for (const item of state.items.values()) {
    if (!last || item.seq > last.seq) last = item;
  }
  return last;
}

export function insertItem(state: ThreadState, fields: ItemFields, changes: ChangeSet): ThreadItem {
  const item: ThreadItem = { ...fields, seq: state.nextSeq };
  state.nextSeq += 1;
  state.items.set(item.id, item);
  changes.upsert(item.id);
  return item;
}

export function putItem(state: ThreadState, item: ThreadItem, changes: ChangeSet): void {
  state.items.set(item.id, item);
  changes.upsert(item.id);
}

export function insertOrReplaceItem(state: ThreadState, fields: ItemFields, changes: ChangeSet): void {
  const existing = state.items.get(fields.id);
  if (existing) putItem(state, { ...fields, seq: existing.seq }, changes);
  else insertItem(state, fields, changes);
}

export function removeItem(state: ThreadState, id: string, changes: ChangeSet): void {
  if (!state.items.delete(id)) return;
  changes.remove(id);
}

export function reseqItems(state: ThreadState, ordered: ItemFields[]): void {
  state.items = new Map();
  state.nextSeq = 1;
  for (const fields of ordered) {
    state.items.set(fields.id, { ...fields, seq: state.nextSeq });
    state.nextSeq += 1;
  }
}

function toolCallText(name: string, input: unknown): string {
  return `${name} ${JSON.stringify(input)?.slice(0, 300) ?? ""}`;
}

function hasInput(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "string") return input.length > 0;
  if (typeof input === "object") return Object.keys(input).length > 0;
  return true;
}

export function upsertToolCall(state: ThreadState, event: ToolCallEvent, startedAt: number, changes: ChangeSet): void {
  const existing = state.items.get(event.toolCallId);
  if (existing && existing.role === "tool") {
    putItem(
      state,
      {
        ...existing,
        toolName: event.name,
        ...(hasInput(event.input) ? { toolInput: event.input, text: toolCallText(event.name, event.input) } : {}),
        ...(event.parentToolCallId && !existing.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        ...(event.model ? { subagentModel: event.model } : {}),
        ...(event.task ? { task: event.task } : {})
      },
      changes
    );
    return;
  }
  insertItem(
    state,
    {
      id: event.toolCallId,
      role: "tool",
      text: toolCallText(event.name, event.input),
      turnId: event.turnId,
      toolName: event.name,
      toolInput: event.input,
      toolStartedAt: startedAt,
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      ...(event.model ? { subagentModel: event.model } : {}),
      ...(event.task ? { task: event.task } : {})
    },
    changes
  );
}

function freeId(state: ThreadState, base: string): string {
  let id = base;
  for (let n = 2; state.items.has(id); n++) {
    id = `${base}${n}`;
  }
  return id;
}

export function appendAssistantText(state: ThreadState, turnId: string, text: string, changes: ChangeSet): void {
  const last = lastItem(state);
  if (last && last.role === "assistant" && last.turnId === turnId) {
    state.items.set(last.id, { ...last, text: last.text + text });
    changes.append(last.id, text);
    return;
  }
  insertItem(state, { id: freeId(state, `${turnId}-a`), role: "assistant", text, turnId }, changes);
}

export function appendReasoningText(
  state: ThreadState,
  turnId: string,
  text: string,
  startedAt: number,
  changes: ChangeSet
): void {
  const last = lastItem(state);
  if (last && last.role === "reasoning" && last.turnId === turnId && last.reasoningMs === undefined) {
    state.items.set(last.id, { ...last, text: last.text + text });
    changes.append(last.id, text);
    return;
  }
  insertItem(
    state,
    { id: freeId(state, `${turnId}-th`), role: "reasoning", text, turnId, reasoningStartedAt: startedAt },
    changes
  );
}

export function closeReasoning(state: ThreadState, now: number, changes: ChangeSet): void {
  for (const item of orderedItems(state)) {
    if (item.role !== "reasoning" || item.reasoningMs !== undefined || item.reasoningStartedAt === undefined) continue;
    putItem(state, { ...item, reasoningMs: Math.max(0, now - item.reasoningStartedAt) }, changes);
  }
}

export function finalizeTurnTools(state: ThreadState, turnId: string, now: number, changes: ChangeSet): void {
  for (const item of orderedItems(state)) {
    if (item.role !== "tool" || item.turnId !== turnId) continue;
    if (item.toolInput === undefined || item.toolDone === true || item.toolOutput !== undefined) continue;
    putItem(state, { ...item, toolDone: true, toolCompletedAt: now }, changes);
  }
}

export function withoutRetryNotice(state: ThreadState, turnId: string, changes: ChangeSet): void {
  removeItem(state, `${turnId}-retry`, changes);
}

export function bufferTask(state: ThreadState, task: TaskSnapshot): void {
  state.bufferedTasks.delete(task.id);
  state.bufferedTasks.set(task.id, task);
  if (state.bufferedTasks.size > BUFFERED_TASKS_PER_SESSION) {
    const oldest = state.bufferedTasks.keys().next().value;
    if (oldest !== undefined) state.bufferedTasks.delete(oldest);
  }
}

export function takeBufferedTask(state: ThreadState, taskId: string): TaskSnapshot | undefined {
  const task = state.bufferedTasks.get(taskId);
  if (!task) return undefined;
  state.bufferedTasks.delete(taskId);
  return task;
}

export function withBufferedTasks(state: ThreadState, items: ItemFields[]): ItemFields[] {
  const buffered = state.bufferedTasks;
  if (buffered.size === 0) return items;
  state.bufferedTasks = new Map();
  let changed = false;
  const out = items.map((item) => {
    const task = item.role === "tool" ? buffered.get(item.id) : undefined;
    if (!task) return item;
    changed = true;
    return { ...item, task };
  });
  return changed ? out : items;
}

export function mergeToolPairs(messages: ItemFields[]): ItemFields[] {
  const out: ItemFields[] = [];
  const indexById = new Map<string, number>();
  let pending = -1;
  const attach = (idx: number, source: ItemFields): void => {
    const call = out[idx];
    out[idx] = {
      ...call,
      toolOutput: source.text,
      toolDone: true,
      isError: call.isError === true || source.isError === true,
      ...(source.toolOutputEmpty !== undefined ? { toolOutputEmpty: source.toolOutputEmpty } : {}),
      ...(source.toolUsage ? { toolUsage: source.toolUsage } : {}),
      ...(source.timestamp !== undefined ? { toolCompletedAt: source.timestamp } : {})
    };
  };
  for (const m of messages) {
    if (m.role === "tool" && m.id.endsWith("-r")) {
      const idx = indexById.get(m.id.slice(0, -2));
      if (idx !== undefined && out[idx].role === "tool") {
        attach(idx, m);
        if (pending === idx) pending = -1;
        continue;
      }
    }
    if (
      m.role === "tool" &&
      m.toolName === "result" &&
      pending >= 0 &&
      out[pending].role === "tool" &&
      out[pending].toolInput === undefined &&
      out[pending].toolOutput === undefined
    ) {
      attach(pending, m);
      pending = -1;
      continue;
    }
    const stamped =
      m.role === "tool" && m.toolStartedAt === undefined && m.timestamp !== undefined
        ? { ...m, toolStartedAt: m.timestamp }
        : m;
    indexById.set(stamped.id, out.length);
    out.push(stamped);
    if (stamped.role === "tool" && stamped.toolOutput === undefined) pending = out.length - 1;
  }
  return out;
}

export function hasLoadedItems(items: ItemFields[]): boolean {
  return items.some((m) => m.turnId !== LOCAL_NOTICE_TURN_ID);
}

export function historyAheadOfLive(history: ItemFields[], current: ItemFields[]): ItemFields[] {
  const live = current.filter((m) => m.turnId !== LOCAL_NOTICE_TURN_ID);
  const ids = new Set(live.map((m) => m.id));
  const turnIds = new Set(live.map((m) => m.turnId));
  const stamps = live.flatMap((m) => (m.timestamp !== undefined ? [m.timestamp] : []));
  const liveSince = stamps.length > 0 ? Math.min(...stamps) : undefined;
  const earlier = history.filter(
    (m) =>
      !ids.has(m.id) &&
      !turnIds.has(m.turnId) &&
      (liveSince === undefined || m.timestamp === undefined || m.timestamp < liveSince)
  );
  return [...earlier, ...current];
}

export function durationFromMessages(messages: Array<{ timestamp?: number }>): number | undefined {
  if (messages.length < 2) return undefined;
  const first = messages[0].timestamp;
  const last = messages[messages.length - 1].timestamp;
  if (typeof first !== "number" || typeof last !== "number") return undefined;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
  const diff = last - first;
  return diff >= 0 ? diff : undefined;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${total % 60}s`;
}

export function sumTurnUsage(usage: TurnModelUsage[]): TokenCounts & { costUsd: number | null } {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd: number | null = null;
  for (const entry of usage) {
    inputTokens += entry.inputTokens;
    cacheReadTokens += entry.cacheReadTokens;
    cacheWriteTokens += entry.cacheWriteTokens;
    outputTokens += entry.outputTokens;
    reasoningTokens += entry.reasoningTokens;
    if (entry.costUsd !== null) costUsd = (costUsd ?? 0) + entry.costUsd;
  }
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, costUsd };
}

export function contextMeter(context: { usedTokens: number; windowTokens: number }): ContextMeter {
  const percent = Math.min(1, context.usedTokens / Math.max(1, context.windowTokens));
  return { percent, severity: percent >= 0.95 ? "danger" : percent >= 0.8 ? "warn" : null };
}

export function turnTokens(
  counts: Pick<TokenCounts, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens">
): number {
  return counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens + counts.outputTokens;
}
