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

const RUNNING_MESSAGE = [
  {
    info: { id: "msg_u1", role: "user" },
    parts: [{ type: "text", text: "hi" }]
  },
  {
    info: { id: "msg_a1", role: "assistant" },
    parts: [{ type: "text", text: "working" }]
  }
];

const DONE_MESSAGE = [
  RUNNING_MESSAGE[0],
  {
    info: { id: "msg_a1", role: "assistant", finish: "stop", time: { created: 1, completed: 2 } },
    parts: [{ type: "text", text: "done" }]
  }
];

interface PoolCalls {
  ensure: number;
  invalidate: number;
}

function startDriver(events: ThreadEvent[], probeOk = true): { driver: OpencodeDriver; calls: PoolCalls } {
  const calls: PoolCalls = { ensure: 0, invalidate: 0 };
  const pool = {
    ensure: async () => {
      calls.ensure += 1;
      return { port: 41234, authHeader: "auth" };
    },
    probe: async () => probeOk,
    beginTurn: () => {},
    endTurn: () => {},
    invalidate: () => {
      calls.invalidate += 1;
    },
    dispose: () => {}
  };
  const driver = new OpencodeDriver(
    (e) => {
      events.push(e);
    },
    () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
    pool as unknown as OpencodeServerPool
  );
  return { driver, calls };
}

describe("OpencodeDriver retryConnection", () => {
  it("returns done and the refetched history when the run already ended", async () => {
    const events: ThreadEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/session/ses_1")) return Promise.resolve(json({ id: "ses_1" }));
        return Promise.resolve(json(DONE_MESSAGE));
      })
    );
    const { driver } = startDriver(events);
    try {
      const result = await driver.retryConnection({ sessionId: "sess_1", cwd: "C:\\proj", resumeCursor: "ses_1" });
      expect(result.status).toBe("done");
      expect(result.turnId).toBeUndefined();
      expect(result.history.some((m) => m.role === "assistant" && m.text === "done")).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("reattaches a running session and finishes on the SSE idle event", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    let payload = RUNNING_MESSAGE;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/event")) return Promise.resolve(sse.response);
        if (url.endsWith("/session/ses_1")) return Promise.resolve(json({ id: "ses_1" }));
        return Promise.resolve(json(payload));
      })
    );
    const { driver } = startDriver(events);
    try {
      const result = await driver.retryConnection({ sessionId: "sess_1", cwd: "C:\\proj", resumeCursor: "ses_1" });
      expect(result.status).toBe("running");
      expect(result.turnId).toBeTruthy();

      payload = DONE_MESSAGE;
      sse.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
      await waitFor(() => events.some((e) => e.type === "turn.done"));
      const done = events.find((e): e is Extract<ThreadEvent, { type: "turn.done" }> => e.type === "turn.done");
      expect(done?.turnId).toBe(result.turnId);
      expect(done?.resultText).toBe("done");
    } finally {
      driver.dispose();
    }
  });

  it("invalidates a dead server and respawns before probing", async () => {
    const events: ThreadEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/session/ses_1")) return Promise.resolve(json({ id: "ses_1" }));
        return Promise.resolve(json(DONE_MESSAGE));
      })
    );
    const { driver, calls } = startDriver(events, false);
    try {
      await driver.retryConnection({ sessionId: "sess_1", cwd: "C:\\proj", resumeCursor: "ses_1" });
      expect(calls.invalidate).toBe(1);
      expect(calls.ensure).toBe(2);
    } finally {
      driver.dispose();
    }
  });

  it("throws when the session no longer exists on the server", async () => {
    const events: ThreadEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/session/ses_1")) return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(json(DONE_MESSAGE));
      })
    );
    const { driver } = startDriver(events);
    try {
      await expect(
        driver.retryConnection({ sessionId: "sess_1", cwd: "C:\\proj", resumeCursor: "ses_1" })
      ).rejects.toThrow("no longer exists");
    } finally {
      driver.dispose();
    }
  });
});
