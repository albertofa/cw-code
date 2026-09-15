import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, PermissionMode, ThreadEvent } from "@cw-code/contracts";
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
  return sseStream([event]);
}

function sseStream(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
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

function childAsked(requestId: string, sessionID: string): unknown {
  return {
    type: "permission.v2.asked",
    properties: { id: requestId, sessionID, action: "bash", resources: ["npm install"] }
  };
}

function sessionCreated(sessionID: string, parentID: string): unknown {
  return { type: "session.created", properties: { sessionID, info: { id: sessionID, parentID } } };
}

interface Harness {
  events: ThreadEvent[];
  driver: OpencodeDriver;
  permissionReplies: string[];
}

function startHarness(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  options: { permissionMode?: PermissionMode } = {}
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
    permissionMode: options.permissionMode ?? "bypassPermissions"
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

describe("OpencodeDriver subagent permissions", () => {
  it("surfaces a subagent permission announced by session.created and replies on the child session", async () => {
    const h = startHarness(
      (url, init) => {
        if (url.endsWith("/event")) {
          return Promise.resolve(sseStream([sessionCreated("ses_child", "ses_1"), childAsked("per_2", "ses_child")]));
        }
        if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
        if (init?.method === "POST" && url.includes("/api/session/ses_child/permission/per_2/reply")) {
          return Promise.resolve(json(true));
        }
        if (init?.method === "POST" && url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
        if (url.includes("/message")) return Promise.resolve(json([]));
        if (url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(json({ id: "ses_1" }));
      },
      { permissionMode: "manual" }
    );
    try {
      await waitFor(() => h.events.some((e) => e.type === "approval.request"));
      const approval = h.events.find(
        (e): e is Extract<ThreadEvent, { type: "approval.request" }> => e.type === "approval.request"
      );
      expect(approval?.request.requestId).toBe("per_2");
      expect(approval?.request.permission).toBe("bash");
      await h.driver.respondToApproval("per_2", "accept");
      expect(h.permissionReplies.length).toBeGreaterThan(0);
      expect(h.permissionReplies.every((url) => url.includes("ses_child"))).toBe(true);
      expect(h.events.some((e) => e.type === "approval.resolved" && e.requestId === "per_2")).toBe(true);
    } finally {
      h.driver.dispose();
    }
  });

  it("walks the parent chain for nested subagent permissions", async () => {
    const h = startHarness(
      (url, init) => {
        if (url.endsWith("/event")) {
          return Promise.resolve(
            sseStream([
              sessionCreated("ses_child", "ses_1"),
              sessionCreated("ses_grand", "ses_child"),
              childAsked("per_3", "ses_grand")
            ])
          );
        }
        if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
        if (init?.method === "POST" && url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
        if (url.includes("/message")) return Promise.resolve(json([]));
        if (url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(json({ id: "ses_1" }));
      },
      { permissionMode: "manual" }
    );
    try {
      await waitFor(() => h.events.some((e) => e.type === "approval.request"));
      const approval = h.events.find(
        (e): e is Extract<ThreadEvent, { type: "approval.request" }> => e.type === "approval.request"
      );
      expect(approval?.request.requestId).toBe("per_3");
    } finally {
      h.driver.dispose();
    }
  });

  it("resolves child lineage through the session API when the created event was missed", async () => {
    const h = startHarness(
      (url, init) => {
        if (url.endsWith("/event")) return Promise.resolve(sse(childAsked("per_4", "ses_child")));
        if (url.endsWith("/session/ses_child") && init?.method !== "POST") {
          return Promise.resolve(json({ id: "ses_child", parentID: "ses_1" }));
        }
        if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
        if (init?.method === "POST" && url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
        if (url.includes("/message")) return Promise.resolve(json([]));
        if (url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(json({ id: "ses_1" }));
      },
      { permissionMode: "manual" }
    );
    try {
      await waitFor(() => h.events.some((e) => e.type === "approval.request"));
      const approval = h.events.find(
        (e): e is Extract<ThreadEvent, { type: "approval.request" }> => e.type === "approval.request"
      );
      expect(approval?.request.requestId).toBe("per_4");
    } finally {
      h.driver.dispose();
    }
  });

  it("ignores permissions for sessions outside the turn's lineage", async () => {
    const h = startHarness(
      (url, init) => {
        if (url.endsWith("/event")) return Promise.resolve(sse(childAsked("per_5", "ses_other")));
        if (url.endsWith("/session/ses_other") && init?.method !== "POST") {
          return Promise.resolve(json({ id: "ses_other" }));
        }
        if (init?.method === "POST" && url.includes("/message")) return new Promise<Response>(() => {});
        if (init?.method === "POST" && url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
        if (url.includes("/message")) return Promise.resolve(json([]));
        if (url.includes("/permission")) return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(json({ id: "ses_1" }));
      },
      { permissionMode: "manual" }
    );
    try {
      await sleep(300);
      expect(h.events.filter((e) => e.type === "approval.request")).toEqual([]);
      expect(h.permissionReplies).toEqual([]);
    } finally {
      h.driver.dispose();
    }
  });

  it("auto-approves subagent permissions in bypass mode", async () => {
    const h = startHarness((url, init) => {
      if (url.endsWith("/event")) {
        return Promise.resolve(sseStream([sessionCreated("ses_child", "ses_1"), childAsked("per_6", "ses_child")]));
      }
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
      expect(h.permissionReplies.every((url) => url.includes("ses_child"))).toBe(true);
    } finally {
      h.driver.dispose();
    }
  });
});
