import { describe, expect, it } from "bun:test";
import { opencodeV1EventDecoder } from "./opencodeV1Events.js";

const decode = (event: unknown) => opencodeV1EventDecoder.decode(event);

describe("opencodeV1EventDecoder", () => {
  const delta = {
    id: "evt_1",
    type: "message.part.delta",
    properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "hel" }
  };

  it("decodes part deltas from properties or data", () => {
    const expected: ReturnType<typeof decode> = [{ kind: "delta", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", text: "hel" }];
    expect(decode(delta)).toEqual(expected);
    expect(decode({ id: "e", type: "message.part.delta", data: delta.properties })).toEqual(expected);
  });

  it("drops empty deltas and unknown shapes", () => {
    expect(decode({ ...delta, properties: { ...delta.properties, delta: "" } })).toEqual([]);
    expect(decode({ ...delta, properties: { ...delta.properties, field: "" } })).toEqual([]);
    expect(decode(null)).toEqual([]);
  });

  it("ends turns on idle and fails them on session errors other than context overflow", () => {
    expect(decode({ type: "session.idle", properties: { sessionID: "ses_1" } })).toEqual([
      { kind: "turn.ended", sessionID: "ses_1", reason: "completed" }
    ]);
    expect(decode({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })).toEqual([
      { kind: "turn.ended", sessionID: "ses_1", reason: "completed" }
    ]);
    expect(decode({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })).toEqual([]);
    expect(
      decode({ type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "boom" } } } })
    ).toEqual([{ kind: "turn.ended", sessionID: "ses_1", reason: "failed", error: "boom" }]);
    expect(
      decode({ type: "session.error", properties: { sessionID: "ses_1", error: { name: "ContextOverflowError", data: { message: "full" } } } })
    ).toEqual([]);
  });

  it("marks compaction messages and records part types", () => {
    expect(
      decode({ type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_c", mode: "compaction", summary: true } } })
    ).toEqual([{ kind: "message.compaction", sessionID: "ses_1", messageID: "msg_c" }]);
    expect(decode({ type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_a" } } })).toEqual([]);
    expect(decode({ type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "prt_r", type: "reasoning" } } })).toEqual([
      { kind: "part.type", sessionID: "ses_1", partID: "prt_r", partType: "reasoning" }
    ]);
  });
});
