// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./appStore.js";

describe("appStore tool.result", () => {
  beforeEach(() => {
    useAppStore.setState({ messagesBySession: {}, busyTurns: {}, pendingApprovals: {}, pendingQuestions: {} });
  });

  it("stores tool usage and preserves the parent tool call id", () => {
    const session = "sess_usage";
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "task",
      input: { prompt: "review" },
      parentToolCallId: "parent_1"
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "done",
      isError: false,
      usage: { tokens: 1200, toolUses: 3, durationMs: 900 }
    });
    const message = useAppStore.getState().messagesBySession[session][0];
    expect(message.toolUsage).toEqual({ tokens: 1200, toolUses: 3, durationMs: 900 });
    expect(message.parentToolCallId).toBe("parent_1");
    expect(message.toolDone).toBe(true);
    expect(message.toolOutput).toBe("done");
  });
});
