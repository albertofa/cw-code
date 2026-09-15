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

function sse(event: unknown): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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

const PERMISSION_ASKED = {
  type: "permission.v2.asked",
  properties: {
    id: "per_1",
    sessionID: "ses_1",
    action: "external_directory",
    resources: ["C:\\scratchpad\\plans\\*"]
  }
};

interface Harness {
  events: ThreadEvent[];
  driver: OpencodeDriver;
  permissionReplies: string[];
}

function startHarness(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
): Harness {
  const events: ThreadEvent[] = [];
  const permissionReplies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/permission")) permissionReplies.push(url);
      return fetchImpl(url, init);
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
  driver.startTurn({
    sessionId: "sess_1",
    cwd: "C:\\proj",
    prompt: "hello",
    resumeCursor: "ses_1",
    permissionMode: "bypassPermissions"
  });
  return { events, driver, permissionReplies };
}

describe("OpencodeDriver auto-approved permissions", () => {
  it("surfaces the approval dock when no reply route accepts the auto-approve", async () => {
    const h = startHarness((url, init) => {
      if (url.endsWith("/event")) return Promise.resolve(sse(PERMISSION_ASKED));
      if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
      if (init?.method === "POST" && url.includes("/permission")) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (url.includes("/message")) return Promise.resolve(json([]));
      if (url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(json({ id: "ses_1" }));
    });
    try {
      await waitFor(() => h.events.some((e) => e.type === "approval.request"));
      const approval = h.events.find(
        (e): e is Extract<ThreadEvent, { type: "approval.request" }> => e.type === "approval.request"
      );
      expect(approval?.request.requestId).toBe("per_1");
      expect(approval?.request.permission).toBe("external_directory");
      expect(h.permissionReplies.length).toBe(3);
    } finally {
      h.driver.dispose();
    }
  });

  it("stays silent when the reply route accepts the auto-approve", async () => {
    const h = startHarness((url, init) => {
      if (url.endsWith("/event")) return Promise.resolve(sse(PERMISSION_ASKED));
      if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
      if (init?.method === "POST" && url.includes("/permission") && url.includes("/permissions/")) {
        return Promise.resolve(json(true));
      }
      if (url.includes("/message")) return Promise.resolve(json([]));
      if (url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(json({ id: "ses_1" }));
    });
    try {
      await waitFor(() => h.permissionReplies.length >= 1);
      await sleep(300);
      expect(h.events.filter((e) => e.type === "approval.request")).toEqual([]);
    } finally {
      h.driver.dispose();
    }
  });
});
