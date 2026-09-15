import { describe, expect, it } from "vitest";
import {
  buildOpencodeMessageBody,
  isReasoningPartDelta,
  latestAssistantOf,
  mimeForOpencodeAttachment,
  partDeltaOf,
  runEnded,
  splitOpencodeModel,
  summarizeOpencodeTurn,
  turnMessagesOf
} from "./opencodeMessage.js";

describe("splitOpencodeModel", () => {
  it("splits provider/model ids", () => {
    expect(splitOpencodeModel("anthropic/claude-sonnet-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5"
    });
  });

  it("rejects missing, bare, and trailing-slash ids", () => {
    expect(splitOpencodeModel(undefined)).toBeNull();
    expect(splitOpencodeModel("gpt-5")).toBeNull();
    expect(splitOpencodeModel("anthropic/")).toBeNull();
    expect(splitOpencodeModel("/model")).toBeNull();
  });
});

describe("mimeForOpencodeAttachment", () => {
  it("maps images and common text formats", () => {
    expect(mimeForOpencodeAttachment("shot.PNG")).toBe("image/png");
    expect(mimeForOpencodeAttachment("pic.jpg")).toBe("image/jpeg");
    expect(mimeForOpencodeAttachment("notes.md")).toBe("text/plain");
  });

  it("returns null for unknown extensions", () => {
    expect(mimeForOpencodeAttachment("archive.zip")).toBeNull();
    expect(mimeForOpencodeAttachment("noext")).toBeNull();
  });
});

describe("buildOpencodeMessageBody", () => {
  it("builds a text-only body", () => {
    expect(buildOpencodeMessageBody("hi")).toEqual({ parts: [{ type: "text", text: "hi" }] });
  });

  it("omits empty prompts and carries model, variant, and files", () => {
    expect(
      buildOpencodeMessageBody("  ", {
        model: { providerID: "a", modelID: "b" },
        variant: "high",
        files: [{ mime: "image/png", url: "C:\\p\\a.png" }]
      })
    ).toEqual({
      parts: [{ type: "file", mime: "image/png", url: "C:\\p\\a.png" }],
      model: { providerID: "a", modelID: "b" },
      variant: "high"
    });
  });
});

describe("turnMessagesOf", () => {
  const payload = [
    { info: { id: "msg_1", role: "user", cost: 0 }, parts: [{ type: "text", text: "hi" }] },
    {
      info: {
        id: "msg_2",
        role: "assistant",
        cost: 0.003,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 4 } }
      },
      parts: [{ type: "text", text: "hello" }, { type: "tool", tool: "read" }]
    },
    { info: {}, parts: [] }
  ];

  it("maps assistant usage and text, skips id-less messages", () => {
    expect(turnMessagesOf(payload)).toEqual([
      { id: "msg_1", role: "user", cost: 0, tokens: undefined, text: "hi" },
      {
        id: "msg_2",
        role: "assistant",
        cost: 0.003,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 4 } },
        text: "hello"
      }
    ]);
  });

  it("accepts {data} envelopes and rejects junk", () => {
    expect(turnMessagesOf({ data: payload }).map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
    expect(turnMessagesOf(null)).toEqual([]);
    expect(turnMessagesOf({})).toEqual([]);
  });
});

describe("latestAssistantOf / runEnded", () => {
  const assistant = (id: string, extra: Record<string, unknown> = {}): unknown => ({
    info: { id, role: "assistant", ...extra },
    parts: []
  });

  it("reports the newest assistant message and whether it is terminal", () => {
    expect(latestAssistantOf([assistant("msg_1", { finish: "tool-calls" })])).toEqual({
      id: "msg_1",
      terminal: false
    });
    expect(latestAssistantOf([assistant("msg_1", { finish: "stop" })])).toEqual({ id: "msg_1", terminal: true });
    expect(latestAssistantOf([assistant("msg_1", { error: { name: "MessageAbortedError" } })])).toEqual({
      id: "msg_1",
      terminal: true
    });
    expect(latestAssistantOf([assistant("msg_1", { time: { created: 1, completed: 2 } })])).toEqual({
      id: "msg_1",
      terminal: true
    });
  });

  it("uses the last assistant message and ignores user messages", () => {
    const payload = [
      assistant("msg_1", { finish: "stop" }),
      { info: { id: "msg_2", role: "user" }, parts: [] }
    ];
    expect(latestAssistantOf(payload)).toEqual({ id: "msg_1", terminal: true });
  });

  it("scopes out ids already seen before the turn", () => {
    const payload = [assistant("msg_old", { finish: "stop" }), assistant("msg_new", { finish: "tool-calls" })];
    expect(latestAssistantOf(payload, new Set(["msg_old"]))).toEqual({ id: "msg_new", terminal: false });
    expect(runEnded(payload, new Set(["msg_old"]))).toBe(false);
    expect(runEnded(payload, new Set(["msg_new"]))).toBe(true);
    expect(runEnded(payload)).toBe(false);
    expect(runEnded([], new Set())).toBe(false);
    expect(runEnded(null)).toBe(false);
  });
});

describe("summarizeOpencodeTurn", () => {
  const messages = turnMessagesOf([
    { info: { id: "msg_0", role: "assistant", cost: 1 }, parts: [{ type: "text", text: "old" }] },
    {
      info: { id: "msg_1", role: "assistant", cost: 0.003, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 4 } } },
      parts: [{ type: "text", text: "new" }]
    },
    { info: { id: "msg_2", role: "user" }, parts: [{ type: "text", text: "q" }] }
  ]);

  it("counts only new assistant messages", () => {
    expect(summarizeOpencodeTurn(messages, new Set(["msg_0"]))).toEqual({
      text: "new",
      inputTokens: 114,
      outputTokens: 7,
      costUsd: 0.003
    });
  });

  it("returns zeros when the baseline is unknown", () => {
    expect(summarizeOpencodeTurn(messages, null)).toEqual({ text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});

describe("partDeltaOf", () => {
  const base = {
    id: "evt_1",
    type: "message.part.delta",
    properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "hel" }
  };

  it("extracts deltas for our session with their part and field", () => {
    expect(partDeltaOf(base, "ses_1")).toEqual({ partID: "prt_1", field: "text", text: "hel" });
  });

  it("ignores other sessions, empty deltas, and shapes", () => {
    expect(partDeltaOf(base, "ses_2")).toBeNull();
    expect(partDeltaOf({ ...base, properties: { ...base.properties, delta: "" } }, "ses_1")).toBeNull();
    expect(partDeltaOf({ ...base, properties: { ...base.properties, field: "" } }, "ses_1")).toBeNull();
    expect(partDeltaOf({ id: "e", type: "message.part.delta", data: base.properties }, "ses_1")).toEqual({
      partID: "prt_1",
      field: "text",
      text: "hel"
    });
    expect(partDeltaOf({ type: "session.idle" }, "ses_1")).toBeNull();
    expect(partDeltaOf(null, "ses_1")).toBeNull();
  });
});

describe("isReasoningPartDelta", () => {
  const delta = (field: string): { partID: string; field: string; text: string } => ({
    partID: "prt_1",
    field,
    text: "chunk"
  });

  it("treats a reasoning part's text deltas as reasoning", () => {
    expect(isReasoningPartDelta(delta("text"), "reasoning")).toBe(true);
    expect(isReasoningPartDelta(delta("text"), "text")).toBe(false);
    expect(isReasoningPartDelta(delta("text"), undefined)).toBe(false);
  });

  it("honors an explicit reasoning field even without a known part", () => {
    expect(isReasoningPartDelta(delta("reasoning"), undefined)).toBe(true);
  });
});
