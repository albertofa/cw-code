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

  it("stores the subagent model reported with the tool result", () => {
    const session = "sess_model";
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "task",
      input: { description: "review" }
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "done",
      isError: false,
      agentId: "agent-1",
      model: "claude-sonnet-4-5"
    });
    const message = useAppStore.getState().messagesBySession[session][0];
    expect(message.subagentModel).toBe("claude-sonnet-4-5");
    expect(message.subagentAgentId).toBe("agent-1");
  });

  it("appends turn.done resultText when streaming deltas missed the final message", () => {
    const session = "sess_result";
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "Confirmed: short status. "
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "Write",
      input: { file_path: "plan.md" }
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "File created",
      isError: false
    });
    useAppStore.getState().applyEvent(session, {
      type: "turn.done",
      turnId: "turn-1",
      sessionId: session,
      resumeCursor: "cursor-1",
      resultText: "I checked both drafts against master. Full plan is in the scratchpad file.",
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    const texts = useAppStore
      .getState()
      .messagesBySession[session].filter((m) => m.role === "assistant")
      .map((m) => m.text);
    expect(texts.join("\n")).toContain("I checked both drafts against master");
  });

  it("does not duplicate turn.done resultText already shown via deltas", () => {
    const session = "sess_result_dup";
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "Done"
    });
    useAppStore.getState().applyEvent(session, {
      type: "turn.done",
      turnId: "turn-1",
      sessionId: session,
      resumeCursor: "cursor-1",
      resultText: "Done",
      inputTokens: 10,
      outputTokens: 4,
      costUsd: 0.01,
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });
    const texts = useAppStore
      .getState()
      .messagesBySession[session].filter((m) => m.role === "assistant")
      .map((m) => m.text);
    expect(texts).toEqual(["Done"]);
  });
});
