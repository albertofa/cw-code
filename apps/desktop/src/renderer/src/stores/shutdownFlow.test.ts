// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShutdownAssessment, ShutdownPrepareRequest, ShutdownPrepareResult } from "../cw.js";
import { useAppStore } from "./appStore.js";
import { useEditorBuffers } from "./editorBuffers.js";
import {
  hasShutdownBlockers,
  runShutdownFlow,
  shutdownCancel,
  shutdownDiscardAll,
  shutdownForce,
  shutdownProceed,
  shutdownSaveAll,
  shutdownWait
} from "./shutdownFlow.js";

const EMPTY: ShutdownAssessment = { activeTurns: [], backgroundTasks: 0, terminals: [] };
const BUSY: ShutdownAssessment = {
  activeTurns: [{ sessionId: "sess_bg", turnId: "t1", title: "background work", startedAt: 1 }],
  backgroundTasks: 0,
  terminals: []
};

interface FakeShutdownApi {
  assessments: ShutdownAssessment[];
  prepareResults: ShutdownPrepareResult[];
  prepareCalls: ShutdownPrepareRequest[];
  cancelCalls: string[];
  forceCalls: string[];
  saveCalls: Array<{ sessionId: string; path: string; content: string }>;
  failSave: boolean;
}

function installCw(): FakeShutdownApi {
  const api: FakeShutdownApi = {
    assessments: [],
    prepareResults: [],
    prepareCalls: [],
    cancelCalls: [],
    forceCalls: [],
    saveCalls: [],
    failSave: false
  };
  const cw = {
    shutdown: {
      assess: async () => api.assessments.shift() ?? EMPTY,
      prepare: async (request: ShutdownPrepareRequest) => {
        api.prepareCalls.push(request);
        return api.prepareResults.shift() ?? { ok: true, token: "token-1" };
      },
      force: async (token: string) => {
        api.forceCalls.push(token);
        return { ok: true, token };
      },
      cancel: async (token: string) => {
        api.cancelCalls.push(token);
      },
      quit: async () => ({ ok: true }),
      onRequested: () => () => {}
    },
    saveFile: async (sessionId: string, path: string, content: string) => {
      if (api.failSave) throw new Error("disk is read-only");
      api.saveCalls.push({ sessionId, path, content });
    }
  };
  (window as unknown as { cw: unknown }).cw = cw;
  return api;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function dirtyFile(sessionId: string, path: string, content: string): string {
  const key = useEditorBuffers.getState().register(sessionId, path, "saved");
  useEditorBuffers.getState().update(key, content);
  return key;
}

describe("hasShutdownBlockers", () => {
  it("treats active turns, open terminals and dirty files as blockers", () => {
    expect(hasShutdownBlockers(EMPTY, [])).toBe(false);
    expect(hasShutdownBlockers(BUSY, [])).toBe(true);
    expect(hasShutdownBlockers({ ...EMPTY, terminals: [{ ptyId: "p", sessionId: "s", kind: "shell" }] }, [])).toBe(true);
    expect(hasShutdownBlockers(EMPTY, [{ key: "k", sessionId: "s", path: "a", content: "x" }])).toBe(true);
    expect(hasShutdownBlockers({ ...EMPTY, backgroundTasks: 3 }, [])).toBe(false);
  });
});

describe("runShutdownFlow", () => {
  let api: FakeShutdownApi;

  beforeEach(() => {
    api = installCw();
    useAppStore.setState({ shutdown: null, busyTurns: {} });
    useEditorBuffers.setState({ buffers: {} });
  });

  afterEach(async () => {
    await shutdownCancel();
  });

  it("prepares immediately without showing a dialog when nothing blocks", async () => {
    const result = await runShutdownFlow("quit");
    expect(result).toEqual({ token: "token-1" });
    expect(api.prepareCalls).toEqual([{ reason: "quit", stopActiveTurns: false, timeoutMs: 10_000 }]);
    expect(useAppStore.getState().shutdown).toBeNull();
  });

  it("shares one flow between concurrent requests", async () => {
    const first = runShutdownFlow("update");
    const second = runShutdownFlow("quit");
    expect(second).toBe(first);
    await first;
    expect(api.prepareCalls).toHaveLength(1);
  });

  it("asks about a busy background session and stops it only after an explicit decision", async () => {
    api.assessments = [BUSY];
    const pending = runShutdownFlow("update");
    await settle();
    expect(useAppStore.getState().shutdown).toMatchObject({ reason: "update", phase: "review", assessment: BUSY });
    expect(api.prepareCalls).toHaveLength(0);
    await shutdownProceed();
    expect(api.prepareCalls).toEqual([{ reason: "update", stopActiveTurns: true, timeoutMs: 10_000 }]);
    expect(await pending).toEqual({ token: "token-1" });
  });

  it("saves every dirty file before continuing", async () => {
    const a = dirtyFile("sess_a", "a.ts", "A");
    dirtyFile("sess_b", "b.ts", "B");
    const pending = runShutdownFlow("update");
    await settle();
    expect(useAppStore.getState().shutdown?.dirty).toHaveLength(2);
    await shutdownProceed();
    expect(api.prepareCalls).toHaveLength(0);
    await shutdownSaveAll();
    expect(api.saveCalls).toEqual([
      { sessionId: "sess_a", path: "a.ts", content: "A" },
      { sessionId: "sess_b", path: "b.ts", content: "B" }
    ]);
    expect(useEditorBuffers.getState().buffers[a].saved).toBe("A");
    expect(useAppStore.getState().shutdown?.dirty).toEqual([]);
    await shutdownProceed();
    expect(await pending).toEqual({ token: "token-1" });
  });

  it("cancels the whole flow when a save fails and stops nothing", async () => {
    dirtyFile("sess_a", "a.ts", "A");
    api.failSave = true;
    const pending = runShutdownFlow("update");
    await settle();
    await shutdownSaveAll();
    expect(await pending).toBeNull();
    expect(useAppStore.getState().shutdown).toBeNull();
    expect(api.prepareCalls).toHaveLength(0);
    expect(useEditorBuffers.getState().dirty()).toHaveLength(1);
  });

  it("discarding restores saved text and unblocks the flow", async () => {
    const key = dirtyFile("sess_a", "a.ts", "A");
    const pending = runShutdownFlow("quit");
    await settle();
    shutdownDiscardAll();
    expect(useEditorBuffers.getState().buffers[key].content).toBe("saved");
    await shutdownProceed();
    expect(await pending).toEqual({ token: "token-1" });
  });

  it("offers force stop after a timeout and returns the token once forced", async () => {
    api.prepareResults = [{ ok: false, code: "timeout", pending: ["claude"], token: "token-9" }];
    const pending = runShutdownFlow("update");
    await settle();
    expect(useAppStore.getState().shutdown).toMatchObject({ phase: "timeout", pending: ["claude"] });
    await shutdownForce();
    expect(api.forceCalls).toEqual(["token-9"]);
    expect(await pending).toEqual({ token: "token-9" });
  });

  it("cancelling after a timeout restores services and returns to normal use", async () => {
    api.prepareResults = [{ ok: false, code: "timeout", pending: ["codex"], token: "token-7" }];
    const pending = runShutdownFlow("update");
    await settle();
    await shutdownCancel();
    expect(api.cancelCalls).toEqual(["token-7"]);
    expect(await pending).toBeNull();
    expect(useAppStore.getState().shutdown).toBeNull();
  });

  it("waits for running turns and continues on its own once they finish", async () => {
    vi.useFakeTimers();
    try {
      api.assessments = [BUSY, BUSY];
      const pending = runShutdownFlow("update");
      await settle();
      shutdownWait();
      await settle();
      expect(useAppStore.getState().shutdown?.phase).toBe("waiting");
      expect(api.prepareCalls).toHaveLength(0);
      useAppStore.setState({ busyTurns: { sess_bg: "t1" } });
      useAppStore.setState({ busyTurns: {} });
      await settle();
      expect(api.prepareCalls).toEqual([{ reason: "update", stopActiveTurns: false, timeoutMs: 10_000 }]);
      expect(await pending).toEqual({ token: "token-1" });
    } finally {
      vi.useRealTimers();
    }
  });
});
