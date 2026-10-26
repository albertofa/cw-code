import { describe, expect, it } from "bun:test";
import type { HistoryMessage, TaskSnapshot } from "@cw-code/contracts";
import { mapOpencodeMessages } from "../providers/opencode/opencodeHistory.js";
import {
  ChangeSet,
  appendAssistantText,
  appendReasoningText,
  bufferTask,
  closeReasoning,
  contextMeter,
  createThreadState,
  durationFromMessages,
  insertItem,
  mergeToolPairs,
  orderedItems,
  sumTurnUsage,
  turnTokens,
  upsertToolCall,
  type ItemFields,
  type ThreadState,
  type ToolCallEvent
} from "./threadItems.js";

function stateWith(...items: ItemFields[]): ThreadState {
  const state = createThreadState();
  for (const item of items) insertItem(state, item, new ChangeSet());
  return state;
}

function toolMessage(id: string, turnId = "t1"): ItemFields {
  return { id, role: "tool", text: "output", turnId };
}

function call(partial: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { type: "tool.call", turnId: "t1", toolCallId: "call-1", name: "task", input: {}, ...partial };
}

function strip(items: Array<{ seq: number }>): unknown[] {
  return items.map(({ seq: _seq, ...rest }) => rest);
}

describe("upsertToolCall", () => {
  it("appends a new tool call with its start time", () => {
    const state = createThreadState();
    const changes = new ChangeSet();
    upsertToolCall(state, call({ input: { description: "Review" } }), 1000, changes);
    expect(strip(orderedItems(state))).toEqual([
      {
        id: "call-1",
        role: "tool",
        text: 'task {"description":"Review"}',
        turnId: "t1",
        toolName: "task",
        toolInput: { description: "Review" },
        toolStartedAt: 1000
      }
    ]);
    expect(changes.build().upserted).toEqual(["call-1"]);
  });

  it("applies a subagent model carried by a replayed call", () => {
    const state = createThreadState();
    upsertToolCall(state, call({ input: { description: "Review" } }), 1000, new ChangeSet());
    upsertToolCall(state, call({ model: "gpt-5" }), 2000, new ChangeSet());
    const items = orderedItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ toolInput: { description: "Review" }, subagentModel: "gpt-5", toolStartedAt: 1000 });
  });

  it("merges a replayed call in place instead of duplicating it", () => {
    const existing: ItemFields = {
      id: "call-1",
      role: "tool",
      text: "task {}",
      turnId: "t1",
      toolName: "task",
      toolInput: {},
      toolStartedAt: 1000,
      toolOutput: "done",
      toolDone: true,
      toolCompletedAt: 5000
    };
    const state = stateWith(toolMessage("other"), existing);
    upsertToolCall(
      state,
      call({ turnId: "t2", input: { description: "Review", subagent_type: "general" } }),
      9000,
      new ChangeSet()
    );
    const items = orderedItems(state);
    expect(items).toHaveLength(2);
    expect(strip([items[1]])[0]).toEqual({
      ...existing,
      text: 'task {"description":"Review","subagent_type":"general"}',
      toolInput: { description: "Review", subagent_type: "general" }
    });
    expect(items[1].seq).toBe(2);
  });

  it("keeps the richer input when a replay carries none", () => {
    const existing: ItemFields = {
      id: "call-1",
      role: "tool",
      text: 'task {"description":"Review"}',
      turnId: "t1",
      toolName: "task",
      toolInput: { description: "Review" },
      toolStartedAt: 1000
    };
    const state = stateWith(existing);
    upsertToolCall(state, call({ input: null, turnId: "t2" }), 9000, new ChangeSet());
    expect(strip(orderedItems(state))).toEqual([existing]);
  });

  it("keeps the original turn id when a later turn replays the call", () => {
    const state = createThreadState();
    upsertToolCall(state, call(), 1000, new ChangeSet());
    upsertToolCall(state, call({ turnId: "t2" }), 9000, new ChangeSet());
    const [item] = orderedItems(state);
    expect(item.turnId).toBe("t1");
    expect(item.toolStartedAt).toBe(1000);
  });
});

describe("appendAssistantText", () => {
  it("merges contiguous deltas into a single message and reports the delta", () => {
    const state = createThreadState();
    const first = new ChangeSet();
    appendAssistantText(state, "t1", "Hello ", first);
    const second = new ChangeSet();
    appendAssistantText(state, "t1", "world", second);
    expect(strip(orderedItems(state))).toEqual([{ id: "t1-a", role: "assistant", text: "Hello world", turnId: "t1" }]);
    expect(first.build()).toMatchObject({ upserted: ["t1-a"], appended: [] });
    expect(second.build()).toMatchObject({ upserted: [], appended: [{ id: "t1-a", text: "world" }] });
  });

  it("appends a distinct id when a tool message splits the text", () => {
    const state = createThreadState();
    appendAssistantText(state, "t1", "before", new ChangeSet());
    insertItem(state, toolMessage("call-1"), new ChangeSet());
    appendAssistantText(state, "t1", "after", new ChangeSet());
    const items = orderedItems(state);
    const assistants = items.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.id)).toEqual(["t1-a", "t1-a2"]);
    expect(assistants.map((m) => m.text)).toEqual(["before", "after"]);
    expect(new Set(items.map((m) => m.id)).size).toBe(items.length);
  });

  it("never reuses an id across many split segments", () => {
    const state = createThreadState();
    const expectedIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      appendAssistantText(state, "t1", `segment ${i}`, new ChangeSet());
      expectedIds.push(i === 0 ? "t1-a" : `t1-a${i + 1}`);
      insertItem(state, toolMessage(`call-${i}`), new ChangeSet());
    }
    const assistantIds = orderedItems(state)
      .filter((m) => m.role === "assistant")
      .map((m) => m.id);
    expect(assistantIds).toEqual(expectedIds);
    expect(new Set(assistantIds).size).toBe(assistantIds.length);
  });

  it("merges in place and keeps the original order", () => {
    const user: ItemFields = { id: "t1-u", role: "user", text: "hi", turnId: "t1" };
    const state = stateWith(user, toolMessage("call-1"));
    appendAssistantText(state, "t1", "one", new ChangeSet());
    appendAssistantText(state, "t1", " two", new ChangeSet());
    const items = orderedItems(state);
    expect(items).toHaveLength(3);
    expect(items.map((m) => m.id)).toEqual(["t1-u", "call-1", "t1-a"]);
    expect(items[2].text).toBe("one two");
  });

  it("follows seq order when the map insertion order differs", () => {
    const state = stateWith(toolMessage("a"), toolMessage("b"));
    const a = state.items.get("a");
    if (!a) throw new Error("missing");
    state.items.delete("a");
    state.items.set("a", { ...a, seq: 1 });
    appendAssistantText(state, "t1", "x", new ChangeSet());
    expect(orderedItems(state).map((m) => m.id)).toEqual(["a", "b", "t1-a"]);
  });
});

describe("appendReasoningText", () => {
  it("merges contiguous reasoning deltas and stamps the start time", () => {
    const state = createThreadState();
    appendReasoningText(state, "t1", "thinking ", 1000, new ChangeSet());
    const changes = new ChangeSet();
    appendReasoningText(state, "t1", "harder", 1100, changes);
    expect(strip(orderedItems(state))).toEqual([
      { id: "t1-th", role: "reasoning", text: "thinking harder", turnId: "t1", reasoningStartedAt: 1000 }
    ]);
    expect(changes.build().appended).toEqual([{ id: "t1-th", text: "harder" }]);
  });

  it("starts a distinct block when a closed run or other message precedes it", () => {
    const state = createThreadState();
    appendReasoningText(state, "t1", "first", 1000, new ChangeSet());
    closeReasoning(state, 4000, new ChangeSet());
    appendReasoningText(state, "t1", "second", 9000, new ChangeSet());
    const items = orderedItems(state);
    expect(items.map((m) => m.id)).toEqual(["t1-th", "t1-th2"]);
    expect(items.map((m) => m.reasoningStartedAt)).toEqual([1000, 9000]);
  });
});

describe("closeReasoning", () => {
  it("records the measured duration on the open tail run", () => {
    const state = createThreadState();
    appendReasoningText(state, "t1", "thinking", 1000, new ChangeSet());
    const changes = new ChangeSet();
    closeReasoning(state, 4500, changes);
    expect(orderedItems(state)[0].reasoningMs).toBe(3500);
    expect(changes.build().upserted).toEqual(["t1-th"]);
  });

  it("changes nothing when no reasoning is open", () => {
    const state = createThreadState();
    appendAssistantText(state, "t1", "answer", new ChangeSet());
    const changes = new ChangeSet();
    closeReasoning(state, 4500, changes);
    expect(changes.build()).toEqual({ upserted: [], removed: [], appended: [], fields: [], reloaded: false });
  });

  it("leaves already closed reasoning untouched", () => {
    const state = createThreadState();
    appendReasoningText(state, "t1", "thinking", 1000, new ChangeSet());
    closeReasoning(state, 2000, new ChangeSet());
    closeReasoning(state, 9000, new ChangeSet());
    expect(orderedItems(state)[0].reasoningMs).toBe(1000);
  });

  it("closes a run whose turn was interrupted without a follow-up event", () => {
    const state = createThreadState();
    appendReasoningText(state, "t1", "thinking", 1000, new ChangeSet());
    insertItem(state, toolMessage("call-1"), new ChangeSet());
    closeReasoning(state, 3000, new ChangeSet());
    expect(orderedItems(state)[0].reasoningMs).toBe(2000);
  });
});

describe("ChangeSet", () => {
  it("drops appended deltas for items that were upserted or removed in the same change", () => {
    const changes = new ChangeSet();
    changes.append("a", "x");
    changes.append("b", "y");
    changes.append("c", "z");
    changes.upsert("a");
    changes.remove("c");
    expect(changes.build().appended).toEqual([{ id: "b", text: "y" }]);
  });

  it("keeps the latest of an upsert and a removal of the same id", () => {
    const changes = new ChangeSet();
    changes.upsert("a");
    changes.remove("a");
    changes.upsert("b");
    changes.remove("b");
    changes.upsert("b");
    expect(changes.build()).toMatchObject({ upserted: ["b"], removed: ["a"] });
  });
});

function msg(partial: Partial<ItemFields> & { id: string }): ItemFields {
  return { role: "tool", text: "", turnId: "t1", ...partial };
}

describe("mergeToolPairs", () => {
  it("folds -r result messages into their call", () => {
    const merged = mergeToolPairs([
      msg({ id: "c1", toolName: "Read", text: "call" }),
      msg({ id: "c1-r", toolName: "Read", text: "file contents" }),
      msg({ id: "c2", toolName: "Bash", text: "call" })
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolOutput).toBe("file contents");
    expect(merged[0].toolDone).toBe(true);
    expect(merged[1].toolOutput).toBeUndefined();
  });

  it("propagates history timestamps into tool start and completion times", () => {
    const merged = mergeToolPairs([
      msg({ id: "c1", toolName: "Task", text: "call", timestamp: 1000 }),
      msg({ id: "c1-r", toolName: "Task", text: "done", timestamp: 46000 })
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].toolStartedAt).toBe(1000);
    expect(merged[0].toolCompletedAt).toBe(46000);
    expect(merged[0].toolDone).toBe(true);
  });

  it("keeps live-stamped times over history timestamps", () => {
    const merged = mergeToolPairs([
      msg({ id: "c1", toolName: "Task", text: "call", toolStartedAt: 5000, timestamp: 1000 }),
      msg({ id: "c1-r", toolName: "Task", text: "done", timestamp: 46000 })
    ]);
    expect(merged[0].toolStartedAt).toBe(5000);
    expect(merged[0].toolCompletedAt).toBe(46000);
  });

  it("keeps the task snapshot on the merged call", () => {
    const task: TaskSnapshot = { id: "c1", kind: "agent", background: true, state: "completed", runCount: 1 };
    const merged = mergeToolPairs([
      msg({ id: "c1", toolName: "Agent", text: "call", task }),
      msg({ id: "c1-r", toolName: "Agent", text: "done" })
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].task).toEqual(task);
    expect(merged[0].toolOutput).toBe("done");
  });

  it("keeps orphan results", () => {
    const merged = mergeToolPairs([msg({ id: "zzz-r", toolName: "result", text: "out" })]);
    expect(merged).toHaveLength(1);
  });

  it("pairs results to their calls even with interleaved calls", () => {
    const merged = mergeToolPairs([
      msg({ id: "tu1", toolName: "Bash", text: 'Bash {"command":"a"}' }),
      msg({ id: "tu2", toolName: "Task", text: 'Task {"description":"b"}' }),
      msg({ id: "tu1-r", toolName: "result", text: "out-a" }),
      msg({ id: "tu2-r", toolName: "result", text: "out-b" })
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolOutput).toBe("out-a");
    expect(merged[1].toolOutput).toBe("out-b");
  });

  it("folds history-shaped results into the preceding pending call", () => {
    const merged = mergeToolPairs([
      msg({ id: "toolu_1", toolName: "Bash", text: 'Bash {"command":"ls"}' }),
      msg({ id: "uuid-t0", toolName: "result", text: "out" }),
      msg({ id: "toolu_2", toolName: "Bash", text: 'Bash {"command":"pwd"}' }),
      msg({ id: "uuid-t1", toolName: "result", text: "out2" })
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolOutput).toBe("out");
    expect(merged[0].toolDone).toBe(true);
    expect(merged[1].toolOutput).toBe("out2");
  });

  it("does not attach history results to live calls with structured input", () => {
    const merged = mergeToolPairs([
      msg({ id: "live", toolName: "Bash", text: "call", toolInput: { command: "ls" } }),
      msg({ id: "uuid-t0", toolName: "result", text: "out" })
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolOutput).toBeUndefined();
  });
});

describe("mergeToolPairs over opencode history", () => {
  it("tool call cards merge their paired results so they resolve to done", () => {
    const history: HistoryMessage[] = mapOpencodeMessages([
      {
        info: { id: "m3", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "webfetch",
            callID: "call_mix",
            state: { status: "completed", input: { url: "https://example.com" }, output: "page body" }
          }
        ]
      }
    ]);
    const merged = mergeToolPairs(history);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "call_mix",
      toolName: "webfetch",
      toolDone: true,
      toolOutput: "page body"
    });
  });
});

describe("bufferTask", () => {
  it("keeps only the latest snapshot per task id and caps at 200", () => {
    const state = createThreadState();
    const task = (id: string, runCount = 1): TaskSnapshot => ({ id, kind: "agent", background: true, state: "running", runCount });
    bufferTask(state, task("a", 1));
    bufferTask(state, task("a", 2));
    expect(state.bufferedTasks.get("a")?.runCount).toBe(2);
    for (let i = 0; i < 200; i += 1) bufferTask(state, task(`call_${i}`));
    expect(state.bufferedTasks.size).toBe(200);
    expect(state.bufferedTasks.has("a")).toBe(false);
  });
});

describe("durationFromMessages", () => {
  it("returns the span between the first and last timestamp", () => {
    expect(durationFromMessages([{ timestamp: 1000 }, { timestamp: 4000 }])).toBe(3000);
  });

  it("returns undefined for a single message, missing or reversed timestamps", () => {
    expect(durationFromMessages([{ timestamp: 1000 }])).toBeUndefined();
    expect(durationFromMessages([{ timestamp: 1000 }, {}])).toBeUndefined();
    expect(durationFromMessages([{ timestamp: 4000 }, { timestamp: 1000 }])).toBeUndefined();
  });
});

describe("usage helpers", () => {
  it("sums per-model usage and leaves cost null when nothing is priced", () => {
    const base = { model: "m", inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 5 };
    expect(sumTurnUsage([{ ...base, costUsd: null }, { ...base, costUsd: null }]).costUsd).toBeNull();
    expect(sumTurnUsage([{ ...base, costUsd: 0.5 }, { ...base, costUsd: null }, { ...base, costUsd: 0.25 }])).toEqual({
      inputTokens: 3,
      cacheReadTokens: 6,
      cacheWriteTokens: 9,
      outputTokens: 12,
      reasoningTokens: 15,
      costUsd: 0.75
    });
  });

  it("flags the context meter at 80% and 95%", () => {
    expect(contextMeter({ usedTokens: 79, windowTokens: 100 }).severity).toBeNull();
    expect(contextMeter({ usedTokens: 80, windowTokens: 100 }).severity).toBe("warn");
    expect(contextMeter({ usedTokens: 95, windowTokens: 100 }).severity).toBe("danger");
    expect(contextMeter({ usedTokens: 500, windowTokens: 100 }).percent).toBe(1);
  });

  it("totals turn tokens without reasoning", () => {
    expect(turnTokens({ inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 })).toBe(10);
  });
});
