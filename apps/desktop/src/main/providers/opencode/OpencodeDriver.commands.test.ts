import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import { join } from "node:path";
import { OpencodeDriver } from "./OpencodeDriver.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Route = (call: Call, init: RequestInit | undefined) => Promise<Response> | Response | undefined;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
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

const HISTORY = [
  { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "first" }] },
  { info: { id: "msg_a1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "one" }] },
  { info: { id: "msg_u2", role: "user" }, parts: [{ type: "text", text: "second" }] },
  { info: { id: "msg_a2", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "two" }] }
];

function stubFetch(route: Route, sse?: Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined
      };
      calls.push(call);
      if (url.endsWith("/event")) return sse ?? { ok: false, status: 500, body: null };
      const routed = await route(call, init);
      if (routed) return routed;
      if (call.method === "GET" && url.includes("/message")) return json(HISTORY);
      return json({ id: "ses_1" });
    })
  );
  return calls;
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

function posts(calls: Call[], suffix: string): Call[] {
  return calls.filter((c) => c.method === "POST" && new URL(c.url).pathname.endsWith(suffix));
}

function ofType<T extends ThreadEvent["type"]>(events: ThreadEvent[], type: T): Array<Extract<ThreadEvent, { type: T }>> {
  return events.filter((e): e is Extract<ThreadEvent, { type: T }> => e.type === type);
}

const BASE = { sessionId: "sess_1", cwd: "C:\\proj", resumeCursor: "ses_1", model: "anthropic/claude-opus-5" };

describe("OpencodeDriver command dispatch", () => {
  it("lists builtins and server commands from GET /command", async () => {
    const calls = stubFetch((call) =>
      new URL(call.url).pathname === "/command"
        ? json([{ name: "init", description: "guided setup", source: "command", hints: ["$ARGUMENTS"] }])
        : undefined
    );
    const driver = startDriver([]);
    try {
      const commands = await driver.listCommands("C:\\proj");
      expect(commands.map((c) => c.name)).toEqual(["compact", "undo", "redo", "init"]);
      expect(calls.some((c) => c.method === "GET" && new URL(c.url).pathname === "/command")).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("keeps the builtins and warns when the command listing fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch((call) => (new URL(call.url).pathname === "/command" ? json({ error: "boom" }, 500) : undefined));
    const driver = startDriver([]);
    try {
      const commands = await driver.listCommands("C:\\proj");
      expect(commands.map((c) => c.name)).toEqual(["compact", "undo", "redo"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("opencode command list failed: 500");
      expect(String(warn.mock.calls[0]?.[0])).toContain("boom");
    } finally {
      warn.mockRestore();
      driver.dispose();
    }
  });

  it("keeps the builtins when the server is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = {
      ensure: async () => {
        throw new Error("opencode serve failed to start");
      },
      beginTurn: () => {},
      endTurn: () => {},
      invalidate: () => {},
      dispose: () => {}
    };
    const driver = new OpencodeDriver(
      () => {},
      () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
      pool as unknown as OpencodeServerPool
    );
    try {
      const commands = await driver.listCommands("C:\\proj");
      expect(commands.map((c) => c.name)).toEqual(["compact", "undo", "redo"]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      driver.dispose();
    }
  });

  it("compacts through /summarize with the split model and finishes once", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    const calls = stubFetch((call) => (call.url.endsWith("/summarize") ? json(true) : undefined), sse.response);
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ ...BASE, prompt: "/compact", command: { name: "compact", args: "" } });
      await waitFor(() => ofType(events, "turn.done").length === 1);
      expect(posts(calls, "/summarize")[0]?.body).toEqual({ providerID: "anthropic", modelID: "claude-opus-5" });
      expect(posts(calls, "/message")).toEqual([]);
      expect(ofType(events, "assistant.delta").map((e) => e.text.trim())).toEqual(["Session compacted."]);
      sse.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
      await sleep(100);
      expect(ofType(events, "turn.done")).toHaveLength(1);
      expect(ofType(events, "turn.done")[0]).toMatchObject({ turnId, isError: false });
    } finally {
      driver.dispose();
    }
  });

  it("lets the tracker finish a compaction without a second turn.done", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    let release: (res: Response) => void = () => {};
    stubFetch(
      (call) => (call.url.endsWith("/summarize") ? new Promise<Response>((r) => (release = r)) : undefined),
      sse.response
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/compact", command: { name: "compact", args: "" } });
      await sleep(100);
      sse.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
      await waitFor(() => ofType(events, "turn.done").length === 1);
      release(json(true));
      await sleep(100);
      expect(ofType(events, "turn.done")).toHaveLength(1);
      expect(ofType(events, "assistant.delta")).toEqual([]);
      expect(ofType(events, "turn.error")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("prefixes the compact notice with a blank line when assistant text already streamed for the turn", async () => {
    const events: ThreadEvent[] = [];
    const sse = controllableSse();
    let release: (res: Response) => void = () => {};
    const calls = stubFetch(
      (call) => (call.url.endsWith("/summarize") ? new Promise<Response>((r) => (release = r)) : undefined),
      sse.response
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/compact", command: { name: "compact", args: "" } });
      await waitFor(() => posts(calls, "/summarize").length === 1);
      sse.push({
        type: "message.part.delta",
        properties: { sessionID: "ses_1", field: "text", delta: "Working on it...", partID: "p1" }
      });
      await sleep(50);
      release(json(true));
      await waitFor(() => ofType(events, "turn.done").length === 1);
      expect(ofType(events, "assistant.delta").map((e) => e.text)).toEqual([
        "Working on it...",
        "\n\nSession compacted."
      ]);
    } finally {
      driver.dispose();
    }
  });

  it("refuses to compact without a model", async () => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch(() => undefined);
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, model: undefined, prompt: "/compact", command: { name: "compact", args: "" } });
      await waitFor(() => ofType(events, "turn.error").length === 1);
      expect(ofType(events, "turn.error")[0]?.message).toBe("Pick a model before compacting");
      expect(posts(calls, "/summarize")).toEqual([]);
      expect(ofType(events, "turn.done")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("interrupts a running compaction without emitting a result", async () => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch((call, init) => (call.url.endsWith("/summarize") ? hang(init) : undefined));
    const driver = startDriver(events);
    try {
      const { turnId } = driver.startTurn({ ...BASE, prompt: "/compact", command: { name: "compact", args: "" } });
      await waitFor(() => posts(calls, "/summarize").length === 1);
      driver.interrupt(turnId);
      await sleep(100);
      expect(posts(calls, "/abort")).toHaveLength(1);
      expect(ofType(events, "turn.done")).toEqual([]);
      expect(ofType(events, "turn.error")).toEqual([]);
      expect(ofType(events, "assistant.delta")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("undoes by reverting the last user message", async () => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch((call) => (call.url.endsWith("/revert") ? json({ id: "ses_1" }) : undefined));
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/undo", command: { name: "undo", args: "" } });
      await waitFor(() => ofType(events, "turn.done").length === 1);
      expect(posts(calls, "/revert").map((c) => c.body)).toEqual([{ messageID: "msg_u2" }]);
      expect(ofType(events, "assistant.delta")).toHaveLength(1);
      await sleep(100);
      expect(ofType(events, "turn.done")).toHaveLength(1);
    } finally {
      driver.dispose();
    }
  });

  it("undoes past an existing revert point", async () => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch((call) => {
      const path = new URL(call.url).pathname;
      if (call.url.endsWith("/revert")) return json({ id: "ses_1" });
      if (call.method === "GET" && path === "/session/ses_1") return json({ id: "ses_1", revert: { messageID: "msg_u2" } });
      return undefined;
    });
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/undo", command: { name: "undo", args: "" } });
      await waitFor(() => ofType(events, "turn.done").length === 1);
      expect(posts(calls, "/revert").map((c) => c.body)).toEqual([{ messageID: "msg_u1" }]);
    } finally {
      driver.dispose();
    }
  });

  it.each([
    ["compact", "Nothing to compact yet"],
    ["undo", "Nothing to undo yet"],
    ["redo", "Nothing to redo yet"]
  ])("throws synchronously for /%s on a thread without an opencode session, before touching the server", async (name, message) => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch(() => undefined);
    const ensure = vi.fn(async () => ({ port: 41234, authHeader: "auth" }));
    const pool = { ensure, beginTurn: () => {}, endTurn: () => {}, invalidate: () => {}, probe: async () => true, dispose: () => {} };
    const driver = new OpencodeDriver(
      (e) => {
        events.push(e);
      },
      () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
      pool as unknown as OpencodeServerPool
    );
    try {
      expect(() =>
        driver.startTurn({ ...BASE, resumeCursor: undefined, prompt: `/${name}`, command: { name, args: "" } })
      ).toThrow(message);
      await sleep(50);
      expect(events).toEqual([]);
      expect(ensure).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("fails undo when there is no user message", async () => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch((call) =>
      call.method === "GET" && new URL(call.url).pathname === "/session/ses_1/message" ? json([]) : undefined
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/undo", command: { name: "undo", args: "" } });
      await waitFor(() => ofType(events, "turn.error").length === 1);
      expect(ofType(events, "turn.error")[0]?.message).toBe("Nothing to undo");
      expect(posts(calls, "/revert")).toEqual([]);
      expect(ofType(events, "turn.done")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("fails undo with status and body when /revert is rejected", async () => {
    const events: ThreadEvent[] = [];
    stubFetch((call) => (call.url.endsWith("/revert") ? json({ message: "session busy" }, 409) : undefined));
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/undo", command: { name: "undo", args: "" } });
      await waitFor(() => ofType(events, "turn.error").length === 1);
      const message = ofType(events, "turn.error")[0]?.message ?? "";
      expect(message).toContain("opencode undo failed: 409");
      expect(message).toContain("session busy");
      expect(ofType(events, "assistant.delta")).toEqual([]);
      expect(ofType(events, "turn.done")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("redoes through /unrevert when the session is reverted", async () => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/unrevert")) return json({ id: "ses_1" });
      if (call.method === "GET" && new URL(call.url).pathname === "/session/ses_1") {
        return json({ id: "ses_1", revert: { messageID: "msg_u2" } });
      }
      return undefined;
    });
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/redo", command: { name: "redo", args: "" } });
      await waitFor(() => ofType(events, "turn.done").length === 1);
      expect(posts(calls, "/unrevert")).toHaveLength(1);
      expect(posts(calls, "/revert")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("fails redo when nothing is reverted", async () => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch(() => undefined);
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/redo", command: { name: "redo", args: "" } });
      await waitFor(() => ofType(events, "turn.error").length === 1);
      expect(ofType(events, "turn.error")[0]?.message).toBe("Nothing to redo");
      expect(posts(calls, "/unrevert")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("dispatches server commands through POST /command", async () => {
    const events: ThreadEvent[] = [];
    const calls = stubFetch((call) =>
      call.method === "POST" && call.url.endsWith("/command")
        ? json({ info: { id: "msg_a3", role: "assistant" }, parts: [] })
        : undefined
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({
        ...BASE,
        variant: "high",
        prompt: "/review main",
        command: { name: "review", args: "main" },
        attachments: ["shot.png"]
      });
      await waitFor(() => ofType(events, "turn.done").length === 1);
      expect(posts(calls, "/session/ses_1/command").map((c) => c.body)).toEqual([
        {
          command: "review",
          arguments: "main",
          model: "anthropic/claude-opus-5",
          variant: "high",
          parts: [{ type: "file", mime: "image/png", url: join(BASE.cwd, "shot.png") }]
        }
      ]);
      expect(posts(calls, "/message")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("fails a rejected server command with status and body", async () => {
    const events: ThreadEvent[] = [];
    stubFetch((call) =>
      call.method === "POST" && call.url.endsWith("/command") ? json({ message: "unknown command" }, 400) : undefined
    );
    const driver = startDriver(events);
    try {
      driver.startTurn({ ...BASE, prompt: "/nope", command: { name: "nope", args: "" } });
      await waitFor(() => ofType(events, "turn.error").length === 1);
      const message = ofType(events, "turn.error")[0]?.message ?? "";
      expect(message).toContain("opencode command /nope failed: 400");
      expect(message).toContain("unknown command");
      expect(ofType(events, "turn.done")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });
});
