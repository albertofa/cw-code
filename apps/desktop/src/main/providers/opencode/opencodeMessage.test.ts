import { describe, expect, it } from "vitest";
import {
  assistantDeltaOf,
  buildOpencodeMessageBody,
  mimeForOpencodeAttachment,
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

describe("assistantDeltaOf", () => {
  const base = {
    id: "evt_1",
    type: "message.part.delta",
    properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "hel" }
  };

  it("extracts text deltas for our session", () => {
    expect(assistantDeltaOf(base, "ses_1")).toBe("hel");
  });

  it("ignores other sessions, fields, and shapes", () => {
    expect(assistantDeltaOf(base, "ses_2")).toBeNull();
    expect(assistantDeltaOf({ ...base, properties: { ...base.properties, field: "input" } }, "ses_1")).toBeNull();
    expect(assistantDeltaOf({ ...base, properties: { ...base.properties, delta: "" } }, "ses_1")).toBeNull();
    expect(assistantDeltaOf({ id: "e", type: "message.part.delta", data: base.properties }, "ses_1")).toBe("hel");
    expect(assistantDeltaOf({ type: "session.idle" }, "ses_1")).toBeNull();
    expect(assistantDeltaOf(null, "ses_1")).toBeNull();
  });
});
