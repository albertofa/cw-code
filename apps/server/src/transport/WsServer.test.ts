import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ServerCallError, ServerClient } from "@cw-code/client";
import type { ClientKind, ClientMessage, ServerMessage } from "@cw-code/contracts";
import {
  CLOSE_CLIENT_TOO_SLOW,
  CLOSE_HELLO_TIMEOUT,
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_SERVER_STOPPING,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION
} from "@cw-code/shared/protocol";
import { connect, type Socket } from "node:net";
import { Router, type CallContext, type ClientAuth } from "./Router.js";
import { sendRaw, WsServer, wsUrl, type FrameSink, type WsServerOptions } from "./WsServer.js";

const TOKEN = "t".repeat(64);
const OWNER: ClientAuth = { kind: "owner" };
const servers: WsServer[] = [];
const clients: ServerClient[] = [];
const sockets: WebSocket[] = [];
const tcpSockets: Socket[] = [];

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
  const server = new WsServer({ host: "127.0.0.1", port: 0, authorize: (token) => (token === TOKEN ? OWNER : null), version: "9.9.9", router, ...overrides });
  servers.push(server);
  return { server, router, url: server.start().url };
}

function newClient(url: string, token = TOKEN, kind: ClientKind = "desktop-ui"): ServerClient {
  const client = new ServerClient({ endpoint: { url, token }, client: kind });
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

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, Buffer.alloc(4), payload]);
}

function stalledClient(url: string): Promise<Socket> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      const headers = [
        "GET /ws HTTP/1.1",
        `Host: ${hostname}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13"
      ];
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
      socket.write(maskedTextFrame(JSON.stringify({ t: "hello", token: TOKEN, protocol: PROTOCOL_VERSION, client: "web" })));
    });
    tcpSockets.push(socket);
    let received = "";
    const onData = (chunk: Buffer): void => {
      received += chunk.toString("latin1");
      if (!received.includes('"t":"welcome"')) return;
      socket.off("data", onData);
      socket.pause();
      resolve(socket);
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function fakeSink(result: number): FrameSink & { closes: Array<[number | undefined, string | undefined]> } {
  const closes: Array<[number | undefined, string | undefined]> = [];
  return {
    readyState: 1,
    send: () => result,
    close: (code?: number, reason?: string) => {
      closes.push([code, reason]);
    },
    closes
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const ws of sockets.splice(0)) ws.close();
  for (const socket of tcpSockets.splice(0)) socket.destroy();
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

  test("reports whether a client is connected", async () => {
    const { server, url } = startServer();
    const client = newClient(url);
    const { clientId } = await client.connect();
    expect(server.isConnected(clientId)).toBe(true);
    expect(server.isConnected("unknown")).toBe(false);
    const closed = new Promise<void>((resolve) => {
      server.onClientClosed(() => resolve());
    });
    client.close();
    await closed;
    expect(server.isConnected(clientId)).toBe(false);
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
    expect(seen).toEqual([{ clientId: welcome.clientId, client: "desktop-ui", auth: OWNER }]);
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

  test("accepts owner and device tokens and rejects unknown ones", async () => {
    const auths: unknown[] = [];
    const { router, url } = startServer({
      authorize: (token) => (token === TOKEN ? OWNER : token === "device-token" ? { kind: "device", deviceId: "dev_1" } : null)
    });
    router.handle("whoami", (_params, ctx) => ctx.auth);
    const owner = newClient(url);
    const device = newClient(url, "device-token", "web");
    await owner.connect();
    await device.connect();
    auths.push(await owner.call("whoami"), await device.call("whoami"));
    expect(auths).toEqual([{ kind: "owner" }, { kind: "device", deviceId: "dev_1" }]);
    const error = await newClient(url, "unknown").connect().catch((e: unknown) => e);
    expect((error as ServerCallError).code).toBe("unauthorized");
  });

  test("rejects a device token that claims a desktop client kind", async () => {
    const { url } = startServer({ authorize: (token) => (token === "device-token" ? { kind: "device", deviceId: "dev_1" } : null) });
    for (const kind of ["desktop-ui", "desktop-shell"] as const) {
      const socket = rawSocket(url);
      await socket.opened;
      socket.send({ t: "hello", token: "device-token", protocol: PROTOCOL_VERSION, client: kind });
      expect(await socket.closed).toBe(CLOSE_UNAUTHORIZED);
    }
    const web = newClient(url, "device-token", "web");
    await web.connect();
  });

  test("checks the protocol version before authorizing and bounds the token length", async () => {
    const seen: string[] = [];
    const { url } = startServer({
      authorize: (token) => {
        seen.push(token);
        return OWNER;
      }
    });
    const mismatch = rawSocket(url);
    await mismatch.opened;
    mismatch.send({ t: "hello", token: TOKEN, protocol: 999, client: "web" });
    expect(await mismatch.closed).toBe(CLOSE_PROTOCOL_MISMATCH);
    const oversize = rawSocket(url);
    await oversize.opened;
    oversize.send({ t: "hello", token: "x".repeat(257), protocol: PROTOCOL_VERSION, client: "web" });
    expect(await oversize.closed).toBe(CLOSE_UNAUTHORIZED);
    expect(seen).toEqual([]);
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

  test("sendTo reaches only the named authenticated clients", async () => {
    const { server, url } = startServer();
    const target = newClient(url);
    const other = newClient(url);
    const otherSaw: unknown[] = [];
    other.on("direct", (payload) => otherSaw.push(payload));
    const received = new Promise<unknown>((resolve) => target.on("direct", resolve));
    const [targetWelcome] = await Promise.all([target.connect(), other.connect()]);
    server.sendTo([targetWelcome.clientId, "unknown-client"], "direct", { n: 1 });
    expect(await received).toEqual({ n: 1 });
    await sleep(100);
    expect(otherSaw).toEqual([]);
  });

  test("closeClients closes only the matching sockets and reports the count", async () => {
    const { server, url } = startServer();
    const keep = await authenticatedSocket(url);
    const drop = rawSocket(url);
    await drop.opened;
    drop.send({ t: "hello", token: TOKEN, protocol: PROTOCOL_VERSION, client: "desktop-shell" });
    await drop.nextMessage();
    expect(server.closeClients((ctx) => ctx.client === "desktop-shell", 4321, "revoked")).toBe(1);
    expect(await drop.closed).toBe(4321);
    expect(keep.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("broadcast skips clients the filter rejects", async () => {
    const { server, url } = startServer();
    const ui = newClient(url);
    const shell = newClient(url, TOKEN, "desktop-shell");
    const shellSaw: unknown[] = [];
    shell.on("pty.data", (payload) => shellSaw.push(payload));
    const uiSaw = new Promise<unknown>((resolve) => ui.on("pty.data", resolve));
    await Promise.all([ui.connect(), shell.connect()]);
    server.broadcast("pty.data", "chunk", (ctx) => ctx.client !== "desktop-shell");
    expect(await uiSaw).toBe("chunk");
    await sleep(100);
    expect(shellSaw).toEqual([]);
  });

  test("closes a client that stops reading instead of silently dropping messages", async () => {
    const { server, url } = startServer();
    const closed = new Promise<CallContext>((resolve) => server.onClientClosed(resolve));
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await stalledClient(url);
      expect(server.clients()).toHaveLength(1);
      const chunk = "x".repeat(1024 * 1024);
      for (let i = 0; i < 256 && server.clients().length > 0; i++) server.broadcast("pty.data", chunk);
      expect(server.clients()).toEqual([]);
      expect((await closed).client).toBe("web");
      expect(warn.mock.calls.some((call) => String(call[0]).includes("too slow"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("sendRaw closes a socket whose frame was dropped and keeps a backpressured one", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dropped = fakeSink(0);
      sendRaw(dropped, "frame");
      expect(dropped.closes).toEqual([[CLOSE_CLIENT_TOO_SLOW, "client too slow"]]);
      for (const result of [-1, 5]) {
        const sink = fakeSink(result);
        sendRaw(sink, "frame");
        expect(sink.closes).toEqual([]);
      }
    } finally {
      warn.mockRestore();
    }
  });

  test("onClientAccepted fires only for fully accepted hellos", async () => {
    const { server, url } = startServer({ authorize: (token) => (token === "device-token" ? { kind: "device", deviceId: "dev_1" } : null) });
    const accepted: CallContext[] = [];
    server.onClientAccepted((ctx) => accepted.push(ctx));
    const desktop = rawSocket(url);
    await desktop.opened;
    desktop.send({ t: "hello", token: "device-token", protocol: PROTOCOL_VERSION, client: "desktop-ui" });
    expect(await desktop.closed).toBe(CLOSE_UNAUTHORIZED);
    expect(accepted).toEqual([]);
    const welcome = await newClient(url, "device-token", "web").connect();
    expect(accepted).toEqual([{ clientId: welcome.clientId, client: "web", auth: { kind: "device", deviceId: "dev_1" } }]);
  });

  test("onClientClosed fires with the context of an authenticated client", async () => {
    const { server, url } = startServer();
    const closed = new Promise<CallContext>((resolve) => server.onClientClosed(resolve));
    const client = newClient(url);
    const welcome = await client.connect();
    expect(server.clients()).toEqual([{ clientId: welcome.clientId, client: "desktop-ui", auth: OWNER }]);
    client.close();
    expect(await closed).toEqual({ clientId: welcome.clientId, client: "desktop-ui", auth: OWNER });
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

  test("answers 403 to a rejected Origin before upgrading and passes origin and host to the policy", async () => {
    const seen: Array<[string | null, string | null]> = [];
    const rejected: Array<string | null> = [];
    const { url } = startServer({
      isOriginAllowed: (origin, host) => {
        seen.push([origin, host]);
        return origin !== "https://evil.example";
      },
      onOriginRejected: (origin) => rejected.push(origin)
    });
    const base = url.replace("ws://", "http://");
    const host = new URL(base).host;
    expect((await fetch(base, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(base, { headers: { Origin: "file://" } })).status).toBe(426);
    expect((await fetch(base)).status).toBe(426);
    expect(seen).toEqual([
      ["https://evil.example", host],
      ["file://", host],
      [null, host]
    ]);
    expect(rejected).toEqual(["https://evil.example"]);
  });

  test("start reports the bound port and url, and refuses a second start", () => {
    const { server, url } = startServer();
    const port = Number(new URL(url).port);
    expect(port).toBeGreaterThan(0);
    expect(url).toBe(`ws://127.0.0.1:${port}/ws`);
    expect(() => server.start()).toThrow("already started");
  });

  test("wsUrl brackets IPv6 hosts", () => {
    expect(wsUrl("::1", 4000)).toBe("ws://[::1]:4000/ws");
    expect(wsUrl("[::1]", 4000)).toBe("ws://[::1]:4000/ws");
    expect(wsUrl("127.0.0.1", 4000)).toBe("ws://127.0.0.1:4000/ws");
    expect(wsUrl("localhost", 4000)).toBe("ws://localhost:4000/ws");
  });
});
