import { afterEach, describe, expect, it, vi } from "bun:test";
import { stubGlobal, unstubAllGlobals, waitFor } from "../../../tests/testing.js";
import type { AppSettings, ThreadEvent, TurnRequest } from "@cw-code/contracts";
import { OpencodeDriver } from "./OpencodeDriver.js";
import type { OpencodeProtocolVersion } from "./opencodeProtocol.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

const SID = "ses_root";
const CWD = "C:\\proj";
const AGENT = { mcpUrl: "http://127.0.0.1:1/mcp", token: "agent-token" };

interface DriverInternals {
  agentSecret: string;
  authorizeBridge(sessionID: string, bearer: string | null): boolean;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
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

function stubV2Server(sse: ReturnType<typeof controllableSse>, prompts: unknown[]): void {
  stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/api/event") return Promise.resolve(sse.response);
      if (path === "/api/session/active") return Promise.resolve(json({ data: {} }));
      if (init?.method === "POST" && path.endsWith("/prompt")) {
        prompts.push(JSON.parse(String(init.body)));
        return Promise.resolve(json({ data: { id: "msg_u" } }));
      }
      if (path.endsWith("/message")) return Promise.resolve(json({ data: [], cursor: {} }));
      if (path.endsWith("/form") || path === "/api/permission/request") return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: { id: SID } }));
    })
  );
}

function makeDriver(events: ThreadEvent[], protocol: OpencodeProtocolVersion = "v2"): OpencodeDriver {
  const pool = {
    ensure: async () => ({ port: 41234, authHeader: "auth", protocol }),
    beginTurn: () => {},
    endTurn: () => {},
    invalidate: () => {},
    probe: async () => true,
    dispose: () => {}
  };
  return new OpencodeDriver((event) => events.push(event), () => ({ opencodeBinaryPath: "opencode" }) as AppSettings, pool as unknown as OpencodeServerPool);
}

function internals(driver: OpencodeDriver): DriverInternals {
  return driver as unknown as DriverInternals;
}

async function startTracked(driver: OpencodeDriver, prompts: unknown[], request: Partial<TurnRequest> = {}): Promise<string> {
  const { turnId } = driver.startTurn({ sessionId: "s1", cwd: CWD, prompt: "hello", resumeCursor: SID, agent: AGENT, ...request });
  await waitFor(() => expect(prompts).toHaveLength(1));
  return turnId;
}

afterEach(() => {
  unstubAllGlobals();
});

describe("OpencodeDriver agent identity", () => {
  it("maps an in-flight opencode session presenting the secret to its cw-code session", async () => {
    const prompts: unknown[] = [];
    stubV2Server(controllableSse(), prompts);
    const driver = makeDriver([]);
    try {
      await startTracked(driver, prompts);
      const secret = internals(driver).agentSecret;
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(driver.resolveAgentSession(secret, SID)).toEqual({ sessionId: "s1" });
      expect(driver.resolveAgentSession("wrong", SID)).toBeNull();
      expect(driver.resolveAgentSession(`${secret}x`, SID)).toBeNull();
      expect(driver.resolveAgentSession(secret, "ses_unknown")).toBeNull();
    } finally {
      driver.dispose();
    }
  });

  it("maps a child session to its parent's turn", async () => {
    const prompts: unknown[] = [];
    const sse = controllableSse();
    stubV2Server(sse, prompts);
    const driver = makeDriver([]);
    try {
      await startTracked(driver, prompts);
      const secret = internals(driver).agentSecret;
      sse.push("session.created", { sessionID: "ses_child", parentID: SID });
      sse.push("session.created", { sessionID: "ses_grandchild", parentID: "ses_child" });
      await waitFor(() => expect(driver.resolveAgentSession(secret, "ses_grandchild")).toEqual({ sessionId: "s1" }));
      expect(driver.resolveAgentSession(secret, "ses_child")).toEqual({ sessionId: "s1" });
    } finally {
      driver.dispose();
    }
  });

  it("stops resolving once the turn is no longer in flight", async () => {
    const prompts: unknown[] = [];
    stubV2Server(controllableSse(), prompts);
    const driver = makeDriver([]);
    try {
      const turnId = await startTracked(driver, prompts);
      const secret = internals(driver).agentSecret;
      expect(driver.resolveAgentSession(secret, SID)).not.toBeNull();
      driver.interrupt(turnId);
      await waitFor(() => expect(driver.resolveAgentSession(secret, SID)).toBeNull());
    } finally {
      driver.dispose();
    }
  });

  it("refuses turns started without agent access", async () => {
    const prompts: unknown[] = [];
    stubV2Server(controllableSse(), prompts);
    const driver = makeDriver([]);
    try {
      await startTracked(driver, prompts, { sessionId: "title:s1", agent: undefined });
      expect(driver.resolveAgentSession(internals(driver).agentSecret, SID)).toBeNull();
    } finally {
      driver.dispose();
    }
  });

  it("gives every driver its own secret", () => {
    const first = makeDriver([]);
    const second = makeDriver([]);
    expect(internals(first).agentSecret).not.toBe(internals(second).agentSecret);
    first.dispose();
    second.dispose();
  });
});

describe("OpencodeDriver ask bridge authorization", () => {
  it("requires the secret for v2 sessions", async () => {
    const prompts: unknown[] = [];
    stubV2Server(controllableSse(), prompts);
    const driver = makeDriver([]);
    try {
      await startTracked(driver, prompts);
      const { agentSecret, authorizeBridge } = internals(driver);
      expect(authorizeBridge.call(driver, SID, null)).toBe(false);
      expect(authorizeBridge.call(driver, SID, "wrong")).toBe(false);
      expect(authorizeBridge.call(driver, SID, agentSecret)).toBe(true);
      expect(authorizeBridge.call(driver, "ses_unknown", null)).toBe(false);
    } finally {
      driver.dispose();
    }
  });
});
