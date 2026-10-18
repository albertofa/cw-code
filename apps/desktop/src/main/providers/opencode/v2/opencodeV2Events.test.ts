import { describe, expect, it } from "vitest";
import { OpencodeV2EventDecoder } from "./opencodeV2Events.js";

const SID = "ses_root";

function event(type: string, data: Record<string, unknown>): unknown {
  return { id: "evt_1", created: 1, type, location: { directory: "C:\\p" }, data };
}

describe("OpencodeV2EventDecoder", () => {
  it("turns text and reasoning deltas into typed deltas", () => {
    const decoder = new OpencodeV2EventDecoder();
    expect(decoder.decode(event("session.text.delta", { sessionID: SID, assistantMessageID: "msg_a", ordinal: 0, delta: "DONE" }))).toEqual([
      { kind: "delta", sessionID: SID, messageID: "msg_a", partID: "msg_a:0:text", field: "text", text: "DONE" }
    ]);
    expect(decoder.decode(event("session.reasoning.delta", { sessionID: SID, assistantMessageID: "msg_a", ordinal: 1, delta: "hm" }))).toEqual([
      { kind: "delta", sessionID: SID, messageID: "msg_a", partID: "msg_a:1:reasoning", field: "reasoning", text: "hm" }
    ]);
  });

  it("correlates the tool name from input.started with later call events", () => {
    const decoder = new OpencodeV2EventDecoder();
    const base = { sessionID: SID, assistantMessageID: "msg_a", id: "call_1" };
    expect(decoder.decode(event("session.tool.input.started", { ...base, name: "read" }))).toEqual([
      { kind: "tool", tool: { sessionID: SID, messageID: "msg_a", callId: "call_1", name: "read", status: "pending" } }
    ]);
    expect(decoder.decode(event("session.tool.called", { ...base, input: { path: "README.md" }, executed: false }))).toEqual([
      { kind: "tool", tool: { sessionID: SID, messageID: "msg_a", callId: "call_1", name: "read", status: "running", input: { path: "README.md" } } }
    ]);
    expect(
      decoder.decode(event("session.tool.success", { ...base, content: [{ type: "text", text: "1: hello" }], metadata: { truncated: false }, executed: false }))
    ).toEqual([
      {
        kind: "tool",
        tool: { sessionID: SID, messageID: "msg_a", callId: "call_1", name: "read", status: "completed", output: "1: hello", metadata: { truncated: false } }
      }
    ]);
    expect(decoder.decode(event("session.tool.failed", { ...base, error: { type: "tool.execution", message: "no such file" }, executed: false }))).toEqual([
      { kind: "tool", tool: { sessionID: SID, messageID: "msg_a", callId: "call_1", name: "read", status: "error", output: "no such file" } }
    ]);
  });

  it("keeps a background subagent running after its launch succeeds", () => {
    const decoder = new OpencodeV2EventDecoder();
    const base = { sessionID: SID, assistantMessageID: "msg_a", id: "call_sub" };
    decoder.decode(event("session.tool.input.started", { ...base, name: "subagent" }));
    const [launched] = decoder.decode(
      event("session.tool.success", { ...base, content: [{ type: "text", text: "working in the background" }], metadata: { sessionID: "ses_child", status: "running" } })
    );
    expect(launched).toEqual({
      kind: "tool",
      tool: { sessionID: SID, messageID: "msg_a", callId: "call_sub", name: "subagent", status: "running", metadata: { sessionID: "ses_child", status: "running" } }
    });
  });

  it("maps the execution lifecycle to turn ends", () => {
    const decoder = new OpencodeV2EventDecoder();
    expect(decoder.decode(event("session.execution.succeeded", { sessionID: SID }))).toEqual([{ kind: "turn.ended", sessionID: SID, reason: "completed" }]);
    expect(decoder.decode(event("session.execution.failed", { sessionID: SID, error: { type: "provider.auth", message: "bad key" } }))).toEqual([
      { kind: "turn.ended", sessionID: SID, reason: "failed", error: "bad key" }
    ]);
    expect(decoder.decode(event("session.execution.interrupted", { sessionID: SID, reason: "user" }))).toEqual([
      { kind: "turn.ended", sessionID: SID, reason: "interrupted" }
    ]);
    expect(decoder.decode(event("session.execution.started", { sessionID: SID }))).toEqual([]);
  });

  it("maps retries, child sessions, permissions and question forms", () => {
    const decoder = new OpencodeV2EventDecoder();
    expect(
      decoder.decode(event("session.retry.scheduled", { sessionID: SID, assistantMessageID: "msg_a", attempt: 2, at: 1234, error: { type: "provider.rate-limit", message: "slow down" } }))
    ).toEqual([{ kind: "retry", retry: { sessionID: SID, attempt: 2, message: "slow down", retryAt: 1234 } }]);
    expect(decoder.decode(event("session.created", { sessionID: "ses_child", parentID: SID, slug: "x", version: "2.0.32" }))).toEqual([
      { kind: "session.parent", sessionID: "ses_child", parentID: SID }
    ]);
    expect(decoder.decode(event("session.created", { sessionID: SID, slug: "x", version: "2.0.32" }))).toEqual([]);
    expect(
      decoder.decode(
        event("permission.asked", {
          id: "per_1",
          sessionID: SID,
          action: "shell",
          resources: ["echo hi"],
          save: ["echo *"],
          source: { type: "tool", messageID: "msg_a", id: "call_1" }
        })
      )
    ).toEqual([
      {
        kind: "permission.asked",
        permission: expect.objectContaining({ requestId: "per_1", sessionID: SID, permission: "shell", patterns: ["echo hi"], always: ["echo *"] })
      }
    ]);
    expect(decoder.decode(event("permission.replied", { sessionID: SID, requestID: "per_1", reply: "once" }))).toEqual([
      { kind: "permission.replied", requestId: "per_1" }
    ]);
    const [asked] = decoder.decode(
      event("form.created", {
        form: {
          id: "frm_1",
          sessionID: SID,
          title: "Questions",
          metadata: { kind: "question", tool: { messageID: "msg_a", id: "call_q" } },
          fields: [
            {
              key: "q0",
              title: "Color",
              description: "Which color do you prefer?",
              type: "string",
              options: [{ value: "Red", label: "Red" }, { value: "Blue", label: "Blue", description: "Calm" }],
              custom: true
            }
          ]
        }
      })
    );
    expect(asked).toEqual({
      kind: "question.asked",
      question: {
        requestId: "frm_1",
        sessionID: SID,
        questions: [
          {
            question: "Which color do you prefer?",
            header: "Color",
            options: [{ label: "Red" }, { label: "Blue", description: "Calm" }],
            multiSelect: false,
            allowCustom: true
          }
        ],
        fields: [{ key: "q0", type: "string" }]
      }
    });
    expect(decoder.decode(event("form.replied", { id: "frm_1", sessionID: SID, answer: { q0: "Red" } }))).toEqual([
      { kind: "question.resolved", requestId: "frm_1" }
    ]);
    expect(decoder.decode(event("form.cancelled", { id: "frm_1", sessionID: SID }))).toEqual([{ kind: "question.resolved", requestId: "frm_1" }]);
  });

  it("ignores v1-shaped and unknown events", () => {
    const decoder = new OpencodeV2EventDecoder();
    expect(decoder.decode({ type: "session.idle", properties: { sessionID: SID } })).toEqual([]);
    expect(decoder.decode(event("server.connected", {}))).toEqual([]);
    expect(decoder.decode(null)).toEqual([]);
  });
});
