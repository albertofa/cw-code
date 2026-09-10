import { describe, expect, it } from "vitest";
import { parseOpencodeLine, summarizeRun } from "./opencodeEvents.js";

function freshAcc() {
  return { text: [] as string[], usage: { input: 0, output: 0, reasoning: 0 }, cost: 0, sessionId: "" };
}

describe("parseOpencodeLine", () => {
  it("maps text events to assistant.delta and captures session id", () => {
    const acc = freshAcc();
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "text",
        sessionID: "ses_1",
        part: { type: "text", text: "ok" }
      }),
      "t1",
      acc
    );
    expect(events).toEqual([{ type: "assistant.delta", turnId: "t1", text: "ok" }]);
    expect(acc.sessionId).toBe("ses_1");
  });

  it("accumulates usage from step_finish", () => {
    const acc = freshAcc();
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        part: {
          type: "step-finish",
          reason: "stop",
          tokens: { total: 9125, input: 8718, output: 11, reasoning: 155 },
          cost: 0
        }
      }),
      "t1",
      acc
    );
    expect(events).toEqual([]);
    expect(acc.usage).toEqual({ input: 8718, output: 11, reasoning: 155 });
  });

  it("maps error events to turn.error", () => {
    const events = parseOpencodeLine(
      JSON.stringify({ type: "error", sessionID: "ses_1", error: { name: "APIError" } }),
      "t1",
      freshAcc()
    );
    expect(events[0]?.type).toBe("turn.error");
  });

  it("summarizes a run into turn.done", () => {
    const acc = { text: ["ok"], usage: { input: 8718, output: 11, reasoning: 155 }, cost: 0, sessionId: "ses_1" };
    expect(summarizeRun("t1", "local-1", acc)).toEqual({
      type: "turn.done",
      turnId: "t1",
      sessionId: "local-1",
      resumeCursor: "ses_1",
      resultText: "ok",
      inputTokens: 8718,
      outputTokens: 11,
      costUsd: 0,
      numTurns: 1,
      isError: false
    });
  });
});
