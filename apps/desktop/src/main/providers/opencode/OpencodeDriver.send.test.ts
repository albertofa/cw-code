import { describe, expect, it, vi, afterEach } from "vitest";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import { OpencodeDriver } from "./OpencodeDriver.js";
import { OPENCODE_NO_TIMEOUT } from "./opencodeFetch.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

vi.mock("./opencodeFetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opencodeFetch.js")>();
  const seen: Array<{ url: string; timeoutMs: unknown; method: string }> = [];
  (globalThis as { __opencodeFetchSeen?: unknown }).__opencodeFetchSeen = seen;
  return {
    ...actual,
    opencodeFetch: (
      url: string,
      options: RequestInit & { timeoutMs?: number; port?: number }
    ): Promise<Response> => {
      seen.push({ url, timeoutMs: options.timeoutMs, method: options.method ?? "GET" });
      return actual.opencodeFetch(url, options);
    }
  };
});

function fetchSeen(): Array<{ url: string; timeoutMs: unknown; method: string }> {
  return (globalThis as { __opencodeFetchSeen?: Array<{ url: string; timeoutMs: unknown; method: string }> })
    .__opencodeFetchSeen ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchSeen().length = 0;
});

describe("OpencodeDriver message send", () => {
  it("never times out the send so permission waits survive", async () => {
    const events: ThreadEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
        if (init?.method === "POST") {
          return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), 50));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => (url.includes("/message") ? [] : {})
        });
      })
    );
    const pool = {
      ensure: async () => ({ port: 41234, authHeader: "auth" }),
      beginTurn: () => {},
      endTurn: () => {},
      invalidate: () => {},
      dispose: () => {}
    };
    const driver = new OpencodeDriver(
      (e) => {
        events.push(e);
      },
      () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
      pool as unknown as OpencodeServerPool
    );
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "native-1" });
      await new Promise((r) => setTimeout(r, 300));
      expect(events.filter((e) => e.type === "turn.error")).toEqual([]);
      const sends = fetchSeen().filter((s) => s.method === "POST" && s.url.includes("/message"));
      expect(sends.length).toBeGreaterThan(0);
      for (const s of sends) expect(s.timeoutMs).toBe(OPENCODE_NO_TIMEOUT);
    } finally {
      driver.dispose();
    }
  });
});
