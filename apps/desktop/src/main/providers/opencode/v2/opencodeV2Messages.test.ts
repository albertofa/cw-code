import { describe, expect, it } from "vitest";
import { mapOpencodeMessages } from "../opencodeHistory.js";
import { summarizeOpencodeTurn, turnMessagesOf } from "../opencodeMessage.js";
import { collectTaskParts, diffLiveTools, type LiveMessage } from "../opencodeLivePoll.js";
import { mapV2Messages, v2PendingChildren, v2RunIds, v2Running, v2TurnEnded } from "./opencodeV2Messages.js";

const MODEL_SWITCH = { id: "msg_1", time: { created: 1 }, type: "model-switched", model: { id: "big-pickle", providerID: "opencode" } };
const USER = { id: "msg_2", time: { created: 2 }, text: "Read README.md, then reply DONE", type: "user" };
const STEP_ONE = {
  id: "msg_3",
  time: { created: 3, streamed: 4, completed: 5 },
  type: "assistant",
  agent: "build",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  content: [
    { type: "reasoning", text: "Read it first.", time: { created: 3, completed: 4 } },
    {
      type: "tool",
      id: "call_read",
      name: "read",
      executed: false,
      state: {
        status: "completed",
        input: { path: "README.md" },
        content: [{ type: "text", text: "Read file README.md, lines 1-1\n1: hello" }],
        metadata: { truncated: false }
      },
      time: { created: 3, ran: 4, completed: 5 }
    }
  ],
  finish: "tool-calls",
  cost: 0.25,
  tokens: { input: 3564, output: 18, reasoning: 16, cache: { read: 4608, write: 0 } }
};
const STEP_TWO = {
  id: "msg_4",
  time: { created: 6, streamed: 7, completed: 8 },
  type: "assistant",
  agent: "build",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  content: [{ type: "text", text: "DONE" }],
  finish: "stop",
  cost: 0.5,
  tokens: { input: 163, output: 3, reasoning: 12, cache: { read: 8064, write: 0 } }
};
const IDLE = { id: "msg_5", time: { created: 9 }, type: "idle", outcome: "succeeded" };

describe("mapV2Messages", () => {
  it("maps a captured v2 turn into the shared message shape and hides bookkeeping", () => {
    const mapped = mapV2Messages([MODEL_SWITCH, USER, STEP_ONE, STEP_TWO, IDLE]);
    expect(mapped.map((m) => [m.info?.id, m.info?.role])).toEqual([
      ["msg_2", "user"],
      ["msg_3", "assistant"],
      ["msg_4", "assistant"],
      ["msg_5", "idle"]
    ]);
    expect(mapped[1]).toMatchObject({
      info: { providerID: "opencode", modelID: "big-pickle", finish: "tool-calls", cost: 0.25 },
      parts: [
        { type: "reasoning", text: "Read it first.", time: { start: 3, end: 4 } },
        {
          type: "tool",
          tool: "read",
          callID: "call_read",
          state: { status: "completed", input: { path: "README.md" }, output: "Read file README.md, lines 1-1\n1: hello" }
        }
      ]
    });
  });

  it("feeds history, tool diffing and the turn summary unchanged", () => {
    const mapped = mapV2Messages([MODEL_SWITCH, USER, STEP_ONE, STEP_TWO, IDLE]);
    const history = mapOpencodeMessages(mapped);
    expect(history.map((h) => [h.role, h.text])).toEqual([
      ["user", "Read README.md, then reply DONE"],
      ["reasoning", "Read it first."],
      ["tool", 'read {"path":"README.md"}'],
      ["tool", "Read file README.md, lines 1-1\n1: hello"],
      ["assistant", "DONE"]
    ]);
    const tools = diffLiveTools(new Map(), mapped as LiveMessage[], "turn-1", new Set(["msg_2"]));
    expect(tools.map((e) => e.type)).toEqual(["tool.call", "tool.result"]);
    const summary = summarizeOpencodeTurn(turnMessagesOf(mapped), new Set(["msg_2"]));
    expect(summary.text).toBe("DONE");
    expect(summary.errorText).toBe("");
    expect(summary.usage).toEqual([
      expect.objectContaining({ model: "opencode/big-pickle", inputTokens: 3727, outputTokens: 49, costUsd: 0.75 })
    ]);
  });

  it("reports a failed turn from its idle marker, once", () => {
    const failedStep = { ...STEP_TWO, content: [], finish: undefined, error: { type: "provider.auth", message: "bad key" } };
    const failedIdle = { ...IDLE, outcome: "failed", error: { type: "provider.auth", message: "bad key" } };
    const mapped = mapV2Messages([USER, failedStep, failedIdle]);
    const history = mapOpencodeMessages(mapped);
    expect(history.filter((h) => h.isError).map((h) => h.text)).toEqual(["bad key"]);
    expect(summarizeOpencodeTurn(turnMessagesOf(mapped), new Set()).errorText).toBe("bad key");
  });

  it("lets a succeeded idle clear an error from a step that was retried", () => {
    const failedStep = { ...STEP_ONE, error: { type: "tool.execution", message: "flaky" } };
    const mapped = mapV2Messages([USER, failedStep, STEP_TWO, IDLE]);
    expect(summarizeOpencodeTurn(turnMessagesOf(mapped), new Set()).errorText).toBe("");
  });

  it("shows a compaction as a compacted marker", () => {
    const compaction = { id: "msg_c", time: { created: 10 }, type: "compaction", status: "completed", reason: "manual", summary: "S", recent: "" };
    const mapped = mapV2Messages([USER, compaction, IDLE]);
    expect(mapOpencodeMessages(mapped).find((h) => h.role === "system")).toMatchObject({ text: "Context compacted" });
    expect(summarizeOpencodeTurn(turnMessagesOf(mapped), new Set()).compacted).toBe(true);
  });

  it("maps user file attachments", () => {
    const user = { ...USER, files: [{ uri: "file:///C:/p/shot.png", name: "shot.png", mime: "image/png" }] };
    expect(mapV2Messages([user])[0].parts?.[1]).toEqual({
      id: "msg_2:file:0",
      type: "file",
      filename: "shot.png",
      mime: "image/png",
      url: "file:///C:/p/shot.png"
    });
  });
});

describe("v2 turn state", () => {
  const launch = {
    ...STEP_ONE,
    id: "msg_launch",
    content: [
      {
        type: "tool",
        id: "call_sub",
        name: "subagent",
        state: {
          status: "completed",
          input: { agent: "general", description: "Read", prompt: "read it", background: true },
          content: [{ type: "text", text: "The subagent is working in the background" }],
          metadata: { sessionID: "ses_child", status: "running" }
        },
        time: { created: 3, completed: 4 }
      }
    ]
  };
  const completion = {
    id: "msg_done",
    time: { created: 20 },
    type: "synthetic",
    text: '<subagent sessionID="ses_child" state="completed" description="Read">\nIt says hello\n</subagent>',
    metadata: { source: "subagent", childID: "ses_child", agent: "general", state: "completed" }
  };

  it("ends the turn on a new idle marker only", () => {
    const mapped = mapV2Messages([USER, STEP_ONE, STEP_TWO, IDLE]);
    expect(v2TurnEnded(mapped, new Set(["msg_2"]))).toBe(true);
    expect(v2TurnEnded(mapped, new Set(["msg_2", "msg_5"]))).toBe(false);
    expect(v2TurnEnded(mapV2Messages([USER, STEP_ONE]), new Set())).toBe(false);
  });

  it("keeps a background subagent running until its completion arrives", () => {
    const pending = mapV2Messages([USER, launch, IDLE]);
    expect(v2PendingChildren(pending, new Set(["msg_2"]))).toEqual(["ses_child"]);
    expect(v2TurnEnded(pending, new Set(["msg_2"]))).toBe(false);
    expect(collectTaskParts(pending as LiveMessage[])).toEqual([{ callId: "call_sub", status: "running", childSessionId: "ses_child" }]);
    expect(diffLiveTools(new Map(), pending as LiveMessage[], "t", null).map((e) => e.type)).toEqual(["tool.call"]);

    const resolved = mapV2Messages([USER, launch, IDLE, completion]);
    expect(v2PendingChildren(resolved, new Set(["msg_2"]))).toEqual([]);
    expect(resolved[1].parts?.[0].state).toMatchObject({ status: "completed", output: "It says hello", metadata: { background: true } });
    expect(v2TurnEnded(resolved, new Set(["msg_2"]))).toBe(false);

    const rewoken = mapV2Messages([USER, launch, IDLE, completion, { ...STEP_TWO, id: "msg_6" }, { ...IDLE, id: "msg_7" }]);
    expect(v2TurnEnded(rewoken, new Set(["msg_2"]))).toBe(true);
  });

  it("marks a failed background subagent as an error", () => {
    const failed = { ...completion, metadata: { ...completion.metadata, state: "error" }, text: '<subagent sessionID="ses_child" state="error">\nboom\n</subagent>' };
    const part = mapV2Messages([launch, failed])[0].parts?.[0];
    expect(part?.state).toMatchObject({ status: "error", error: "boom" });
  });

  it("lists the messages of the run after the last idle marker", () => {
    expect(v2RunIds(mapV2Messages([USER, STEP_ONE, STEP_TWO, IDLE, { ...USER, id: "msg_6" }, { ...STEP_ONE, id: "msg_7" }]))).toEqual(["msg_6", "msg_7"]);
    expect(v2RunIds(mapV2Messages([USER, STEP_ONE]))).toEqual(["msg_2", "msg_3"]);
    expect(v2RunIds(mapV2Messages([USER, IDLE]))).toEqual([]);
  });

  it("treats a session whose newest message is not idle as running", () => {
    expect(v2Running(mapV2Messages([USER, STEP_ONE]))).toBe(true);
    expect(v2Running(mapV2Messages([USER, STEP_ONE, STEP_TWO, IDLE]))).toBe(false);
    expect(v2Running([])).toBe(false);
  });
});
