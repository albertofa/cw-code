import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import { OpencodeDriver } from "./OpencodeDriver.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function controllableSse(): { response: Response; push: (event: unknown) => void } {
  const encoder = new TextEncoder();
  let ref: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ref = controller;
    }
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push(event: unknown) {
      ref?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
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
    await sleep(25);
  }
}

function startDriver(events: ThreadEvent[]): OpencodeDriver {
  const pool = {
    ensure: async () => ({ port: 41234, authHeader: "auth" }),
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

function appendText(): unknown[] {
  return [{ info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "hi" }] }];
}

describe("OpencodeDriver detached send", () => {
  it("keeps the turn alive when the POST is cut and finishes on the SSE idle event", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve(sse.response);
        if (init?.method === "POST" && url.includes("/message")) {
          posts += 1;
          return Promise.reject(new TypeError("fetch failed"));
        }
        if (url.includes("/message")) return Promise.resolve(json([]));
        return Promise.resolve(json({ id: "ses_1" }));
      })
    );
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({
        sessionId: "sess_1",
        cwd: "C:\\proj",
        prompt: "hello",
        resumeCursor: "ses_1"
      });
      await waitFor(() => posts === 1);
      await sleep(50);
      expect(events.filter((e) => e.type === "turn.error")).toEqual([]);
      sse.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      expect(events.find((e) => e.type === "turn.done")).toMatchObject({ turnId, isError: false });
    } finally {
      driver.dispose();
    }
  });

  it("retries text-only once when attachments are rejected", async () => {
    const events: ThreadEvent[] = [];
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
        if (init?.method === "POST" && url.includes("/message")) {
          bodies.push(String(init.body ?? ""));
          if (bodies.length === 1) return Promise.resolve(json({}, 400));
          return new Promise<Response>(() => {});
        }
        if (url.includes("/message")) return Promise.resolve(json([]));
        return Promise.resolve(json({ id: "ses_1" }));
      })
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({
        sessionId: "sess_1",
        cwd: "C:\\proj",
        prompt: "hello",
        resumeCursor: "ses_1",
        attachments: ["shot.png"]
      });
      await waitFor(() => bodies.length === 2);
      expect(bodies[0]).toContain('"type":"file"');
      expect(bodies[1]).not.toContain('"type":"file"');
      await sleep(50);
      expect(events.filter((e) => e.type === "turn.error")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("fails the turn on an immediate send rejection", async () => {
    const events: ThreadEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
        if (init?.method === "POST" && url.includes("/message")) return Promise.resolve(json({}, 500));
        if (url.includes("/message")) return Promise.resolve(json([]));
        return Promise.resolve(json({ id: "ses_1" }));
      })
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "ses_1" });
      await waitFor(() => events.some((e) => e.type === "turn.error"));
      const error = events.find((e): e is Extract<ThreadEvent, { type: "turn.error" }> => e.type === "turn.error");
      expect(error?.message).toContain("opencode message send failed: 500");
      expect(events.filter((e) => e.type === "turn.done")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("fails the turn with a retryable error when the server process is gone", async () => {
    const events: ThreadEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
        if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
        if (url.includes("/message")) return Promise.resolve(json([]));
        return Promise.resolve(json({ id: "ses_1" }));
      })
    );
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({
        sessionId: "sess_1",
        cwd: "C:\\proj",
        prompt: "hello",
        resumeCursor: "ses_1"
      });
      const internals = driver as unknown as {
        sessionIds: Map<string, string>;
        handleServerGone: (rootPath: string, port: number) => void;
      };
      await waitFor(() => internals.sessionIds.has(turnId));
      internals.handleServerGone("C:\\proj", 41234);
      const error = events.find((e): e is Extract<ThreadEvent, { type: "turn.error" }> => e.type === "turn.error");
      expect(error?.retryable).toBe(true);
      expect(error?.message).toContain("server exited");
      expect(internals.sessionIds.has(turnId)).toBe(false);
    } finally {
      driver.dispose();
    }
  });

  it("emits context.compacted once when the poll finds a compaction summary", async () => {
    const events: ThreadEvent[] = [];
    const withSummary = [
      { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      {
        info: { id: "msg_c1", role: "assistant", mode: "compaction", summary: true },
        parts: [{ type: "text", text: "This session is being continued..." }]
      }
    ];
    let plainGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
        if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
        if (url.includes("limit=50")) return Promise.resolve(json(withSummary));
        if (url.includes("/message")) {
          plainGets += 1;
          return Promise.resolve(json(plainGets === 1 ? appendText() : withSummary));
        }
        return Promise.resolve(json({ id: "ses_1" }));
      })
    );
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "ses_1" });
      await waitFor(() => events.some((e) => e.type === "context.compacted"), 7000);
      expect(events.filter((e) => e.type === "context.compacted")).toEqual([
        { type: "context.compacted", turnId, compaction: { trigger: "auto" } }
      ]);
      await sleep(2200);
      expect(events.filter((e) => e.type === "context.compacted")).toHaveLength(1);
    } finally {
      driver.dispose();
    }
  });

  it("drops streamed text deltas for compaction summary messages", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve(sse.response);
        if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
        if (url.includes("/message")) return Promise.resolve(json(appendText()));
        return Promise.resolve(json({ id: "ses_1" }));
      })
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "ses_1" });
      await sleep(150);
      sse.push({
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "msg_c1", role: "assistant", mode: "compaction", summary: true }
        }
      });
      sse.push({
        type: "message.part.delta",
        properties: { sessionID: "ses_1", messageID: "msg_c1", field: "text", delta: "summary body", partID: "p_c1" }
      });
      await sleep(50);
      expect(events.filter((e) => e.type === "assistant.delta")).toEqual([]);

      sse.push({
        type: "message.part.delta",
        properties: { sessionID: "ses_1", messageID: "msg_a1", field: "text", delta: "real answer", partID: "p_a1" }
      });
      await sleep(50);
      expect(
        events.filter((e) => e.type === "assistant.delta").map((e) => ("text" in e ? e.text : ""))
      ).toEqual(["real answer"]);
    } finally {
      driver.dispose();
    }
  });

  it("finishes from the poll when the last new assistant message is terminal", async () => {
    const events: ThreadEvent[] = [];
    const terminal = [
      {
        info: { id: "msg_a1", role: "assistant", finish: "stop", time: { created: 1, completed: 2 } },
        parts: [{ type: "text", text: "done" }]
      }
    ];
    let plainGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
        if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
        if (url.includes("limit=50")) return Promise.resolve(json(terminal));
        if (url.includes("/message")) {
          plainGets += 1;
          return Promise.resolve(json(plainGets === 1 ? appendText() : terminal));
        }
        return Promise.resolve(json({ id: "ses_1" }));
      })
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "ses_1" });
      await waitFor(() => events.some((e) => e.type === "turn.done"), 7000);
      const done = events.find((e): e is Extract<ThreadEvent, { type: "turn.done" }> => e.type === "turn.done");
      expect(done?.resultText).toBe("done");
    } finally {
      driver.dispose();
    }
  });
});
