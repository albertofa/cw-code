import { describe, expect, it } from "vitest";
import {
  buildOpencodeMessageBody,
  errorMessageOf,
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

  it("carries providerID and modelID when present", () => {
    const withModel = turnMessagesOf([
      {
        info: { id: "msg_3", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        parts: []
      }
    ]);
    expect(withModel).toEqual([
      {
        id: "msg_3",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        cost: 0,
        tokens: undefined,
        text: ""
      }
    ]);
  });

  it("carries the assistant error message", () => {
    const errored = turnMessagesOf([
      {
        info: { id: "msg_9", role: "assistant", error: { name: "APIError", data: { message: "Free usage exceeded, subscribe to Go" } } },
        parts: []
      }
    ]);
    expect(errored).toEqual([
      {
        id: "msg_9",
        role: "assistant",
        cost: 0,
        tokens: undefined,
        text: "",
        error: "Free usage exceeded, subscribe to Go"
      }
    ]);
  });
});

describe("errorMessageOf", () => {
  it("reads nested data messages and falls back to the error name", () => {
    expect(errorMessageOf({ name: "APIError", data: { message: "rate limited" } })).toBe("rate limited");
    expect(errorMessageOf({ name: "AbortedError" })).toBe("AbortedError");
    expect(errorMessageOf("plain text")).toBe("plain text");
  });

  it("returns an empty string for missing or malformed errors", () => {
    expect(errorMessageOf(undefined)).toBe("");
    expect(errorMessageOf(null)).toBe("");
    expect(errorMessageOf(42)).toBe("");
    expect(errorMessageOf({ data: { message: 42 } })).toBe("");
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
    { info: { id: "msg_0", role: "assistant", cost: 1, providerID: "anthropic", modelID: "claude-sonnet-4-5" }, parts: [{ type: "text", text: "old" }] },
    {
      info: {
        id: "msg_1",
        role: "assistant",
        cost: 0.003,
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 4 } }
      },
      parts: [{ type: "text", text: "new" }]
    },
    { info: { id: "msg_2", role: "user" }, parts: [{ type: "text", text: "q" }] }
  ]);

  it("counts only new assistant messages", () => {
    expect(summarizeOpencodeTurn(messages, new Set(["msg_0"]))).toEqual({
      text: "new",
      usage: [
        {
          model: "anthropic/claude-sonnet-4-5",
          inputTokens: 10,
          cacheReadTokens: 100,
          cacheWriteTokens: 4,
          outputTokens: 7,
          reasoningTokens: 2,
          costUsd: 0.003
        }
      ],
      lastModel: "anthropic/claude-sonnet-4-5",
      lastContextTokens: 121,
      errorText: ""
    });
  });

  it("groups usage by model across messages", () => {
    const twoModels = turnMessagesOf([
      {
        info: { id: "msg_0", role: "assistant", cost: 0.001, providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: []
      },
      {
        info: { id: "msg_1", role: "assistant", cost: 0.002, providerID: "openai", modelID: "gpt-5.2", tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 0, write: 0 } } },
        parts: []
      }
    ]);
    expect(summarizeOpencodeTurn(twoModels, new Set())).toEqual({
      text: "",
      usage: [
        {
          model: "anthropic/claude-sonnet-4-5",
          inputTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
          costUsd: 0.001
        },
        {
          model: "openai/gpt-5.2",
          inputTokens: 6,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 4,
          reasoningTokens: 1,
          costUsd: 0.002
        }
      ],
      lastModel: "openai/gpt-5.2",
      lastContextTokens: 10,
      errorText: ""
    });
  });

  it("returns empty usage when the baseline is unknown", () => {
    expect(summarizeOpencodeTurn(messages, null)).toEqual({
      text: "",
      usage: [],
      lastModel: undefined,
      lastContextTokens: undefined,
      errorText: ""
    });
  });

  it("excludes messages seen before the turn", () => {
    expect(summarizeOpencodeTurn(messages, new Set(["msg_0", "msg_1"]))).toEqual({
      text: "",
      usage: [],
      lastModel: undefined,
      lastContextTokens: undefined,
      errorText: ""
    });
  });

  it("reports the last fresh assistant error without inventing context usage", () => {
    const errored = turnMessagesOf([
      { info: { id: "msg_0", role: "assistant" }, parts: [] },
      { info: { id: "msg_1", role: "assistant", error: { name: "APIError", data: { message: "rate limited" } } }, parts: [] }
    ]);
    expect(summarizeOpencodeTurn(errored, new Set(["msg_0"]))).toEqual({
      text: "",
      usage: [{ model: "unknown", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 }],
      lastModel: undefined,
      lastContextTokens: undefined,
      errorText: "rate limited"
    });
  });

  it("groups messages missing providerID/modelID under model \"unknown\" instead of dropping their tokens", () => {
    const noModel = turnMessagesOf([
      {
        info: { id: "msg_0", role: "assistant", cost: 0.001, tokens: { input: 8, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: []
      }
    ]);
    expect(summarizeOpencodeTurn(noModel, new Set())).toEqual({
      text: "",
      usage: [{ model: "unknown", inputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0, costUsd: 0.001 }],
      lastModel: undefined,
      lastContextTokens: undefined,
      errorText: ""
    });
  });

  it("skips a zeroed-out context message (aborted turn) instead of reporting a fake 0 used", () => {
    const aborted = turnMessagesOf([
      {
        info: {
          id: "msg_0",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          cost: 0.003,
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }
        },
        parts: []
      },
      {
        info: {
          id: "msg_1",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          error: { name: "MessageAbortedError" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        },
        parts: []
      }
    ]);
    const result = summarizeOpencodeTurn(aborted, new Set());
    expect(result.lastModel).toBe("anthropic/claude-sonnet-4-5");
    expect(result.lastContextTokens).toBe(15);
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
