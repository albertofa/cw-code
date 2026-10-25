import "../../../../tests/dom.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ThreadItem } from "@cw-code/contracts";
import { DEFAULT_APPEARANCE } from "../appearanceFonts.js";
import { installFakeTopics, type FakeTopics } from "../../../../tests/fakeTopics.js";
import type { Session } from "../cw.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let sessionSeq = 0;
let itemSeq = 0;
let modelsForResult: Array<{ id: string; label: string; source: "live"; variants?: string[] }> = [];
let mockDelays = false;
let topics!: FakeTopics;
const startedTurns: string[] = [];
const stoppedTurns: string[] = [];

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

function addSidebarSession(session: Session): void {
  const row = {
    session,
    busy: false,
    branch: null,
    attention: null,
    babysit: null,
    prBadge: null,
    pendingQuestionIds: [],
    latestUnseenPrUpdateAt: null,
    prMuted: false
  };
  topics.merge("sidebar", { [`row/${session.id}`]: row });
}

const RUNNING_TURN = { phase: "running", turnId: "turn-1", startedAt: Date.now(), auto: false };
const LOADED_HISTORY = { state: "loaded", error: null, retrying: false };

function threadTopic(sessionId: string): string {
  return `session/${sessionId}`;
}

function threadItem(fields: Omit<ThreadItem, "seq">): Record<string, ThreadItem> {
  itemSeq += 1;
  return { [`item/${fields.id}`]: { ...fields, seq: itemSeq } };
}

function currentItem(sessionId: string, id: string): ThreadItem | undefined {
  return topics.data(threadTopic(sessionId))?.[`item/${id}`] as ThreadItem | undefined;
}

async function publishThread(sessionId: string, data: Record<string, unknown>): Promise<void> {
  await act(async () => {
    topics.merge(threadTopic(sessionId), data);
  });
}

async function startThread(sessionId: string, prompt: string): Promise<void> {
  await publishThread(sessionId, {
    history: LOADED_HISTORY,
    turn: RUNNING_TURN,
    ...threadItem({ id: "turn-1-u", role: "user", text: prompt, turnId: "turn-1" })
  });
}

async function appendAssistant(sessionId: string, text: string): Promise<void> {
  const id = "turn-1-a";
  const current = currentItem(sessionId, id);
  await publishThread(
    sessionId,
    current ? { [`item/${id}`]: { ...current, text: current.text + text } } : threadItem({ id, role: "assistant", text, turnId: "turn-1" })
  );
}

async function finishTool(sessionId: string, id: string, output: string): Promise<void> {
  const current = currentItem(sessionId, id);
  if (!current) throw new Error(`no tool item ${id}`);
  await publishThread(sessionId, { [`item/${id}`]: { ...current, toolOutput: output, toolDone: true, toolCompletedAt: Date.now() } });
}

function installTopics(): void {
  topics = installFakeTopics({
    app: {
      settings: { ...DEFAULT_APPEARANCE, sourceControlRefreshIntervalSeconds: 30, prRefreshIntervalSeconds: 120, defaultUseWorktree: true },
      home: { homeDir: "C:\\Users\\test" },
      harnesses: { checks: [], installed: [], issues: [], checkedAt: null, trigger: "startup", error: null }
    },
    sidebar: {
      layout: { needsYou: [], workingSet: [], main: [], resolved: [], quickCounts: { pr: 0, prAttention: 0 } },
      defaults: { restoreSessionId: null, restoreProjectId: "proj_1", projectsByRecency: ["proj_1"] },
      "project/proj_1": { id: "proj_1", rootPath: "C:\\proj", name: "proj" },
      "worktrees/proj_1": []
    }
  });
}

function installBridge(): void {
  installTopics();
  startedTurns.length = 0;
  stoppedTurns.length = 0;
  const noop = () => () => {};
  const explicit: Record<string, unknown> = {
    isDev: false,
    createSession: async (projectId: string, driver: "opencode") => {
      sessionSeq += 1;
      const session = makeSession({ id: `sess_${sessionSeq}`, projectId, driver });
      const created = await delayed(session, 1500);
      setTimeout(() => addSidebarSession(created), 0);
      return created;
    },
    startTurn: async (sessionId: string) => {
      startedTurns.push(sessionId);
      return delayed("turn-1", 800);
    },
    stopTurn: async (sessionId: string) => {
      stoppedTurns.push(sessionId);
      return { stopped: true };
    },
    reloadHistory: async () => {},
    updates: {
      onChanged: noop,
      getState: async () => ({ seq: 0, phase: "disabled", disabledReason: "Updates are disabled in development builds" })
    },
    getComposer: async () => delayed({}, 400),
    setComposer: async (_id: string, prefs: unknown) => delayed(prefs, 200),
    getDefaultPrWorkflows: async () => [],
    refreshPrInbox: async () => {},
    refreshGitHubView: async () => {},
    githubViewCounts: async () => ({}),
    markSessionRunSeen: async (sessionId: string) => makeSession({ id: sessionId }),
    refreshGit: async () => {},
    checkBranchMismatch: async () => null,
    keepFolderHead: async () => null,
    listGitBranches: async () => [],
    listProjectBranches: async () =>
      delayed([{ name: "main", label: "main", current: true }], 600),
    listModels: async () => [],
    listModelsFor: async () => delayed(modelsForResult, 900),
    listProjectFiles: async () => [],
    onSessionTitle: noop,
    topics: { acquire: () => () => {} },
    shutdown: { onRequested: noop, onExpired: noop },
    onWindowMaximized: noop,
    isWindowMaximized: async () => false
  };
  (window as unknown as { cw: Record<string, unknown> }).cw = new Proxy(explicit, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      const name = String(prop);
      if (name.startsWith("on")) return noop;
      if (/^(minimize|toggle|close|zoom|write|resize|kill)/.test(name)) return () => {};
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
    expect(startedTurns).toEqual([createdId!]);
    expect(topics.acquired()).toContain(threadTopic(createdId!));
    await startThread(createdId!, "hello world");
    await appendAssistant(createdId!, "hi there");

    expect(host!.innerHTML).toContain("hi there");
    expect(host!.innerHTML.length).toBeGreaterThan(1000);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("shows only the current harness terminal tab", async () => {
    const { useAppStore } = await mount();
    await act(async () => {
      useAppStore.getState().setPendingDriver("opencode");
    });
    expect(host!.innerHTML).toContain("OpenCode CLI");
    expect(host!.innerHTML).not.toContain("Claude CLI");
    expect(host!.innerHTML).not.toContain("Codex CLI");

    await act(async () => {
      useAppStore.getState().setPendingDriver("codex");
    });
    expect(host!.innerHTML).toContain("Codex CLI");
    expect(host!.innerHTML).not.toContain("OpenCode CLI");
    expect(host!.innerHTML).not.toContain("Claude CLI");
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("renders a rich streaming turn from the session topic", async () => {
    const { useAppStore } = await mount();
    await act(async () => {
      useAppStore.getState().setPendingDriver("opencode");
    });
    await act(async () => {
      await useAppStore.getState().sendPendingPrompt("redesign tool cards @.cw/pastes/x.png");
    });
    const sessionId = useAppStore.getState().activeSessionId!;
    await startThread(sessionId, "redesign tool cards @.cw/pastes/x.png");

    const md = [
      "# Plan\n\n| Step | Owner |\n|---|---|\n| 1 | app |\n\n```tsx\nconst x = 1;\n```\n",
      "See [docs](https://example.com) and `code` > quote\n\n- a\n- b\n"
    ];
    for (let i = 0; i < 30; i += 1) {
      await appendAssistant(sessionId, md[i % md.length]);
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
      await publishThread(sessionId, threadItem({ id, role: "tool", text: name, turnId: "turn-1", toolName: name, toolInput: input, toolStartedAt: Date.now() }));
    }
    await publishThread(sessionId, threadItem({ id: "call_task", role: "tool", text: "task", turnId: "turn-1", toolName: "task", toolInput: {}, toolStartedAt: Date.now() }));
    await publishThread(
      sessionId,
      threadItem({ id: "call_sub", role: "tool", text: "read", turnId: "turn-1", toolName: "read", toolInput: {}, parentToolCallId: "call_task", toolStartedAt: Date.now() })
    );
    for (const [id] of tools) await finishTool(sessionId, id, "ok output");
    await publishThread(sessionId, {
      todos: [
        { content: "do it", status: "completed" },
        { content: "hide todo cards", status: "in_progress", priority: "high" }
      ],
      questions: [
        {
          requestId: "que_1",
          turnId: "turn-1",
          questions: [{ question: "Group?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowCustom: true }]
        }
      ],
      approvals: [
        { requestId: "per_1", kind: "command", title: "bash: pnpm test", decisions: ["accept", "decline"], permission: "bash", patterns: ["pnpm *"] }
      ]
    });
    await publishThread(sessionId, {
      questions: [],
      approvals: [],
      ...threadItem({ id: "que_1-ans", role: "tool", text: "Group? → Yes", turnId: "turn-1", toolCompletedAt: Date.now() })
    });
    await publishThread(sessionId, { turn: null, durations: { "turn-1": 4200 } });

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

  it("stops the active session's turn through the server", async () => {
    const { useAppStore } = await mount();
    const store = () => useAppStore.getState();
    await act(async () => {
      store().setPendingDriver("opencode");
    });
    await act(async () => {
      await store().sendPendingPrompt("first task");
    });
    const sessionId = store().activeSessionId!;
    expect(sessionId).toMatch(/^sess_/);
    await startThread(sessionId, "first task");
    for (let i = 0; i < 10; i += 1) await appendAssistant(sessionId, `chunk ${i} `);

    await act(async () => {
      await store().interrupt();
    });
    expect(stoppedTurns).toEqual([sessionId]);
    await publishThread(sessionId, { turn: null });

    await act(async () => {
      await store().sendPrompt("second task", []);
    });
    expect(startedTurns).toEqual([sessionId, sessionId]);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(host!.innerHTML.length).toBeGreaterThan(1000);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("renders two streaming sessions with errors while switching between them", async () => {
    const { useAppStore } = await mount();
    const store = () => useAppStore.getState();

    await act(async () => {
      store().setPendingDriver("opencode");
    });
    await act(async () => {
      await store().sendPendingPrompt("task one");
    });
    const firstId = store().activeSessionId!;

    await act(async () => {
      store().startNewSession("codex");
    });
    await act(async () => {
      await store().sendPendingPrompt("task two");
    });
    const secondId = store().activeSessionId!;
    expect(secondId).not.toBe(firstId);

    await startThread(firstId, "task one");
    await startThread(secondId, "task two");
    for (let i = 0; i < 15; i += 1) {
      await appendAssistant(firstId, `a${i} `);
      await appendAssistant(secondId, `b${i} `);
    }
    await publishThread(firstId, threadItem({ id: "x1", role: "tool", text: "bash", turnId: "turn-1", toolName: "bash", toolInput: {} }));
    await publishThread(secondId, {
      turn: null,
      ...threadItem({ id: "turn-1-e", role: "system", text: "Error: opencode server unreachable at 127.0.0.1:1 (fetch failed)", turnId: "turn-1", isError: true, retryable: true })
    });
    await publishThread(firstId, { turn: null });

    await act(async () => {
      store().selectSession(firstId);
    });
    await act(async () => {
      store().selectSession(secondId);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(host!.innerHTML).toContain("Retry connection");
    expect(host!.innerHTML.length).toBeGreaterThan(1000);
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("shows the history error with a retry that reloads through the server", async () => {
    const { useAppStore } = await mount();
    const reloads: string[] = [];
    const bridge = (window as unknown as { cw: Record<string, unknown> }).cw;
    bridge.reloadHistory = async (sessionId: string) => {
      reloads.push(sessionId);
    };
    await act(async () => {
      useAppStore.getState().setPendingDriver("opencode");
    });
    await act(async () => {
      await useAppStore.getState().sendPendingPrompt("hello");
    });
    const sessionId = useAppStore.getState().activeSessionId!;
    await publishThread(sessionId, { history: { state: "error", error: "transcript unreadable", retrying: false }, turn: null });
    expect(host!.innerHTML).toContain("transcript unreadable");
    const retry = [...host!.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    await act(async () => {
      retry?.click();
    });
    expect(reloads).toEqual([sessionId]);
    expect(fatalErrors(errors)).toEqual([]);
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
      await startThread(createdId!, "wire up the new flow with an image @.cw/pastes/x.png");
      await appendAssistant(createdId!, "working on it");

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

  it("ignores a second submit while the new session is still being created", async () => {
    mockDelays = true;
    try {
      const { useAppStore } = await mount();
      await act(async () => {
        useAppStore.getState().setPendingDriver("opencode");
      });
      await act(async () => {
        const first = useAppStore.getState().sendPendingPrompt("task one");
        const second = useAppStore.getState().sendPendingPrompt("task two");
        await Promise.all([first, second]);
      });
      const sessions = useAppStore.getState().sessionsByProject["proj_1"] ?? [];
      expect(sessions).toHaveLength(1);
      expect(fatalErrors(errors)).toEqual([]);
    } finally {
      mockDelays = false;
    }
  });
});
