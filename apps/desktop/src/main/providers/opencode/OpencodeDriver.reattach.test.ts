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

interface Harness {
  events: ThreadEvent[];
  driver: OpencodeDriver;
  turnId: string;
  posts: string[];
  probes: string[];
  aborts: string[];
  invalidates: () => number;
}

function startHarness(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  poolOverrides?: { ensure?: () => Promise<{ port: number; authHeader: string }> }
): Harness {
  const events: ThreadEvent[] = [];
  const posts: string[] = [];
  const probes: string[] = [];
  const aborts: string[] = [];
  const wrapped = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.includes("/message")) posts.push(url);
    if (init?.method === "POST" && url.includes("/abort")) aborts.push(url);
    if (url.includes("/session/ses_1") && !url.includes("/message") && !url.includes("/question") && !url.includes("/permission")) {
      probes.push(url);
    }
    return fetchImpl(url, init);
  });
  vi.stubGlobal("fetch", wrapped);
  let port = 41234;
  let invalidateCount = 0;
  const pool = {
    ensure: async () => {
      if (poolOverrides?.ensure) return poolOverrides.ensure();
      port += 1;
      return { port, authHeader: `auth-${port}` };
    },
    beginTurn: () => {},
    endTurn: () => {},
    invalidate: () => {
      invalidateCount += 1;
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
  const { turnId } = driver.startTurn({
    sessionId: "sess_1",
    cwd: "C:\\proj",
    prompt: "hello",
    resumeCursor: "ses_1"
  });
  return { events, driver, turnId, posts, probes, aborts, invalidates: () => invalidateCount };
}

describe("OpencodeDriver send reattach", () => {
  it("keeps the turn on the same server when the streaming POST dies but the session survives", async () => {
    let postCalls = 0;
    const h = startHarness((url, init) => {
      if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null } as unknown as Response);
      if (init?.method === "POST" && url.includes("/message")) {
        postCalls += 1;
        return Promise.reject(new TypeError("fetch failed"));
      }
      if (url.includes("/message")) return Promise.resolve(json([]));
      if (url.includes("/permission")) return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
      return Promise.resolve(json({ id: "ses_1" }));
    });
    try {
      await waitFor(() => h.probes.length >= 2);
      await sleep(300);
      expect(h.events.filter((e) => e.type === "turn.error")).toEqual([]);
      expect(postCalls).toBe(1);
      expect(h.invalidates()).toBe(0);
      const internals = h.driver as unknown as {
        sessionIds: Map<string, string>;
        watchInfo: Map<string, { port: number }>;
      };
      expect(internals.sessionIds.has(h.turnId)).toBe(true);
      expect(internals.watchInfo.get(h.turnId)?.port).toBe(41235);
    } finally {
      h.driver.dispose();
    }
  });

  it("fails the turn and aborts the server run when the session is gone after the POST dies", async () => {
    let sessionGets = 0;
    const h = startHarness((url, init) => {
      if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null } as unknown as Response);
      if (init?.method === "POST" && url.includes("/message")) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      if (url.includes("/message")) return Promise.resolve(json([]));
      if (url.includes("/permission")) return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
      sessionGets += 1;
      if (sessionGets === 1) return Promise.resolve(json({ id: "ses_1" }));
      return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
    });
    try {
      await waitFor(() => h.events.some((e) => e.type === "turn.error"));
      const err = h.events.find((e) => e.type === "turn.error");
      expect(err?.type).toBe("turn.error");
      expect(h.posts.length).toBe(1);
      await waitFor(() => h.aborts.length === 1);
    } finally {
      h.driver.dispose();
    }
  });
});
