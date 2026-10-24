import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ServerCallError, ServerClient } from "@cw-code/client";
import type { ClientMessage, ServerMessage } from "@cw-code/contracts";
import { CLOSE_HELLO_TIMEOUT, CLOSE_PROTOCOL_MISMATCH, CLOSE_SERVER_STOPPING, CLOSE_UNAUTHORIZED, PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { Router, type CallContext } from "./Router.js";
import { WsServer, type WsServerOptions } from "./WsServer.js";

const TOKEN = "t".repeat(64);
const servers: WsServer[] = [];
const clients: ServerClient[] = [];
const sockets: WebSocket[] = [];

interface RawSocket {
  ws: WebSocket;
  messages: ServerMessage[];
  closed: Promise<number>;
  opened: Promise<void>;
  send(message: ClientMessage | string): void;
  nextMessage(): Promise<ServerMessage>;
}

function startServer(overrides: Partial<WsServerOptions> = {}): { server: WsServer; router: Router; url: string } {
  const router = overrides.router ?? new Router();
  const server = new WsServer({ host: "127.0.0.1", port: 0, token: TOKEN, version: "9.9.9", router, ...overrides });
  servers.push(server);
  return { server, router, url: server.start().url };
}

function newClient(url: string, token = TOKEN): ServerClient {
  const client = new ServerClient({ endpoint: { url, token }, client: "desktop-ui" });
  clients.push(client);
  return client;
}

function rawSocket(url: string): RawSocket {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  const waiting: Array<(message: ServerMessage) => void> = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    const next = waiting.shift();
    if (next) next(message);
    else messages.push(message);
  };
  return {
    ws,
    messages,
    opened: new Promise((resolve) => {
      ws.onopen = () => resolve();
    }),
    closed: new Promise((resolve) => {
      ws.onclose = (event) => resolve(event.code);
    }),
    send: (message) => ws.send(typeof message === "string" ? message : JSON.stringify(message)),
    nextMessage: () => {
      const queued = messages.shift();
      return queued ? Promise.resolve(queued) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

async function authenticatedSocket(url: string): Promise<RawSocket> {
  const socket = rawSocket(url);
  await socket.opened;
  socket.send({ t: "hello", token: TOKEN, protocol: PROTOCOL_VERSION, client: "web" });
  const welcome = await socket.nextMessage();
  expect(welcome.t).toBe("welcome");
  return socket;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const ws of sockets.splice(0)) ws.close();
  for (const server of servers.splice(0)) await server.stop();
});

describe("WsServer", () => {
  test("completes hello and round-trips a call", async () => {
    const { router, url } = startServer();
    router.handle("echo", (params, ctx) => ({ params, client: ctx.client }));
    const client = newClient(url);
    const welcome = await client.connect();
    expect(welcome.serverVersion).toBe("9.9.9");
    expect(welcome.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await client.call("echo", { a: 1 })).toEqual({ params: { a: 1 }, client: "desktop-ui" });
  });

  test("resolves null for handlers that return nothing", async () => {
    const { router, url } = startServer();
    router.handle("noop", () => undefined);
    const client = newClient(url);
    await client.connect();
    expect(await client.call("noop")).toBeNull();
  });

  test("reports handler errors with message and code", async () => {
    const { router, url } = startServer();
    router.handle("fail", () => {
      throw Object.assign(new Error("nope"), { code: "E_NOPE" });
    });
    const client = newClient(url);
    await client.connect();
    const error = await client.call("fail").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerCallError);
    expect((error as ServerCallError).message).toBe("nope");
    expect((error as ServerCallError).code).toBe("E_NOPE");
  });

  test("reports unknown methods", async () => {
    const { url } = startServer();
    const client = newClient(url);
    await client.connect();
    const error = await client.call("missing").catch((e: unknown) => e);
    expect((error as ServerCallError).code).toBe("unknown-method");
    expect((error as ServerCallError).message).toBe("unknown method 'missing'");
  });

  test("passes the caller context to handlers", async () => {
    const { router, url } = startServer();
    const seen: CallContext[] = [];
    router.handle("who", (_params, ctx) => {
      seen.push(ctx);
      return null;
    });
    const client = newClient(url);
    const welcome = await client.connect();
    await client.call("who");
    expect(seen).toEqual([{ clientId: welcome.clientId, client: "desktop-ui" }]);
  });

  test("fire-and-forget reaches the handler and produces no result", async () => {
    const { router, url } = startServer();
    const received: unknown[] = [];
    router.handle("log", (params) => {
      received.push(params);
    });
    const socket = await authenticatedSocket(url);
    socket.send({ t: "call", method: "log", params: "hello" });
    await sleep(100);
    expect(received).toEqual(["hello"]);
    expect(socket.messages).toEqual([]);
  });

  test("fire-and-forget through the client reaches the handler", async () => {
    const { router, url } = startServer();
    const received = new Promise<unknown>((resolve) => router.handle("ping", (params) => resolve(params)));
    const client = newClient(url);
    await client.connect();
    client.send("ping", { n: 1 });
    expect(await received).toEqual({ n: 1 });
  });

  test("failures of fire-and-forget calls are only logged", async () => {
    const { url } = startServer();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const socket = await authenticatedSocket(url);
      socket.send({ t: "call", method: "ghost" });
      await sleep(100);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("ghost"))).toBe(true);
      expect(socket.messages).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects a bad token with unauthorized", async () => {
    const { url } = startServer();
    const error = await newClient(url, "wrong").connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerCallError);
    expect((error as ServerCallError).code).toBe("unauthorized");
  });

  test("rejects a token of a different length without throwing", async () => {
    const { url } = startServer();
    const socket = rawSocket(url);
    await socket.opened;
    socket.send({ t: "hello", token: "short", protocol: PROTOCOL_VERSION, client: "web" });
    expect(await socket.closed).toBe(CLOSE_UNAUTHORIZED);
  });

  test("closes a wrong protocol version with 4426", async () => {
    const { url } = startServer();
    const socket = rawSocket(url);
    await socket.opened;
    socket.send({ t: "hello", token: TOKEN, protocol: 999, client: "web" });
    expect(await socket.closed).toBe(CLOSE_PROTOCOL_MISMATCH);
  });

  test("closes a call sent before hello with unauthorized", async () => {
    const { router, url } = startServer();
    let called = false;
    router.handle("x", () => {
      called = true;
    });
    const socket = rawSocket(url);
    await socket.opened;
    socket.send({ t: "call", id: 1, method: "x" });
    expect(await socket.closed).toBe(CLOSE_UNAUTHORIZED);
    expect(called).toBe(false);
  });

  test("closes a silent socket with 4408", async () => {
    const { url } = startServer({ helloTimeoutMs: 100 });
    const socket = rawSocket(url);
    expect(await socket.closed).toBe(CLOSE_HELLO_TIMEOUT);
  });

  test("keeps an authenticated socket open past the hello timeout", async () => {
    const { url } = startServer({ helloTimeoutMs: 100 });
    const socket = await authenticatedSocket(url);
    await sleep(250);
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("ignores malformed messages after hello", async () => {
    const { router, url } = startServer();
    router.handle("ok", () => "fine");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const socket = await authenticatedSocket(url);
      socket.send("{not json");
      socket.send(JSON.stringify({ t: "bogus" }));
      socket.send(JSON.stringify({ t: "call", id: "x", method: "ok" }));
      socket.send({ t: "call", id: 5, method: "ok" });
      expect(await socket.nextMessage()).toEqual({ t: "result", id: 5, ok: true, value: "fine" });
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("broadcast reaches authenticated clients but not unauthenticated sockets", async () => {
    const { server, url } = startServer({ helloTimeoutMs: 5000 });
    const client = newClient(url);
    const received = new Promise<unknown>((resolve) => client.on("tick", resolve));
    await client.connect();
    const silent = rawSocket(url);
    await silent.opened;
    server.broadcast("tick", { n: 7 });
    expect(await received).toEqual({ n: 7 });
    await sleep(100);
    expect(silent.messages).toEqual([]);
  });

  test("onClientClosed fires with the context of an authenticated client", async () => {
    const { server, url } = startServer();
    const closed = new Promise<CallContext>((resolve) => server.onClientClosed(resolve));
    const client = newClient(url);
    const welcome = await client.connect();
    expect(server.clients()).toEqual([{ clientId: welcome.clientId, client: "desktop-ui" }]);
    client.close();
    expect(await closed).toEqual({ clientId: welcome.clientId, client: "desktop-ui" });
    expect(server.clients()).toEqual([]);
  });

  test("onClientClosed ignores clients that never completed hello and supports unsubscribe", async () => {
    const { server, url } = startServer();
    const calls: CallContext[] = [];
    const off = server.onClientClosed((ctx) => calls.push(ctx));
    const silent = rawSocket(url);
    await silent.opened;
    silent.ws.close();
    await silent.closed;
    await sleep(50);
    expect(calls).toEqual([]);
    off();
    const authenticated = await authenticatedSocket(url);
    authenticated.ws.close();
    await authenticated.closed;
    await sleep(50);
    expect(calls).toEqual([]);
  });

  test("stop closes clients with 4503", async () => {
    const { server, url } = startServer();
    const socket = await authenticatedSocket(url);
    await server.stop();
    expect(await socket.closed).toBe(CLOSE_SERVER_STOPPING);
  });

  test("a send to a closed socket does not throw", async () => {
    const { server, router, url } = startServer();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    router.handle("slow", () => gate);
    const socket = await authenticatedSocket(url);
    socket.send({ t: "call", id: 1, method: "slow" });
    await sleep(50);
    socket.ws.close();
    await socket.closed;
    await sleep(50);
    expect(() => release()).not.toThrow();
    await sleep(50);
    expect(() => server.broadcast("late", null)).not.toThrow();
  });

  test("serves 404 for other paths and 426 for plain requests on /ws", async () => {
    const { url } = startServer();
    const base = url.replace("ws://", "http://");
    expect((await fetch(base.replace(/\/ws$/, "/other"))).status).toBe(404);
    expect((await fetch(base)).status).toBe(426);
  });

  test("start reports the bound port and url, and refuses a second start", () => {
    const { server, url } = startServer();
    const port = Number(new URL(url).port);
    expect(port).toBeGreaterThan(0);
    expect(url).toBe(`ws://127.0.0.1:${port}/ws`);
    expect(() => server.start()).toThrow("already started");
  });
});
