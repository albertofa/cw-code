import { afterEach, describe, expect, it, vi } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "../../../tests/testing.js";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import { OpencodeDriver } from "./OpencodeDriver.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

afterEach(() => {
  unstubAllGlobals();
});

const SID = "ses_inject";
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

function startDriver(events: ThreadEvent[], protocol: "v1" | "v2" = "v2"): OpencodeDriver {
  const pool = {
    ensure: async () => ({ port: 41234, authHeader: "auth", protocol }),
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
  prompts: Array<Record<string, unknown>>;
  deletes: string[];
  interrupts: string[];
  deleteStatus: number;
  injectDelayMs: number;
  initialWithoutId: boolean;
  inbox: Set<string>;
  messages: Set<string>;
  deliverOnDelete: boolean;
  messagesDelayMs: number;
  injectWithoutId: boolean;
}

function stubServer(sse: ReturnType<typeof controllableSse>, state: ServerState): void {
  stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/event") return sse.response;
      if (path === "/api/session/active") return json({ data: {} });
      if (method === "POST" && path.endsWith("/prompt")) {
        state.prompts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const index = state.prompts.length;
        if (index > 1 && state.injectDelayMs > 0) await sleep(state.injectDelayMs);
        if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        if (index === 1 && state.initialWithoutId) return json({ data: {} });
        if (index > 1 && state.injectWithoutId) return json({ data: {} });
        const id = index === 1 ? "msg_u" : `inbox_${index}`;
        if (index > 1) state.inbox.add(id);
        return json({ data: { id, delivery: "steer" } });
      }
      if (method === "POST" && path.endsWith("/interrupt")) {
        state.interrupts.push(path);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        state.deletes.push(path);
        if (state.deleteStatus !== 204) return new Response(null, { status: state.deleteStatus });
        const id = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
        if (state.deliverOnDelete && state.inbox.has(id)) deliverOnServer(state, id);
        state.inbox.delete(id);
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/inbox")) return json({ data: [...state.inbox].map((id) => ({ id, type: "user" })) });
      if (path.endsWith("/message")) {
        if (state.messagesDelayMs > 0) await sleep(state.messagesDelayMs);
        return json({ data: [...state.messages].map((id) => ({ id, type: "user", text: "" })), cursor: {} });
      }
      if (path.endsWith("/form") || path === "/api/permission/request") return json({ data: [] });
      return json({ data: { id: SID } });
    })
  );
}

function newState(): ServerState {
  return {
    prompts: [],
    deletes: [],
    interrupts: [],
    deleteStatus: 204,
    injectDelayMs: 0,
    initialWithoutId: false,
    inbox: new Set(),
    messages: new Set(),
    deliverOnDelete: false,
    messagesDelayMs: 0,
    injectWithoutId: false
  };
}

function deliverOnServer(state: ServerState, inboxId: string): void {
  state.inbox.delete(inboxId);
  state.messages.add(inboxId);
}

function injection(id: string, prompt = "also do this") {
  return { id, prompt, cwd: CWD, attachments: [] as string[] };
}

function userMessages(events: ThreadEvent[]): Array<Extract<ThreadEvent, { type: "user.message" }>> {
  return events.filter((e): e is Extract<ThreadEvent, { type: "user.message" }> => e.type === "user.message");
}

async function startRunning(driver: OpencodeDriver, state: ServerState): Promise<string> {
  const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "hello", resumeCursor: SID });
  await waitFor(() => state.prompts.length === 1);
  await sleep(50);
  return turnId;
}

describe("OpencodeDriver mid-turn messages on opencode v2", () => {
  it("posts the message to the session and emits user.message when its inbox item is delivered", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      await driver.injectMessage(turnId, injection("cw-msg-1", "also do this"));
      expect(state.prompts[1]).toEqual({ text: "also do this" });
      expect(userMessages(events)).toEqual([]);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_2" });
      await waitFor(() => userMessages(events).length === 1);
      expect(userMessages(events)[0]).toMatchObject({ turnId, messageId: "cw-msg-1", text: "also do this" });
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_2" });
      await sleep(50);
      expect(userMessages(events)).toHaveLength(1);
    } finally {
      driver.dispose();
    }
  });

  it("does not take an injected delivery for the initial prompt", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_2" });
      await waitFor(() => userMessages(events).length === 1);
      sse.push("session.execution.succeeded", { sessionID: SID });
      await sleep(2500);
      expect(events.some((e) => e.type === "turn.done")).toBe(false);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(events.filter((e) => e.type === "turn.done")).toHaveLength(1);
      expect(userMessages(events)).toHaveLength(1);
    } finally {
      driver.dispose();
    }
  }, 10_000);

  it("keeps a delivery that lands before the prompt response", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.injectDelayMs = 200;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      const pending = driver.injectMessage(turnId, injection("cw-msg-1"));
      await waitFor(() => state.prompts.length === 2);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_2" });
      await sleep(50);
      expect(userMessages(events)).toEqual([]);
      await pending;
      expect(userMessages(events)).toMatchObject([{ turnId, messageId: "cw-msg-1" }]);
    } finally {
      driver.dispose();
    }
  });

  it("retracts an undelivered message and reports false once it is delivered", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      expect(driver.messageCapabilities(turnId)).toEqual({ inject: true, retract: true });
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      await driver.injectMessage(turnId, injection("cw-msg-2"));
      expect(await driver.retractMessage(turnId, "cw-msg-1")).toBe(true);
      expect(state.deletes).toEqual([`/api/session/${SID}/inbox/inbox_2`]);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_3" });
      await waitFor(() => userMessages(events).length === 1);
      expect(await driver.retractMessage(turnId, "cw-msg-2")).toBe(false);
      expect(await driver.retractMessage(turnId, "cw-msg-unknown")).toBe(false);
      expect(state.deletes).toHaveLength(1);
    } finally {
      driver.dispose();
    }
  });

  it("reports false without deleting when the server already delivered the inbox item", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      deliverOnServer(state, "inbox_2");
      expect(await driver.retractMessage(turnId, "cw-msg-1")).toBe(false);
      expect(state.deletes).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("reports false when the delete answers 204 but the item was delivered meanwhile, and keeps waiting for its delivery", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.deliverOnDelete = true;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      expect(await driver.retractMessage(turnId, "cw-msg-1")).toBe(false);
      expect(state.deletes).toEqual([`/api/session/${SID}/inbox/inbox_2`]);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_2" });
      await waitFor(() => userMessages(events).length === 1);
      expect(userMessages(events)).toMatchObject([{ turnId, messageId: "cw-msg-1" }]);
    } finally {
      driver.dispose();
    }
  });

  it("reports false when the server refuses the delete", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.deleteStatus = 404;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      expect(await driver.retractMessage(turnId, "cw-msg-1")).toBe(false);
    } finally {
      driver.dispose();
    }
  });

  it("deletes the undelivered messages from the inbox on interrupt", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      await driver.injectMessage(turnId, injection("cw-msg-2"));
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_2" });
      await waitFor(() => userMessages(events).length === 1);
      driver.interrupt(turnId);
      await waitFor(() => state.interrupts.length === 1);
      expect(state.deletes).toEqual([`/api/session/${SID}/inbox/inbox_3`]);
      await expect(driver.injectMessage(turnId, injection("cw-msg-3"))).rejects.toThrow("No active opencode turn");
    } finally {
      driver.dispose();
    }
  });

  it("keeps an in-flight injected delivery from counting as the initial prompt when its id is unknown", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.initialWithoutId = true;
    state.injectDelayMs = 200;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      const pending = driver.injectMessage(turnId, injection("cw-msg-1"));
      await waitFor(() => state.prompts.length === 2);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_2" });
      await pending;
      expect(userMessages(events)).toMatchObject([{ turnId, messageId: "cw-msg-1" }]);
      sse.push("session.execution.succeeded", { sessionID: SID });
      await sleep(2500);
      expect(events.some((e) => e.type === "turn.done")).toBe(false);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(events.filter((e) => e.type === "turn.done")).toHaveLength(1);
    } finally {
      driver.dispose();
    }
  }, 10_000);

  it("counts the initial prompt delivery that lands during an injection when the prompt was admitted without an id", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.initialWithoutId = true;
    state.injectDelayMs = 200;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      const pending = driver.injectMessage(turnId, injection("cw-msg-1"));
      await waitFor(() => state.prompts.length === 2);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      await pending;
      expect(userMessages(events)).toEqual([]);
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(events.filter((e) => e.type === "turn.done")).toHaveLength(1);
    } finally {
      driver.dispose();
    }
  }, 10_000);

  it("retracts a message the server never delivered when the turn ends", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      await driver.injectMessage(turnId, injection("cw-msg-2"));
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "inbox_2" });
      await waitFor(() => userMessages(events).length === 1);
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      await waitFor(() => state.deletes.length === 1);
      expect(state.deletes).toEqual([`/api/session/${SID}/inbox/inbox_3`]);
      expect(userMessages(events)).toHaveLength(1);
    } finally {
      driver.dispose();
    }
  });

  it("warns when a leftover inbox item can no longer be retracted at turn end", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.deleteStatus = 404;
    stubServer(sse, state);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      await waitFor(() => warn.mock.calls.some((call) => String(call[0]).includes("inbox_2")));
      expect(String(warn.mock.calls.find((call) => String(call[0]).includes("inbox_2"))?.[0])).toContain(SID);
    } finally {
      warn.mockRestore();
      driver.dispose();
    }
  });

  it("retracts a message whose post was still in flight when the turn ended", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.injectDelayMs = 300;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      await sleep(50);
      const pending = driver.injectMessage(turnId, injection("cw-msg-1"));
      await waitFor(() => state.prompts.length === 2);
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(((await pending.then(() => null, (error: unknown) => error)) as Error | null)?.message).toContain("ended before the message was delivered");
      expect(state.deletes).toEqual([`/api/session/${SID}/inbox/inbox_2`]);
      expect(userMessages(events)).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("retracts a message whose post was in flight at interrupt before interrupting", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.injectDelayMs = 200;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      const pending = driver.injectMessage(turnId, injection("cw-msg-1"));
      await waitFor(() => state.prompts.length === 2);
      driver.interrupt(turnId);
      expect(((await pending.then(() => null, (error: unknown) => error)) as Error | null)?.message).toContain("stopped before the message was delivered");
      await waitFor(() => state.interrupts.length === 1);
      expect(state.deletes).toEqual([`/api/session/${SID}/inbox/inbox_2`]);
    } finally {
      driver.dispose();
    }
  });

  it("refuses to retract a message whose post is still in flight", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.injectDelayMs = 200;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      const pending = driver.injectMessage(turnId, injection("cw-msg-1"));
      await waitFor(() => state.prompts.length === 2);
      await expect(driver.retractMessage(turnId, "cw-msg-1")).rejects.toThrow("still being sent");
      await pending;
      expect(await driver.retractMessage(turnId, "cw-msg-1")).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("treats a message the server accepted without an inbox id as delivered", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.injectWithoutId = true;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      expect(userMessages(events)).toMatchObject([{ turnId, messageId: "cw-msg-1" }]);
    } finally {
      driver.dispose();
    }
  });

  it("finishes retracting leftovers before turn.done", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    const deletesAtDone: number[] = [];
    try {
      const turnId = await startRunning(driver, state);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      const done = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!events.some((e) => e.type === "turn.done")) return;
          deletesAtDone.push(state.deletes.length);
          clearInterval(timer);
          resolve();
        }, 1);
      });
      sse.push("session.execution.succeeded", { sessionID: SID });
      await done;
      expect(deletesAtDone).toEqual([1]);
      expect(userMessages(events)).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("reports a leftover the agent already received as delivered at turn end", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      await driver.injectMessage(turnId, injection("cw-msg-1"));
      deliverOnServer(state, "inbox_2");
      sse.push("session.execution.succeeded", { sessionID: SID });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(state.deletes).toEqual([]);
      const delivered = events.findIndex((e) => e.type === "user.message");
      expect(userMessages(events)).toMatchObject([{ turnId, messageId: "cw-msg-1" }]);
      expect(delivered).toBeLessThan(events.findIndex((e) => e.type === "turn.done"));
    } finally {
      driver.dispose();
    }
  });

  it("stops taking messages once the server reports the execution ended", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    state.messagesDelayMs = 300;
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      sse.push("session.inbox.delivered", { sessionID: SID, inboxID: "msg_u" });
      await sleep(50);
      expect(driver.messageCapabilities(turnId)).toEqual({ inject: true, retract: true });
      sse.push("session.execution.succeeded", { sessionID: SID });
      await sleep(100);
      expect(events.some((e) => e.type === "turn.done")).toBe(false);
      expect(driver.messageCapabilities(turnId)).toEqual({ inject: false, retract: true });
      await expect(driver.injectMessage(turnId, injection("cw-msg-1"))).rejects.toThrow("already finished running");
      expect(state.prompts).toHaveLength(1);
      await waitFor(() => events.some((e) => e.type === "turn.done"));
    } finally {
      driver.dispose();
    }
  });

  it("rejects when the prompt is refused", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const state = newState();
    stubServer(sse, state);
    const driver = startDriver(events);
    try {
      const turnId = await startRunning(driver, state);
      const base = globalThis.fetch;
      stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (init?.method === "POST" && new URL(url).pathname.endsWith("/prompt")) return Promise.resolve(json({ error: "busy" }, 409));
          return base(url, init);
        })
      );
      await expect(driver.injectMessage(turnId, injection("cw-msg-1"))).rejects.toThrow("409");
      expect(await driver.retractMessage(turnId, "cw-msg-1")).toBe(false);
    } finally {
      driver.dispose();
    }
  });
});

describe("OpencodeDriver mid-turn messages on opencode v1", () => {
  it("rejects injection and cannot retract", async () => {
    const events: ThreadEvent[] = [];
    stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/event") return Promise.resolve(new Response(null, { status: 500 }));
        if (init?.method === "POST" && path.endsWith("/message")) return new Promise(() => {});
        if (path.endsWith("/message")) return Promise.resolve(json([]));
        return Promise.resolve(json({ id: SID }));
      })
    );
    const driver = startDriver(events, "v1");
    try {
      const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "hello", resumeCursor: SID });
      await sleep(200);
      expect(driver.messageCapabilities(turnId)).toEqual({ inject: false, retract: false });
      await expect(driver.injectMessage(turnId, injection("cw-msg-1"))).rejects.toThrow("cannot take messages");
      expect(await driver.retractMessage(turnId, "cw-msg-1")).toBe(false);
    } finally {
      driver.dispose();
    }
  });
});
