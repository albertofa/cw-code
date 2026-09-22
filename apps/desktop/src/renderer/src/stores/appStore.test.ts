// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPOSER, useAppStore } from "./appStore.js";
import { getLastModel, setLastModel } from "../components/lastModel.js";

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

  it("does not duplicate turn.done resultText spanning interim and final assistant messages", () => {
    const session = "sess_result_span";
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "Checking the wiring in theme.css."
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "Read",
      input: { file_path: "theme.css" }
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "ok",
      isError: false
    });
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "Refining the token map."
    });
    useAppStore.getState().applyEvent(session, {
      type: "turn.done",
      turnId: "turn-1",
      sessionId: session,
      resumeCursor: "cursor-1",
      resultText: "Checking the wiring in theme.css.\nRefining the token map.",
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
    expect(texts.join("\n")).toBe("Checking the wiring in theme.css.\nRefining the token map.");
  });

  it("clears the retry notice once the turn resumes with tool activity", () => {
    const session = "sess_retry_resume";
    useAppStore.getState().applyEvent(session, {
      type: "turn.retry",
      turnId: "turn-1",
      attempt: 1,
      message: "Rate limit exceeded. Please retry after a brief wait.",
      retryAt: Date.now() + 2000
    });
    expect(useAppStore.getState().messagesBySession[session].some((m) => m.id === "turn-1-retry")).toBe(true);
    useAppStore.getState().applyEvent(session, {
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_1",
      name: "Edit",
      input: {}
    });
    expect(useAppStore.getState().messagesBySession[session].some((m) => m.id === "turn-1-retry")).toBe(false);
  });

  it("clears the retry notice on assistant progress and re-shows the next retry", () => {
    const session = "sess_retry_progress";
    useAppStore.getState().applyEvent(session, {
      type: "turn.retry",
      turnId: "turn-1",
      attempt: 1,
      message: "Rate limit exceeded.",
      retryAt: 0
    });
    useAppStore.getState().applyEvent(session, {
      type: "assistant.delta",
      turnId: "turn-1",
      text: "resumed"
    });
    expect(useAppStore.getState().messagesBySession[session].some((m) => m.id === "turn-1-retry")).toBe(false);
    useAppStore.getState().applyEvent(session, {
      type: "turn.retry",
      turnId: "turn-1",
      attempt: 2,
      message: "Rate limit exceeded.",
      retryAt: 0
    });
    expect(useAppStore.getState().messagesBySession[session].some((m) => m.id === "turn-1-retry")).toBe(true);
  });
});

describe("appStore pending model per harness", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({
      activeProjectId: "proj_1",
      pendingDriver: "opencode",
      lastDriver: "opencode",
      pendingPrefs: { ...DEFAULT_COMPOSER }
    });
  });

  it("remembers the last model per harness when switching drivers", () => {
    setLastModel("claude", "sonnet");
    useAppStore.setState({ pendingPrefs: { ...DEFAULT_COMPOSER, model: "alpha/m1" } });
    useAppStore.getState().setPendingDriver("claude");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().pendingPrefs.model).toBe("sonnet");
    expect(getLastModel("opencode")).toBe("alpha/m1");
    useAppStore.getState().setPendingDriver("opencode");
    expect(useAppStore.getState().pendingPrefs.model).toBe("alpha/m1");
  });

  it("clears the model when the next harness has no remembered model", () => {
    useAppStore.setState({ pendingPrefs: { ...DEFAULT_COMPOSER, model: "sonnet" } });
    useAppStore.getState().setPendingDriver("codex");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
  });

  it("restores the target harness model when opening a new session", () => {
    setLastModel("opencode", "alpha/m1");
    useAppStore.setState({
      pendingDriver: "claude",
      lastDriver: "claude",
      pendingPrefs: { ...DEFAULT_COMPOSER, model: "sonnet" }
    });
    useAppStore.getState().startNewSession("opencode");
    expect(useAppStore.getState().pendingDriver).toBe("opencode");
    expect(useAppStore.getState().pendingPrefs.model).toBe("alpha/m1");
  });
});
