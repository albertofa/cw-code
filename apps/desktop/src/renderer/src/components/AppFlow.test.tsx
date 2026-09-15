// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, TurnEvent } from "../cw.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TurnCb = (msg: { sessionId: string; event: TurnEvent }) => void;
const listeners = new Map<string, TurnCb[]>();
let sessionSeq = 0;
let modelsForResult: Array<{ id: string; label: string; source: "live"; variants?: string[] }> = [];
let mockDelays = false;

async function delayed<T>(value: T, ms: number): Promise<T> {
  if (mockDelays) await new Promise((r) => setTimeout(r, ms));
  return value;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: "sess_new",
    projectId: "proj_1",
    driver: "opencode",
    title: "New session",
    status: "idle",
    resumeCursor: "",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function installBridge(): void {
  const noop = () => () => {};
  const explicit: Record<string, unknown> = {
    isDev: false,
    checkVersions: async () => [],
    listProjects: async () => [{ id: "proj_1", rootPath: "C:\\proj", name: "proj" }],
    listSessions: async () => [],
    listDiscovered: async () => [],
    createSession: async (projectId: string, driver: "opencode") => {
      sessionSeq += 1;
      const session = makeSession({ id: `sess_${sessionSeq}`, projectId, driver });
      return delayed(session, 1500);
    },
    getHistory: async () => delayed([], 300),
    startTurn: async () => delayed("turn-1", 800),
    activeTurns: async () => [],
    interrupt: async () => {},
    getComposer: async () => delayed({}, 400),
    setComposer: async (_id: string, prefs: unknown) => delayed(prefs, 200),
    getSettings: async () => ({ sourceControlRefreshIntervalSeconds: 30, defaultUseWorktree: true }),
    getGitStatus: async () => {
      throw new Error("no git");
    },
    listGitBranches: async () => [],
    listProjectBranches: async () =>
      delayed([{ name: "main", label: "main", current: true }], 600),
    listModels: async () => [],
    listModelsFor: async () => delayed(modelsForResult, 900),
    listProjectFiles: async () => [],
    onTurnEvent: (cb: TurnCb) => {
      const list = listeners.get("turn") ?? [];
      list.push(cb);
      listeners.set("turn", list);
      return () => {};
    },
    onSessionTitle: noop,
    onWindowMaximized: noop,
    isWindowMaximized: async () => false,
    getTerminalFont: async () => null
  };
  (window as unknown as { cw: Record<string, unknown> }).cw = new Proxy(explicit, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      const name = String(prop);
      if (name.startsWith("on")) return noop;
      if (/^(minimize|toggle|close|zoom|write|resize|kill|interrupt)/.test(name)) return () => {};
      if (name.startsWith("list")) return async () => [];
      return async () => ({});
    }
  });
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (cb: () => void) =>
    setTimeout(cb, 0);
  (globalThis as unknown as { cancelAnimationFrame?: unknown }).cancelAnimationFrame ??= (id: number) =>
    clearTimeout(id);
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
    });
  }
}

async function emitAll(event: TurnEvent): Promise<void> {
  await act(async () => {
    for (const cb of listeners.get("turn") ?? []) {
      cb({ sessionId: emitSessionId, event });
    }
  });
}

let emitSessionId = "";

function fatalErrors(errors: string[]): string[] {
  return errors.filter((e) => e.includes("Maximum update depth") || e.includes("185"));
}

describe("new-session crash repro (interactive)", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let origError!: (...args: unknown[]) => void;
  let errors: string[] = [];
  let pristine: Record<string, unknown> | null = null;

  async function mount(): Promise<typeof import("../stores/appStore.js")> {
    installBridge();
    const { App } = await import("../App.js");
    const store = await import("../stores/appStore.js");
    if (!pristine) {
      pristine = { ...store.useAppStore.getState() };
    } else {
      store.useAppStore.setState({ ...pristine });
    }
    errors = [];
    origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<App />);
    });
    return store;
  }

  afterEach(async () => {
    listeners.clear();
    console.error = origError;
    await act(async () => {
      root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it("opens a new session and starts a turn", async () => {
    const { useAppStore } = await mount();
    expect(host!.innerHTML).toContain("What should we build");

    await act(async () => {
      useAppStore.getState().setPendingDriver("opencode");
    });
    expect(host!.innerHTML).toContain("What should we build");

    await act(async () => {
      await useAppStore.getState().sendPendingPrompt("hello world");
    });
    const createdId = useAppStore.getState().activeSessionId;
    expect(createdId).toMatch(/^sess_/);
    emitSessionId = createdId!;
    await emitAll({ type: "assistant.delta", turnId: "turn-1", text: "hi" });

    expect(host!.innerHTML.length).toBeGreaterThan(1000);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("replays a rich streaming turn", async () => {
    const { useAppStore } = await mount();
    await act(async () => {
      useAppStore.getState().setPendingDriver("opencode");
    });
    await act(async () => {
      await useAppStore.getState().sendPendingPrompt("redesign tool cards @.cw/pastes/x.png");
    });
    emitSessionId = useAppStore.getState().activeSessionId!;

    const md = [
      "# Plan\n\n| Step | Owner |\n|---|---|\n| 1 | app |\n\n```tsx\nconst x = 1;\n```\n",
      "See [docs](https://example.com) and `code` > quote\n\n- a\n- b\n"
    ];
    for (let i = 0; i < 30; i += 1) {
      await emitAll({ type: "assistant.delta", turnId: "turn-1", text: md[i % md.length] });
    }
    const tools: Array<[string, string, unknown]> = [
      ["call_read1", "read", { path: "src/a.ts" }],
      ["call_read2", "read", { path: "src/b.ts" }],
      ["call_grep", "grep", { pattern: "tool-card" }],
      ["call_edit", "edit", { path: "src/a.ts" }],
      ["call_bash", "bash", { command: "pnpm test" }],
      ["call_todo", "todowrite", { todos: [{ status: "completed", content: "do it" }] }]
    ];
    for (const [id, name, input] of tools) {
      await emitAll({ type: "tool.call", turnId: "turn-1", toolCallId: id, name, input });
    }
    await emitAll({ type: "tool.call", turnId: "turn-1", toolCallId: "call_task", name: "task", input: {} });
    await emitAll({
      type: "tool.call",
      turnId: "turn-1",
      toolCallId: "call_sub",
      name: "read",
      input: {},
      parentToolCallId: "call_task"
    });
    for (const [id] of tools) {
      await emitAll({ type: "tool.result", turnId: "turn-1", toolCallId: id, output: "ok output", isError: false });
    }
    await emitAll({
      type: "todo.updated",
      turnId: "turn-1",
      todos: [
        { content: "do it", status: "completed" },
        { content: "hide todo cards", status: "in_progress", priority: "high" }
      ]
    });
    await emitAll({
      type: "question.request",
      turnId: "turn-1",
      request: {
        requestId: "que_1",
        turnId: "turn-1",
        questions: [
          { question: "Group?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowCustom: true }
        ]
      }
    });
    await emitAll({
      type: "approval.request",
      turnId: "turn-1",
      request: {
        requestId: "per_1",
        kind: "command",
        title: "bash: pnpm test",
        decisions: ["accept", "decline"],
        permission: "bash",
        patterns: ["pnpm *"]
      }
    });
    await emitAll({ type: "question.resolved", turnId: "turn-1", requestId: "que_1", answers: { "Group?": "Yes" } });
    await emitAll({ type: "approval.resolved", turnId: "turn-1", requestId: "per_1" });
    await emitAll({
      type: "turn.done",
      turnId: "turn-1",
      sessionId: "sess_new",
      resumeCursor: "ses_x",
      resultText: "Done. See [docs](https://example.com).",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
      numTurns: 1,
      isError: false,
      backgroundTasks: 0
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    const html = host!.innerHTML;
    expect(html).toContain("hide todo cards");
    expect(html).not.toContain("todowrite");
    expect(html).not.toContain('"todos"');
    expect(html.length).toBeGreaterThan(1000);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("interrupts mid-stream turns", async () => {
    const { useAppStore } = await mount();
    const store = () => useAppStore.getState();
    await act(async () => {
      store().setPendingDriver("opencode");
    });
    await act(async () => {
      await store().sendPendingPrompt("first task");
    });
    emitSessionId = store().activeSessionId!;
    expect(emitSessionId).toMatch(/^sess_/);

    for (let i = 0; i < 10; i += 1) {
      await emitAll({ type: "assistant.delta", turnId: "turn-1", text: `chunk ${i} ` });
    }
    await emitAll({ type: "tool.call", turnId: "turn-1", toolCallId: "c1", name: "read", input: { path: "a" } });

    await act(async () => {
      await store().interrupt();
    });
    await emitAll({ type: "question.resolved", turnId: "turn-1", requestId: "q1", answers: null });
    await emitAll({ type: "approval.resolved", turnId: "turn-1", requestId: "p1" });

    await act(async () => {
      await store().sendPrompt("second task", []);
    });
    for (let i = 0; i < 10; i += 1) {
      await emitAll({ type: "assistant.delta", turnId: "turn-1", text: `more ${i} ` });
    }
    await act(async () => {
      await store().interrupt();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(host!.innerHTML.length).toBeGreaterThan(1000);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("streams two sessions concurrently with errors and titles", async () => {
    installBridge();
    const { App } = await import("../App.js");
    const { useAppStore } = await import("../stores/appStore.js");
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(<App />);
      });
      const store = () => useAppStore.getState();

      await act(async () => {
        store().setPendingDriver("opencode");
      });
      await act(async () => {
        await store().sendPendingPrompt("task one");
      });
      const firstId = store().activeSessionId;

      const emit = async (sessionId: string, event: TurnEvent) => {
        await act(async () => {
          for (const cb of listeners.get("turn") ?? []) {
            cb({ sessionId, event });
          }
        });
      };

      await act(async () => {
        store().startNewSession("codex");
      });
      await act(async () => {
        await store().sendPendingPrompt("task two");
      });
      const secondId = store().activeSessionId;
      expect(secondId).not.toBe(firstId);

      for (let i = 0; i < 15; i += 1) {
        await emit(firstId!, { type: "assistant.delta", turnId: "turn-1", text: `a${i} ` });
        await emit(secondId!, { type: "assistant.delta", turnId: "turn-1", text: `b${i} ` });
      }
      await emit(firstId!, { type: "tool.call", turnId: "turn-1", toolCallId: "x1", name: "bash", input: {} });
      await emit(secondId!, {
        type: "turn.error",
        turnId: "turn-1",
        message: "opencode server unreachable at 127.0.0.1:1 (fetch failed)"
      });
      await act(async () => {
        store().applySessionTitle(firstId!, "Fresh title here");
      });
      await emit(firstId!, {
        type: "session.branch.updated",
        turnId: "turn-1",
        sessionId: firstId!,
        branch: "cw/fresh"
      } as TurnEvent);
      await emit(firstId!, {
        type: "turn.done",
        turnId: "turn-1",
        sessionId: firstId!,
        resumeCursor: "ses_y",
        resultText: "done",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        numTurns: 1,
        isError: false,
        backgroundTasks: 0
      });

      await act(async () => {
        store().selectSession(firstId!);
      });
      await act(async () => {
        store().selectSession(secondId!);
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(host!.innerHTML.length).toBeGreaterThan(1000);
      expect(fatalErrors(errors)).toEqual([]);
    } finally {
      console.error = origError;
    }
  });

  it("keeps the newer turn busy when a stale turn.done arrives", async () => {
    const { useAppStore } = await mount();
    useAppStore.setState({ busyTurns: { sess_stale: "turn-new" }, turnStartedAt: { sess_stale: 500 } });
    await act(async () => {
      useAppStore.getState().applyEvent("sess_stale", {
        type: "turn.done",
        turnId: "turn-old",
        sessionId: "sess_stale",
        resumeCursor: "",
        resultText: "done",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        numTurns: 1,
        isError: false,
        backgroundTasks: 0
      });
    });
    expect(useAppStore.getState().busyTurns["sess_stale"]).toBe("turn-new");
    expect(useAppStore.getState().turnStartedAt["sess_stale"]).toBe(500);
  });

  it("rehydrates a running turn from main on session select", async () => {
    const { useAppStore } = await mount();
    const bridge = (window as unknown as { cw: Record<string, unknown> }).cw;
    bridge.activeTurns = async () => [{ sessionId: "sess_hist", turnId: "turn-live", startedAt: 1234 }];
    useAppStore.setState({
      activeProjectId: "proj_1",
      sessionsByProject: { proj_1: [makeSession({ id: "sess_hist", status: "working" })] }
    });
    await act(async () => {
      useAppStore.getState().selectSession("sess_hist");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useAppStore.getState().busyTurns["sess_hist"]).toBe("turn-live");
    expect(useAppStore.getState().turnStartedAt["sess_hist"]).toBe(1234);
  });

  it("does not resurrect an errored turn from a stale activeTurns reply", async () => {
    const { useAppStore } = await mount();
    const bridge = (window as unknown as { cw: Record<string, unknown> }).cw;
    bridge.activeTurns = async () => [{ sessionId: "sess_err", turnId: "turn-dead", startedAt: 10 }];
    useAppStore.setState({ busyTurns: { sess_err: "turn-dead" }, turnStartedAt: { sess_err: 10 } });
    await act(async () => {
      useAppStore.getState().applyEvent("sess_err", {
        type: "turn.error",
        turnId: "turn-dead",
        message: "boom"
      });
    });
    await act(async () => {
      await useAppStore.getState().hydrateActiveTurns();
    });
    expect(useAppStore.getState().busyTurns["sess_err"]).toBeUndefined();
    expect(useAppStore.getState().turnStartedAt["sess_err"]).toBeUndefined();
  });

  it("settles model effort fallback on the new-session form", async () => {
    modelsForResult = [{ id: "model-x", label: "X", source: "live", variants: ["balanced"] }];
    const { App } = await import("../App.js");
    const { useAppStore, DEFAULT_COMPOSER } = await import("../stores/appStore.js");
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      installBridge();
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(<App />);
      });
      await act(async () => {
        useAppStore.setState({
          pendingDriver: "opencode",
          pendingPrefs: { ...DEFAULT_COMPOSER, model: "model-x", effort: "max" }
        });
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(useAppStore.getState().pendingPrefs.effort).toBe("medium");
      expect(host!.innerHTML).toContain("What should we build");
      expect(fatalErrors(errors)).toEqual([]);
    } finally {
      console.error = origError;
      modelsForResult = [];
    }
  });

  it("stores todo.updated events per session", async () => {
    const { useAppStore } = await mount();
    emitSessionId = "sess_todos";
    await emitAll({
      type: "todo.updated",
      turnId: "turn-1",
      todos: [{ content: "write tests", status: "in_progress", priority: "high" }]
    });
    expect(useAppStore.getState().todosBySession["sess_todos"]).toEqual([
      { content: "write tests", status: "in_progress", priority: "high" }
    ]);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("seeds todos from history when no live update arrived", async () => {
    const { useAppStore } = await mount();
    const bridge = (window as unknown as { cw: Record<string, unknown> }).cw;
    bridge.getHistory = async () => [
      {
        id: "m1",
        role: "tool",
        text: "todowrite",
        turnId: "turn-1",
        todos: [{ content: "do it", status: "completed" }]
      }
    ];
    await act(async () => {
      await useAppStore.getState().ensureHistory("sess_hist");
    });
    expect(useAppStore.getState().todosBySession["sess_hist"]).toEqual([
      { content: "do it", status: "completed" }
    ]);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("keeps live todos over history seeding", async () => {
    const { useAppStore } = await mount();
    emitSessionId = "sess_live";
    await emitAll({
      type: "todo.updated",
      turnId: "turn-1",
      todos: [{ content: "live", status: "pending" }]
    });
    const bridge = (window as unknown as { cw: Record<string, unknown> }).cw;
    bridge.getHistory = async () => [
      {
        id: "m1",
        role: "tool",
        text: "todowrite",
        turnId: "turn-0",
        todos: [{ content: "stale", status: "completed" }]
      }
    ];
    await act(async () => {
      await useAppStore.getState().ensureHistory("sess_live");
    });
    expect(useAppStore.getState().todosBySession["sess_live"]).toEqual([
      { content: "live", status: "pending" }
    ]);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("seeds the last todos from history", async () => {
    const { useAppStore } = await mount();
    const bridge = (window as unknown as { cw: Record<string, unknown> }).cw;
    bridge.getHistory = async () => [
      {
        id: "m1",
        role: "tool",
        text: "todowrite",
        turnId: "turn-1",
        todos: [{ content: "first", status: "completed" }]
      },
      {
        id: "m2",
        role: "tool",
        text: "todowrite",
        turnId: "turn-1",
        todos: [{ content: "second", status: "in_progress" }]
      }
    ];
    await act(async () => {
      await useAppStore.getState().ensureHistory("sess_last_todos");
    });
    expect(useAppStore.getState().todosBySession["sess_last_todos"]).toEqual([
      { content: "second", status: "in_progress" }
    ]);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("seeds an explicit empty todo list from history", async () => {
    const { useAppStore } = await mount();
    const bridge = (window as unknown as { cw: Record<string, unknown> }).cw;
    bridge.getHistory = async () => [
      { id: "m1", role: "tool", text: "todowrite", turnId: "turn-1", todos: [] }
    ];
    await act(async () => {
      await useAppStore.getState().ensureHistory("sess_empty_todos");
    });
    expect(useAppStore.getState().todosBySession["sess_empty_todos"]).toEqual([]);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("submits a new session with production-like IPC latency", async () => {
    mockDelays = true;
    const { App } = await import("../App.js");
    const { useAppStore } = await import("../stores/appStore.js");
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      installBridge();
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(<App />);
      });
      expect(host!.innerHTML).toContain("What should we build");

      await act(async () => {
        useAppStore.getState().setPendingDriver("opencode");
      });
      await act(async () => {
        await useAppStore.getState().sendPendingPrompt("wire up the new flow with an image @.cw/pastes/x.png");
      });
      const createdId = useAppStore.getState().activeSessionId;
      expect(createdId).toMatch(/^sess_/);
      emitSessionId = createdId!;
      await emitAll({ type: "assistant.delta", turnId: "turn-1", text: "working on it" });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 2500));
      });
      expect(host!.innerHTML.length).toBeGreaterThan(1000);
      expect(fatalErrors(errors)).toEqual([]);
    } finally {
      console.error = origError;
      mockDelays = false;
    }
  });
});
