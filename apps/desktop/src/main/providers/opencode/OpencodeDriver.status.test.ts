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
      ref?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`));
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

const RUNNING_MESSAGE = [
  { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
  { info: { id: "msg_a1", role: "assistant" }, parts: [{ type: "text", text: "working" }] }
];

const ERRORED_MESSAGE = [
  RUNNING_MESSAGE[0],
  {
    info: {
      id: "msg_a1",
      role: "assistant",
      finish: "error",
      time: { created: 1, completed: 2 },
      error: { name: "APIError", data: { message: "Free usage exceeded, subscribe to Go" } }
    },
    parts: []
  }
];

function boot(
  events: ThreadEvent[],
  getMessage: () => unknown = () => RUNNING_MESSAGE,
  probeOk = true
): { driver: OpencodeDriver; sse: ReturnType<typeof controllableSse> } {
  const sse = controllableSse();
  const pool = {
    ensure: async () => ({ port: 41234, authHeader: "auth" }),
    beginTurn: () => {},
    endTurn: () => {},
    invalidate: () => {},
    probe: async () => probeOk,
    dispose: () => {}
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/event")) return Promise.resolve(sse.response);
      if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
      if (url.includes("/message")) return Promise.resolve(json(getMessage()));
      return Promise.resolve(json({ id: "ses_1" }));
    })
  );
  const driver = new OpencodeDriver(
    (e) => {
      events.push(e);
    },
    () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
    pool as unknown as OpencodeServerPool
  );
  return { driver, sse };
}

async function waitTracked(driver: OpencodeDriver): Promise<void> {
  const internals = driver as unknown as { sessionIds: Map<string, string> };
  await waitFor(() => internals.sessionIds.size === 1);
}

function retryStatus(attempt = 1): { type: string; properties: { sessionID: string; status: Record<string, unknown> } } {
  return {
    type: "session.status",
    properties: {
      sessionID: "ses_1",
      status: {
        type: "retry",
        attempt,
        message: "Free usage exceeded, subscribe to Go",
        next: 1789603191837,
        action: {
          reason: "free_tier_limit",
          provider: "opencode",
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: "https://opencode.ai/go"
        }
      }
    }
  };
}

describe("OpencodeDriver status events", () => {
  it("surfaces a session.status retry as a turn.retry event", async () => {
    const events: ThreadEvent[] = [];
    const { driver, sse } = boot(events);
    try {
      const { turnId } = driver.startTurn({
        sessionId: "sess_1",
        cwd: "C:\\proj",
        prompt: "hello",
        resumeCursor: "ses_1"
      });
      await waitTracked(driver);
      sse.push(retryStatus());
      await waitFor(() => events.some((e) => e.type === "turn.retry"));
      const retry = events.find((e): e is Extract<ThreadEvent, { type: "turn.retry" }> => e.type === "turn.retry");
      expect(retry).toMatchObject({
        turnId,
        attempt: 1,
        message: "Free usage exceeded, subscribe to Go",
        detail: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
        retryAt: 1789603191837,
        link: "https://opencode.ai/go"
      });
      expect(events.some((e) => e.type === "turn.done" || e.type === "turn.error")).toBe(false);
    } finally {
      driver.dispose();
    }
  });

  it("ignores retry status for sessions the turn does not own", async () => {
    const events: ThreadEvent[] = [];
    const { driver, sse } = boot(events);
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "ses_1" });
      await waitTracked(driver);
      const foreign = retryStatus();
      foreign.properties.sessionID = "ses_other";
      sse.push(foreign);
      await sleep(100);
      expect(events.filter((e) => e.type === "turn.retry")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("surfaces retries from subagent sessions on the owning turn", async () => {
    const events: ThreadEvent[] = [];
    const { driver, sse } = boot(events);
    try {
      const { turnId } = driver.startTurn({
        sessionId: "sess_1",
        cwd: "C:\\proj",
        prompt: "hello",
        resumeCursor: "ses_1"
      });
      await waitTracked(driver);
      sse.push({
        type: "session.created",
        properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_1" } }
      });
      const child = retryStatus();
      child.properties.sessionID = "ses_child";
      sse.push(child);
      await waitFor(() => events.some((e) => e.type === "turn.retry"));
      const retry = events.find((e): e is Extract<ThreadEvent, { type: "turn.retry" }> => e.type === "turn.retry");
      expect(retry?.turnId).toBe(turnId);
    } finally {
      driver.dispose();
    }
  });

  it("fails the turn with the provider message on session.error", async () => {
    const events: ThreadEvent[] = [];
    const { driver, sse } = boot(events);
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "ses_1" });
      await waitTracked(driver);
      sse.push({
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: { name: "UnknownError", data: { message: "Model not found: opencode/nope." } }
        }
      });
      await waitFor(() => events.some((e) => e.type === "turn.error"));
      const error = events.find((e): e is Extract<ThreadEvent, { type: "turn.error" }> => e.type === "turn.error");
      expect(error?.message).toBe("Model not found: opencode/nope.");
      expect(error?.resumeCursor).toBe("ses_1");
      const internals = driver as unknown as { sessionIds: Map<string, string> };
      expect(internals.sessionIds.size).toBe(0);
    } finally {
      driver.dispose();
    }
  });

  it("ignores context overflow errors so auto-compaction can continue", async () => {
    const events: ThreadEvent[] = [];
    const { driver, sse } = boot(events);
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "ses_1" });
      await waitTracked(driver);
      sse.push({
        type: "session.error",
        properties: { sessionID: "ses_1", error: { name: "ContextOverflowError", data: { message: "overflow" } } }
      });
      await sleep(100);
      expect(events.filter((e) => e.type === "turn.error")).toEqual([]);
      const internals = driver as unknown as { sessionIds: Map<string, string> };
      expect(internals.sessionIds.size).toBe(1);
    } finally {
      driver.dispose();
    }
  });

  it("finishes with isError when the assistant message carries an error", async () => {
    const events: ThreadEvent[] = [];
    let payload: unknown = [RUNNING_MESSAGE[0]];
    const { driver, sse } = boot(events, () => payload);
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "ses_1" });
      await waitTracked(driver);
      payload = ERRORED_MESSAGE;
      sse.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      const done = events.find((e): e is Extract<ThreadEvent, { type: "turn.done" }> => e.type === "turn.done");
      expect(done?.isError).toBe(true);
      expect(done?.resultText).toBe("Free usage exceeded, subscribe to Go");
    } finally {
      driver.dispose();
    }
  });
});
