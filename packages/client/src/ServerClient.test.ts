import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ClientMessage, ServerMessage } from "@cw-code/contracts";
import { CLOSE_UNAUTHORIZED, PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { ServerCallError, ServerClient, type ConnectionState } from "./ServerClient.js";

type HelloMessage = Extract<ClientMessage, { t: "hello" }>;
type CallMessage = Extract<ClientMessage, { t: "call" }>;

interface FakeServer {
  url: string;
  hellos: HelloMessage[];
  calls: CallMessage[];
  emit(channel: string, payload: unknown): void;
  sendRaw(data: string): void;
  closeClients(code: number, reason?: string): void;
  openSockets(): number;
  stop(): void;
}

const servers: FakeServer[] = [];
const clients: ServerClient[] = [];
const failSubscribe = { value: false };

function startServer(): FakeServer {
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  const hellos: HelloMessage[] = [];
  const calls: CallMessage[] = [];
  const reply = (ws: Bun.ServerWebSocket<undefined>, message: ServerMessage) => ws.send(JSON.stringify(message));

  const server = Bun.serve<undefined>({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open: (ws) => {
        sockets.add(ws);
      },
      close: (ws) => {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as ClientMessage;
        if (message.t === "hello") {
          hellos.push(message);
          if (message.token === "bad") ws.close(CLOSE_UNAUTHORIZED, "invalid token");
          else reply(ws, { t: "welcome", protocol: PROTOCOL_VERSION, serverVersion: "9.9.9", clientId: `client-${hellos.length}` });
          return;
        }
        calls.push(message);
        if (message.id === undefined) return;
        if (message.method === "topics.subscribe" && failSubscribe.value) {
          if (message.id !== undefined) reply(ws, { t: "result", id: message.id, ok: false, error: { message: "nope", code: "invalid-topic" } });
          return;
        }
        if (message.method === "topics.subscribe" || message.method === "topics.unsubscribe") {
          if (message.id !== undefined) reply(ws, { t: "result", id: message.id, ok: true, value: {} });
          return;
        }
        if (message.method === "echo") reply(ws, { t: "result", id: message.id, ok: true, value: message.params });
        else if (message.method === "fail") reply(ws, { t: "result", id: message.id, ok: false, error: { message: "boom", code: "E_BOOM" } });
      }
    }
  });

  const fake: FakeServer = {
    url: `ws://127.0.0.1:${server.port}`,
    hellos,
    calls,
    emit: (channel, payload) => {
      for (const ws of sockets) reply(ws, { t: "event", channel, payload });
    },
    sendRaw: (data) => {
      for (const ws of sockets) ws.send(data);
    },
    closeClients: (code, reason) => {
      for (const ws of [...sockets]) ws.close(code, reason);
    },
    openSockets: () => sockets.size,
    stop: () => void server.stop(true)
  };
  servers.push(fake);
  return fake;
}

function makeClient(
  server: FakeServer,
  options: { reconnect?: boolean; token?: string; endpoint?: () => Promise<{ url: string; token: string }> } = {}
): ServerClient {
  const client = new ServerClient({
    endpoint: options.endpoint ?? { url: server.url, token: options.token ?? "good" },
    client: "web",
    reconnect: options.reconnect
  });
  clients.push(client);
  return client;
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

function trackStates(client: ServerClient): ConnectionState[] {
  const states: ConnectionState[] = [];
  client.onState((state) => states.push(state));
  return states;
}

afterEach(() => {
  failSubscribe.value = false;
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.stop();
});

describe("ServerClient", () => {
  test("connect sends hello and resolves on welcome", async () => {
    const server = startServer();
    const client = makeClient(server);
    expect(client.state).toBe("closed");
    const states = trackStates(client);

    const welcome = await client.connect();

    expect(welcome).toEqual({ serverVersion: "9.9.9", clientId: "client-1" });
    expect(server.hellos).toEqual([{ t: "hello", token: "good", protocol: PROTOCOL_VERSION, client: "web" }]);
    expect(client.state).toBe("open");
    expect(states).toEqual(["connecting", "open"]);
  });

  test("resolves the endpoint through a function", async () => {
    const server = startServer();
    const client = makeClient(server, { endpoint: async () => ({ url: server.url, token: "from-fn" }) });
    await client.connect();
    expect(server.hellos[0]?.token).toBe("from-fn");
  });

  test("rejects connect with connect-failed when the endpoint cannot be resolved", async () => {
    const server = startServer();
    const client = makeClient(server, {
      endpoint: async () => {
        throw new Error("no endpoint");
      }
    });
    const error = await client.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerCallError);
    expect((error as ServerCallError).code).toBe("connect-failed");
    expect((error as ServerCallError).message).toContain("no endpoint");
    expect(client.state).toBe("closed");
  });

  test("call resolves with the result value", async () => {
    const client = makeClient(startServer());
    await client.connect();
    expect(await client.call("echo", { a: 1 })).toEqual({ a: 1 });
    expect(await client.call<number>("echo", 7)).toBe(7);
  });

  test("call rejects with ServerCallError carrying the server code", async () => {
    const client = makeClient(startServer());
    await client.connect();
    const error = await client.call("fail").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerCallError);
    expect((error as ServerCallError).message).toBe("boom");
    expect((error as ServerCallError).code).toBe("E_BOOM");
  });

  test("call ids increment", async () => {
    const server = startServer();
    const client = makeClient(server);
    await client.connect();
    await client.call("echo", 1);
    await client.call("echo", 2);
    expect(server.calls.map((call) => call.id)).toEqual([1, 2]);
  });

  test("send is fire-and-forget: reaches the server without an id and yields no result", async () => {
    const server = startServer();
    const client = makeClient(server);
    await client.connect();

    client.send("echo", { x: 1 });
    await waitFor(() => server.calls.length === 1);
    await client.call("echo", "after");

    expect(server.calls[0]).toEqual({ t: "call", method: "echo", params: { x: 1 } });
    expect("id" in server.calls[0]!).toBe(false);
  });

  test("events fan out to every listener and unsubscribe works", async () => {
    const server = startServer();
    const client = makeClient(server);
    await client.connect();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const other: unknown[] = [];
    const offFirst = client.on("chan", (payload) => first.push(payload));
    client.on("chan", (payload) => second.push(payload));
    client.on("other", (payload) => other.push(payload));

    server.emit("chan", 1);
    await waitFor(() => second.length === 1);
    offFirst();
    server.emit("chan", 2);
    await waitFor(() => second.length === 2);

    expect(first).toEqual([1]);
    expect(second).toEqual([1, 2]);
    expect(other).toEqual([]);
  });

  test("a throwing listener does not break other listeners or the socket", async () => {
    const server = startServer();
    const client = makeClient(server);
    await client.connect();
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const received: unknown[] = [];
    client.on("chan", () => {
      throw new Error("listener bug");
    });
    client.on("chan", (payload) => received.push(payload));

    server.emit("chan", "a");
    await waitFor(() => received.length === 1);

    expect(errorSpy).toHaveBeenCalled();
    expect(client.state).toBe("open");
    expect(await client.call("echo", "still-works")).toBe("still-works");
    errorSpy.mockRestore();
  });

  test("malformed and unknown server messages are warned about and ignored", async () => {
    const server = startServer();
    const client = makeClient(server);
    await client.connect();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

    server.sendRaw("not json");
    server.sendRaw(JSON.stringify({ t: "mystery" }));
    server.sendRaw(JSON.stringify({ t: "event" }));
    await waitFor(() => warnSpy.mock.calls.length === 3);

    expect(client.state).toBe("open");
    expect(await client.call("echo", 1)).toBe(1);
    warnSpy.mockRestore();
  });

  test("call while disconnected rejects with code disconnected", async () => {
    const client = makeClient(startServer());
    const error = await client.call("echo").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerCallError);
    expect((error as ServerCallError).code).toBe("disconnected");
    expect((error as ServerCallError).message).toBe("server connection lost");
  });

  test("send while disconnected is dropped without throwing", () => {
    const client = makeClient(startServer());
    expect(() => client.send("echo", 1)).not.toThrow();
  });

  test("pending calls reject when the server closes the socket", async () => {
    const server = startServer();
    const client = makeClient(server);
    await client.connect();

    const hanging = client.call("hang").catch((e: unknown) => e);
    await waitFor(() => server.calls.length === 1);
    server.closeClients(1011, "server crashed");

    const error = await hanging;
    expect(error).toBeInstanceOf(ServerCallError);
    expect((error as ServerCallError).code).toBe("disconnected");
    expect(client.state).toBe("closed");
  });

  test("connect rejects with unauthorized on close 4401 and does not retry", async () => {
    const server = startServer();
    const client = makeClient(server, { token: "bad", reconnect: true });
    const states = trackStates(client);

    const error = await client.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServerCallError);
    expect((error as ServerCallError).code).toBe("unauthorized");
    expect((error as ServerCallError).message).toContain("invalid token");
    await Bun.sleep(400);
    expect(server.hellos).toHaveLength(1);
    expect(client.state).toBe("closed");
    expect(states).toEqual(["connecting", "closed"]);
  });

  test("lastError carries the close reason after a 4401 and clears on the next welcome", async () => {
    const server = startServer();
    let token = "bad";
    const client = makeClient(server, { reconnect: true, endpoint: async () => ({ url: server.url, token }) });
    expect(client.lastError).toBeNull();

    await client.connect().catch(() => undefined);
    expect(client.lastError).toBeInstanceOf(ServerCallError);
    expect(client.lastError?.code).toBe("unauthorized");
    expect(client.lastError?.message).toContain("invalid token");

    token = "good";
    await client.connect();
    expect(client.lastError).toBeNull();

    server.closeClients(CLOSE_UNAUTHORIZED, "token rotated");
    await waitFor(() => client.state === "closed");
    expect(client.lastError?.code).toBe("unauthorized");
    expect(client.lastError?.message).toContain("token rotated");
  });

  test("a client-initiated close leaves lastError empty", async () => {
    const client = makeClient(startServer(), { reconnect: true });
    await client.connect();
    client.close();
    await Bun.sleep(50);
    expect(client.lastError).toBeNull();
  });

  test("connect rejects with connect-failed when the server is unreachable", async () => {
    const server = startServer();
    const url = server.url;
    server.stop();
    const client = makeClient(server, { endpoint: async () => ({ url, token: "good" }) });
    const error = await client.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerCallError);
    expect((error as ServerCallError).code).toBe("connect-failed");
  });

  test("reconnects after a server-initiated close with a fresh hello", async () => {
    const server = startServer();
    let endpointCalls = 0;
    const client = makeClient(server, {
      reconnect: true,
      endpoint: async () => {
        endpointCalls += 1;
        return { url: server.url, token: "good" };
      }
    });
    const states = trackStates(client);
    await client.connect();

    server.closeClients(1011, "restart");
    await waitFor(() => server.hellos.length === 2 && client.state === "open");

    expect(states).toEqual(["connecting", "open", "reconnecting", "open"]);
    expect(endpointCalls).toBe(2);
    expect(await client.call("echo", "back")).toBe("back");
  });

  test("connect while reconnecting replaces the pending retry with one immediate attempt", async () => {
    const server = startServer();
    const client = makeClient(server, { reconnect: true });
    const states = trackStates(client);
    await client.connect();

    server.closeClients(1011);
    await waitFor(() => client.state === "reconnecting");
    const first = client.connect();
    const second = client.connect();
    expect(second).toBe(first);
    expect((await first).clientId).toBe("client-2");
    await Bun.sleep(400);

    expect(server.hellos).toHaveLength(2);
    expect(server.openSockets()).toBe(1);
    expect(client.state).toBe("open");
    expect(states).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  test("close stops reconnecting", async () => {
    const server = startServer();
    const client = makeClient(server, { reconnect: true });
    const states = trackStates(client);
    await client.connect();

    server.closeClients(1011);
    await waitFor(() => client.state === "reconnecting");
    client.close();
    await Bun.sleep(400);

    expect(client.state).toBe("closed");
    expect(server.hellos).toHaveLength(1);
    expect(states).toEqual(["connecting", "open", "reconnecting", "closed"]);
  });

  test("keeps retrying with backoff while the server is down and recovers", async () => {
    const server = startServer();
    const port = Number(new URL(server.url).port);
    const client = makeClient(server, { reconnect: true });
    await client.connect();
    server.stop();
    await waitFor(() => client.state === "reconnecting");
    await Bun.sleep(300);
    expect(client.state).toBe("reconnecting");

    const revived = Bun.serve<undefined>({
      port,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 426 })),
      websocket: {
        message(ws, raw) {
          const message = JSON.parse(String(raw)) as ClientMessage;
          if (message.t === "hello") ws.send(JSON.stringify({ t: "welcome", protocol: PROTOCOL_VERSION, serverVersion: "2", clientId: "again" } satisfies ServerMessage));
        }
      }
    });
    try {
      await waitFor(() => client.state === "open");
    } finally {
      client.close();
      revived.stop(true);
    }
  });

  test("close while connecting rejects connect", async () => {
    const server = startServer();
    const client = makeClient(server, { endpoint: async () => ({ url: server.url, token: "good" }) });
    const connecting = client.connect().catch((e: unknown) => e);
    client.close();
    const error = await connecting;
    expect(error).toBeInstanceOf(ServerCallError);
    expect(client.state).toBe("closed");
  });

  describe("topic subscriptions", () => {
    const topicCalls = (server: FakeServer) => server.calls.filter((call) => call.method.startsWith("topics."));

    test("two subscribes to the same topic produce one wire call and unsubscribe waits for both disposers", async () => {
      const server = startServer();
      const client = makeClient(server);
      await client.connect();

      const first = client.subscribe(["sidebar"]);
      const second = client.subscribe(["sidebar"]);
      await waitFor(() => topicCalls(server).length === 1);
      expect(topicCalls(server)[0]).toMatchObject({ method: "topics.subscribe", params: { topics: ["sidebar"] } });

      first();
      first();
      await Bun.sleep(30);
      expect(topicCalls(server)).toHaveLength(1);
      expect(client.topics).toEqual(["sidebar"]);

      second();
      await waitFor(() => topicCalls(server).length === 2);
      expect(topicCalls(server)[1]).toMatchObject({ method: "topics.unsubscribe", params: { topics: ["sidebar"] } });
      expect(client.topics).toEqual([]);
    });

    test("unsubscribe and resubscribe in the same tick sends nothing", async () => {
      const server = startServer();
      const client = makeClient(server);
      await client.connect();
      const dispose = client.subscribe(["usage"]);
      await waitFor(() => topicCalls(server).length === 1);

      dispose();
      client.subscribe(["usage"]);
      await Bun.sleep(30);

      expect(topicCalls(server)).toHaveLength(1);
    });

    test("a subscribe made before connect is sent after welcome and topics are sorted", async () => {
      const server = startServer();
      const client = makeClient(server);
      client.subscribe(["usage", "app"]);
      expect(client.topics).toEqual(["app", "usage"]);
      await Bun.sleep(20);
      expect(server.calls).toHaveLength(0);

      await client.connect();
      await waitFor(() => topicCalls(server).length === 1);

      expect(topicCalls(server)[0]?.params).toEqual({ topics: ["usage", "app"] });
    });

    test("after reconnect, all desired topics are sent before any user call", async () => {
      const server = startServer();
      const client = makeClient(server, { reconnect: true });
      await client.connect();
      client.subscribe(["app", "sidebar"]);
      await waitFor(() => topicCalls(server).length === 1);
      client.onState((state) => {
        if (state === "open") void client.call("echo", "first-user-call");
      });
      const before = server.calls.length;

      server.closeClients(1011, "restart");
      await waitFor(() => server.hellos.length === 2 && client.state === "open");
      await waitFor(() => server.calls.length >= before + 2);

      const after = server.calls.slice(before);
      expect(after[0]).toMatchObject({ method: "topics.subscribe", params: { topics: ["app", "sidebar"] } });
      expect(after[1]?.method).toBe("echo");
      await Bun.sleep(30);
      expect(server.calls.slice(before).filter((call) => call.method === "topics.subscribe")).toHaveLength(1);
    });

    test("a persistently failing topic is sent once even after later unrelated subscribes", async () => {
      const server = startServer();
      const client = makeClient(server);
      await client.connect();
      const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
      failSubscribe.value = true;
      client.subscribe(["app"]);
      await waitFor(() => warnSpy.mock.calls.length === 1);

      failSubscribe.value = false;
      const off = client.subscribe(["usage"]);
      await waitFor(() => topicCalls(server).length === 2);
      off();
      await waitFor(() => topicCalls(server).length === 3);
      await Bun.sleep(30);

      expect(topicCalls(server).map((call) => call.params)).toEqual([{ topics: ["app"] }, { topics: ["usage"] }, { topics: ["usage"] }]);
      expect(warnSpy.mock.calls).toHaveLength(1);
      warnSpy.mockRestore();
    });

    test("invalid and pty topics throw synchronously and nothing is sent", async () => {
      const server = startServer();
      const client = makeClient(server);
      await client.connect();

      for (const bad of ["nope", "pty/sess_a:shell"]) {
        const error = (() => {
          try {
            client.subscribe(["app", bad]);
          } catch (e) {
            return e;
          }
          return null;
        })();
        expect(error).toBeInstanceOf(ServerCallError);
        expect((error as ServerCallError).code).toBe("invalid-topic");
      }
      await Bun.sleep(30);

      expect(client.topics).toEqual([]);
      expect(topicCalls(server)).toHaveLength(0);
    });

    test("a failed subscribe warns and is not retried", async () => {
      const server = startServer();
      const client = makeClient(server);
      await client.connect();
      const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
      failSubscribe.value = true;

      client.subscribe(["app"]);
      await waitFor(() => warnSpy.mock.calls.length === 1);
      await Bun.sleep(30);

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[ServerClient] topics.subscribe failed: nope");
      expect(topicCalls(server)).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });
});
