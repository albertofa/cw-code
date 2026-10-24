import { afterEach, describe, expect, it, vi } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "../../../tests/testing.js";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import { OpencodeDriver } from "./OpencodeDriver.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

afterEach(() => {
  unstubAllGlobals();
});

const SID = "ses_v2";
const CWD = "C:\\proj";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function controllableSse(): { response: Response; push: (type: string, data: Record<string, unknown>) => void } {
  const encoder = new TextEncoder();
  let ref: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ref = controller;
    }
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push(type, data) {
      ref?.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "evt", created: 1, type, data })}\n\n`));
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}

function startDriver(events: ThreadEvent[]): OpencodeDriver {
  const pool = {
    ensure: async () => ({ port: 41234, authHeader: "auth", protocol: "v2" as const }),
    beginTurn: () => {},
    endTurn: () => {},
    invalidate: () => {},
    probe: async () => true,
    dispose: () => {}
  };
  return new OpencodeDriver(
    (e) => {
      events.push(e);
    },
    () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
    pool as unknown as OpencodeServerPool
  );
}

interface ServerState {
  messages: unknown[];
  prompts: unknown[];
  formReplies: unknown[];
}

function stubServer(sse: ReturnType<typeof controllableSse>, state: ServerState): void {
  stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/event") return Promise.resolve(sse.response);
      if (path === "/api/session/active") return Promise.resolve(json({ data: {} }));
      if (method === "POST" && path.endsWith("/prompt")) {
        state.prompts.push(JSON.parse(String(init?.body)));
        return Promise.resolve(json({ data: { id: "msg_u" } }));
      }
      if (method === "POST" && path.includes("/form/")) {
        state.formReplies.push({ path, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path.endsWith("/message")) {
        const desc = new URL(url).searchParams.get("order") === "desc";
        return Promise.resolve(json({ data: desc ? [...state.messages].reverse() : state.messages, cursor: {} }));
      }
      if (path.endsWith("/form") || path === "/api/permission/request") return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: { id: SID } }));
    })
  );
}

const USER = { id: "msg_u", type: "user", text: "hi", time: { created: 2 } };
const ANSWER = {
  id: "msg_a",
  type: "assistant",
  agent: "build",
  model: { id: "big-pickle", providerID: "opencode" },
  content: [{ type: "text", text: "DONE" }],
  finish: "stop",
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 3, completed: 4 }
};
const IDLE = { id: "msg_i", type: "idle", outcome: "succeeded", time: { created: 5 } };

describe("OpencodeDriver on an opencode v2 server", () => {
  it("keeps the turn open after the prompt is admitted and ends it once on execution.succeeded", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "hello", resumeCursor: SID });
      await waitFor(() => state.prompts.length === 1);
      await sleep(100);
      expect(events.filter((e) => e.type === "turn.done")).toEqual([]);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      sse.push("session.text.delta", { sessionID: SID, assistantMessageID: "msg_a", ordinal: 0, delta: "DONE" });
      state.messages = [USER, ANSWER, IDLE];
      sse.push("session.execution.succeeded", { sessionID: SID });
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      await sleep(100);
      expect(events.filter((e) => e.type === "assistant.delta")).toEqual([{ type: "assistant.delta", turnId, text: "DONE" }]);
      const done = events.filter((e): e is Extract<ThreadEvent, { type: "turn.done" }> => e.type === "turn.done");
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ turnId, resultText: "DONE", isError: false, resumeCursor: SID });
    } finally {
      driver.dispose();
    }
  });

  it("ignores the end of an earlier run that lands before this turn's prompt is delivered", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "follow-up", resumeCursor: SID });
      await waitFor(() => state.prompts.length === 1);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_previous" });
      sse.push("session.execution.interrupted", { sessionID: SID, reason: "user" });
      state.messages = [{ ...IDLE, id: "msg_stale", outcome: "interrupted" }];
      await sleep(2500);
      expect(events.filter((e) => e.type === "turn.done")).toEqual([]);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      state.messages = [{ ...IDLE, id: "msg_stale", outcome: "interrupted" }, USER, ANSWER, IDLE];
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(events.find((e) => e.type === "turn.done")).toMatchObject({ turnId, resultText: "DONE" });
    } finally {
      driver.dispose();
    }
  }, 10_000);

  it("dismisses a form the question dock cannot show and says so in the thread", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    const deletes: string[] = [];
    stubServer(sse, state);
    const base = globalThis.fetch;
    stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deletes.push(url);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return base(url, init);
      })
    );
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "search", resumeCursor: SID });
      await waitFor(() => state.prompts.length === 1);
      sse.push("session.created", { sessionID: "ses_child", parentID: SID });
      sse.push("form.created", { form: { id: "frm_mcp", sessionID: "ses_child", title: "Sign in", fields: [{ key: "port", type: "number" }] } });
      await waitFor(() => deletes.length === 1);
      expect(deletes[0]).toContain("/api/session/ses_child/form/frm_mcp?message=");
      expect(events.find((e) => e.type === "assistant.delta")).toMatchObject({ turnId });
      expect(events.some((e) => e.type === "question.request")).toBe(false);
    } finally {
      driver.dispose();
    }
  });

  it("interrupts the subagents it knows about along with the session", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    const interrupts: string[] = [];
    stubServer(sse, state);
    const base = globalThis.fetch;
    stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/interrupt")) {
          interrupts.push(new URL(url).pathname);
          return Promise.resolve(json({ interrupted: true }));
        }
        return base(url, init);
      })
    );
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "launch", resumeCursor: SID });
      await waitFor(() => state.prompts.length === 1);
      sse.push("session.created", { sessionID: "ses_child", parentID: SID });
      await sleep(50);
      driver.interrupt(turnId);
      await waitFor(() => interrupts.length === 2);
      expect(interrupts).toEqual(["/api/session/ses_child/interrupt", `/api/session/${SID}/interrupt`]);
    } finally {
      driver.dispose();
    }
  });

  it("counts the in-flight run as the reattached turn's work after a reconnect", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    const earlier = [
      { ...USER, id: "msg_u0" },
      { ...ANSWER, id: "msg_a0", content: [{ type: "text", text: "earlier" }] },
      { ...IDLE, id: "msg_i0" }
    ];
    const inFlight = { ...ANSWER, id: "msg_a1", content: [{ type: "text", text: "partial" }], finish: "tool-calls" };
    state.messages = [...earlier, USER, inFlight];
    stubServer(sse, state);
    const base = globalThis.fetch;
    stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) =>
        new URL(url).pathname === "/api/session/active" ? Promise.resolve(json({ data: { [SID]: {} } })) : base(url, init)
      )
    );
    const driver = startDriver(events);
    try {
      const result = await driver.retryConnection({ sessionId: "s1", cwd: CWD, resumeCursor: SID });
      expect(result.status).toBe("running");
      state.messages = [...earlier, USER, inFlight, { ...ANSWER, id: "msg_a2" }, { ...IDLE, id: "msg_i1" }];
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(events.find((e) => e.type === "turn.done")).toMatchObject({
        turnId: result.turnId,
        resultText: "partial\nDONE",
        usage: [expect.objectContaining({ model: "opencode/big-pickle", inputTokens: 2 })]
      });
    } finally {
      driver.dispose();
    }
  }, 10_000);

  it("fails the turn on execution.failed", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "hello", resumeCursor: SID });
      await waitFor(() => state.prompts.length === 1);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      sse.push("session.execution.failed", { sessionID: SID, error: { type: "provider.auth", message: "bad key" } });
      await waitFor(() => events.some((e) => e.type === "turn.error"));
      expect(events.find((e) => e.type === "turn.error")).toMatchObject({ message: "bad key", resumeCursor: SID });
    } finally {
      driver.dispose();
    }
  });

  it("emits tool cards and the todo list from tool events", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "plan", resumeCursor: SID });
      await waitFor(() => state.prompts.length === 1);
      const base = { sessionID: SID, assistantMessageID: "msg_a", id: "call_todo" };
      sse.push("session.tool.input.started", { ...base, name: "todo" });
      sse.push("session.tool.called", { ...base, input: { todos: [{ content: "ship", status: "in_progress" }] }, executed: false });
      sse.push("session.tool.success", { ...base, content: [{ type: "text", text: "Todo list updated" }], executed: false });
      await waitFor(() => events.some((e) => e.type === "tool.result"));
      expect(events.filter((e) => e.type === "todo.updated")).toEqual([
        { type: "todo.updated", turnId, todos: [{ content: "ship", status: "in_progress" }] }
      ]);
      expect(events.filter((e) => e.type === "tool.call").map((e) => ("input" in e ? e.input : null))).toEqual([
        {},
        { todos: [{ content: "ship", status: "in_progress" }] }
      ]);
    } finally {
      driver.dispose();
    }
  });

  it("answers a question form through the form reply route", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "ask", resumeCursor: SID });
      await waitFor(() => state.prompts.length === 1);
      sse.push("form.created", {
        form: {
          id: "frm_1",
          sessionID: SID,
          title: "Questions",
          metadata: { kind: "question" },
          fields: [{ key: "q0", title: "Color", description: "Color?", type: "string", options: [{ value: "Red", label: "Red" }], custom: true }]
        }
      });
      await waitFor(() => events.some((e) => e.type === "question.request"));
      await driver.respondToQuestion("frm_1", { "Color?": "Red" });
      expect(state.formReplies).toEqual([{ path: `/api/session/${SID}/form/frm_1/reply`, body: { answer: { q0: "Red" } } }]);
      expect(events.find((e) => e.type === "question.resolved")).toMatchObject({ turnId, requestId: "frm_1" });
    } finally {
      driver.dispose();
    }
  });

  it("holds the turn while a background subagent runs and ends after the parent wakes again", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state: ServerState = { messages: [], prompts: [], formReplies: [] };
    stubServer(sse, state);
    const driver = startDriver(events);
    const launch = {
      ...ANSWER,
      content: [
        {
          type: "tool",
          id: "call_sub",
          name: "subagent",
          state: {
            status: "completed",
            input: { agent: "general", background: true },
            content: [{ type: "text", text: "working in the background" }],
            metadata: { sessionID: "ses_child", status: "running" }
          },
          time: { created: 3, completed: 4 }
        }
      ]
    };
    const completion = {
      id: "msg_s",
      type: "synthetic",
      text: '<subagent sessionID="ses_child" state="completed">\nhello\n</subagent>',
      metadata: { source: "subagent", childID: "ses_child", state: "completed" },
      time: { created: 6 }
    };
    try {
      driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "launch", resumeCursor: SID });
      await waitFor(() => state.prompts.length === 1);
      state.messages = [USER, launch, IDLE];
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      sse.push("session.execution.succeeded", { sessionID: SID });
      await sleep(2500);
      expect(events.filter((e) => e.type === "turn.done")).toEqual([]);
      state.messages = [USER, launch, IDLE, completion, { ...ANSWER, id: "msg_a2" }, { ...IDLE, id: "msg_i2" }];
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(events.some((e) => e.type === "tool.result" && e.toolCallId === "call_sub" && e.output === "hello")).toBe(true);
    } finally {
      driver.dispose();
    }
  }, 10_000);
});
