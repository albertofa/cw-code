// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { UpdateActionResult, UpdateState } from "@cw-code/contracts";
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

  it("updates a result-only row when a later task notification has details", () => {
    const session = "sess_task_failure";
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "Subagent failed",
      isError: true
    });
    useAppStore.getState().applyEvent(session, {
      type: "tool.result",
      turnId: "turn-1",
      toolCallId: "call_1",
      output: "Permission denied reading C:/secret.txt",
      isError: true,
      usage: { tokens: 1200 }
    });

    expect(useAppStore.getState().messagesBySession[session]).toEqual([
      expect.objectContaining({
        id: "call_1-r",
        text: "Permission denied reading C:/secret.txt",
        toolUsage: { tokens: 1200 },
        isError: true
      })
    ]);
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
      usage: [],
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
      usage: [],
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
      usage: [],
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

describe("appStore applySession", () => {
  it("replaces the stored session so removed keys disappear", () => {
    const base = {
      id: "sess_apply",
      projectId: "proj_apply",
      driver: "claude" as const,
      title: "Linked",
      status: "idle" as const,
      resumeCursor: "",
      createdAt: 1,
      updatedAt: 1
    };
    const other = { ...base, id: "sess_other" };
    const prs = [{ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 }, origin: "opened" as const, lastSeenSha: "a", lastSeenAt: 1 }];
    useAppStore.setState({ sessionsByProject: { proj_apply: [{ ...base, prs }, other] } });
    useAppStore.getState().applySession({ ...base, updatedAt: 2 });
    const [updated, untouched] = useAppStore.getState().sessionsByProject.proj_apply;
    expect(updated).toEqual({ ...base, updatedAt: 2 });
    expect("prs" in updated).toBe(false);
    expect(untouched).toBe(other);
  });

  it("keeps the renderer's status while a turn is busy for that session", () => {
    const base = {
      id: "sess_busy",
      projectId: "proj_busy",
      driver: "claude" as const,
      title: "Busy",
      status: "working" as const,
      resumeCursor: "",
      createdAt: 1,
      updatedAt: 1
    };
    useAppStore.setState({ sessionsByProject: { proj_busy: [base] }, busyTurns: { sess_busy: "turn_1" } });
    useAppStore.getState().applySession({ ...base, status: "idle", title: "Renamed", updatedAt: 2 });
    expect(useAppStore.getState().sessionsByProject.proj_busy[0]).toEqual({ ...base, title: "Renamed", updatedAt: 2 });

    useAppStore.setState({ busyTurns: {} });
    useAppStore.getState().applySession({ ...base, status: "idle", updatedAt: 3 });
    expect(useAppStore.getState().sessionsByProject.proj_busy[0].status).toBe("idle");
  });
});

describe("appStore context.compacted", () => {
  beforeEach(() => {
    useAppStore.setState({ messagesBySession: {}, turnUsageBySession: {} });
  });

  it("adds a compaction marker and updates the context ring", () => {
    const session = "sess_compact";
    useAppStore.getState().applyEvent(session, {
      type: "context.compacted",
      turnId: "turn-1",
      compaction: { trigger: "manual", preTokens: 633409, postTokens: 16048, droppedTokens: 617361 },
      context: { usedTokens: 16048, windowTokens: 200000 }
    });
    expect(useAppStore.getState().messagesBySession[session]).toEqual([
      {
        id: "turn-1-compaction",
        role: "system",
        text: "Context compacted",
        turnId: "turn-1",
        compaction: { trigger: "manual", preTokens: 633409, postTokens: 16048, droppedTokens: 617361 }
      }
    ]);
    expect(useAppStore.getState().turnUsageBySession[session]?.context).toEqual({
      usedTokens: 16048,
      windowTokens: 200000
    });
  });

  it("dedupes repeated markers and preserves the previous last-turn totals", () => {
    const session = "sess_compact_dedupe";
    useAppStore.setState({
      turnUsageBySession: {
        [session]: {
          lastTurn: {
            inputTokens: 1,
            cacheReadTokens: 2,
            cacheWriteTokens: 3,
            outputTokens: 4,
            reasoningTokens: 5,
            costUsd: 0.1
          }
        }
      }
    });
    for (let i = 0; i < 2; i += 1) {
      useAppStore.getState().applyEvent(session, {
        type: "context.compacted",
        turnId: "turn-1",
        compaction: { trigger: "auto" },
        context: { usedTokens: 100, windowTokens: 200000 }
      });
    }
    expect(useAppStore.getState().messagesBySession[session]).toHaveLength(1);
    expect(useAppStore.getState().turnUsageBySession[session]?.lastTurn.costUsd).toBe(0.1);
    expect(useAppStore.getState().turnUsageBySession[session]?.context).toEqual({
      usedTokens: 100,
      windowTokens: 200000
    });
  });
});

describe("appStore preview per session", () => {
  beforeEach(() => {
    useAppStore.setState({ previewBySession: {} });
  });

  it("keeps preview targets independent and closes only the requested session", () => {
    useAppStore.getState().openPreview("sess_a", "src/a.ts", "C:\\a");
    useAppStore.getState().openPreview("sess_b", "src/b.ts", "C:\\b");
    const previews = useAppStore.getState().previewBySession;
    expect(previews.sess_a.path).toBe("src/a.ts");
    expect(previews.sess_b.path).toBe("src/b.ts");

    useAppStore.getState().closePreview("sess_a");
    const remaining = useAppStore.getState().previewBySession;
    expect(remaining.sess_a).toBeUndefined();
    expect(remaining.sess_b.path).toBe("src/b.ts");
  });
});

describe("appStore updates slice", () => {
  function updateState(seq: number, phase: UpdateState["phase"] = "idle"): UpdateState {
    return {
      seq,
      phase,
      runningVersion: "1.0.0",
      channel: "stable",
      availableVersion: null,
      downloadedVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      progress: null,
      checkedAt: null,
      error: null,
      disabledReason: null,
      autoDownload: false
    };
  }

  function installUpdatesBridge(snapshot: Promise<UpdateState>, result?: UpdateActionResult) {
    const calls: string[] = [];
    let emit: (state: UpdateState) => void = () => {};
    const updates = {
      onChanged: (cb: (state: UpdateState) => void) => {
        calls.push("onChanged");
        emit = cb;
        return () => calls.push("off");
      },
      getState: () => {
        calls.push("getState");
        return snapshot;
      },
      check: async () => result,
      download: async () => result,
      setChannel: async () => result
    };
    (window as unknown as { cw: { updates: typeof updates } }).cw = { updates };
    return { calls, emit: (state: UpdateState) => emit(state) };
  }

  beforeEach(() => {
    useAppStore.setState({ updates: null });
  });

  it("subscribes before fetching the snapshot and keeps the newest state", async () => {
    let resolveSnapshot: (state: UpdateState) => void = () => {};
    const bridge = installUpdatesBridge(new Promise((resolve) => (resolveSnapshot = resolve)));
    const off = useAppStore.getState().subscribeUpdates();
    expect(bridge.calls).toEqual(["onChanged", "getState"]);
    bridge.emit(updateState(3, "checking"));
    resolveSnapshot(updateState(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().updates).toMatchObject({ seq: 3, phase: "checking" });
    bridge.emit(updateState(1, "up-to-date"));
    expect(useAppStore.getState().updates?.seq).toBe(3);
    bridge.emit(updateState(4, "available"));
    expect(useAppStore.getState().updates).toMatchObject({ seq: 4, phase: "available" });
    off();
    expect(bridge.calls).toContain("off");
  });

  it("applies the state carried by action results through the same ordering rule", async () => {
    installUpdatesBridge(Promise.resolve(updateState(0)), {
      ok: false,
      code: "busy",
      message: "An update is downloading",
      state: updateState(7, "downloading")
    });
    useAppStore.getState().applyUpdateState(updateState(9, "ready"));
    const result = await useAppStore.getState().checkForUpdates();
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(useAppStore.getState().updates).toMatchObject({ seq: 9, phase: "ready" });
  });
});
