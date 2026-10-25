import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ClientMessage, ServerMessage, TopicOp, TopicPatch, TopicsSubscribeResult } from "@cw-code/contracts";
import { PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { ServerClient } from "./ServerClient.js";
import { applyTopicOps, orderedEntries, TopicCache } from "./TopicCache.js";

type CallMessage = Extract<ClientMessage, { t: "call" }>;

interface FakeServer {
  url: string;
  calls: CallMessage[];
  snapshots: TopicsSubscribeResult;
  failTopics: Set<string>;
  beforeResult: ((topics: string[]) => void) | null;
  patch(patch: TopicPatch): void;
  closeClients(): void;
  hellos(): number;
}

const servers: Array<{ stop(): void }> = [];
const clients: ServerClient[] = [];
const caches: TopicCache[] = [];

function startServer(): FakeServer {
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  let hellos = 0;
  const send = (ws: Bun.ServerWebSocket<undefined>, message: ServerMessage) => ws.send(JSON.stringify(message));
  const fake: FakeServer = {
    url: "",
    calls: [],
    snapshots: {},
    failTopics: new Set(),
    beforeResult: null,
    patch: (patch) => {
      for (const ws of sockets) send(ws, { t: "patch", ...patch });
    },
    closeClients: () => {
      for (const ws of [...sockets]) ws.close(1011, "restart");
    },
    hellos: () => hellos
  };
  const server = Bun.serve<undefined>({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as ClientMessage;
        if (message.t === "hello") {
          hellos += 1;
          send(ws, { t: "welcome", protocol: PROTOCOL_VERSION, serverVersion: "9.9.9", clientId: `client-${hellos}` });
          return;
        }
        fake.calls.push(message);
        if (message.id === undefined || message.method !== "topics.subscribe") return;
        const { topics } = message.params as { topics: string[] };
        const bad = topics.find((topic) => fake.failTopics.has(topic));
        if (bad) {
          send(ws, { t: "result", id: message.id, ok: false, error: { message: `unknown topic ${bad}`, code: "unknown-topic" } });
          return;
        }
        fake.beforeResult?.(topics);
        const value: TopicsSubscribeResult = {};
        for (const topic of topics) value[topic] = fake.snapshots[topic] ?? { rev: 0, data: {} };
        send(ws, { t: "result", id: message.id, ok: true, value });
      }
    }
  });
  fake.url = `ws://127.0.0.1:${server.port}`;
  servers.push({ stop: () => void server.stop(true) });
  return fake;
}

async function connect(server: FakeServer, reconnect = false): Promise<{ client: ServerClient; cache: TopicCache }> {
  const client = new ServerClient({ endpoint: { url: server.url, token: "good" }, client: "web", reconnect });
  clients.push(client);
  await client.connect();
  const cache = new TopicCache(client);
  caches.push(cache);
  return { client, cache };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

const topicCalls = (server: FakeServer, method?: string) =>
  server.calls.filter((call) => (method ? call.method === method : call.method.startsWith("topics.")));

afterEach(() => {
  for (const cache of caches.splice(0)) cache.dispose();
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.stop();
});

describe("applyTopicOps", () => {
  const entryA = { seq: 1, text: "a" };
  const entryB = { seq: 2, text: "b" };
  const base: Record<string, unknown> = { "item:a": entryA, "item:b": entryB };

  test("upsert adds and replaces without touching other entries", () => {
    const next = applyTopicOps(base, [{ op: "upsert", key: "item:c", value: { seq: 3 } }, { op: "upsert", key: "item:a", value: { seq: 1, text: "A" } }]);
    expect(next).toEqual({ "item:a": { seq: 1, text: "A" }, "item:b": entryB, "item:c": { seq: 3 } });
    expect(next["item:b"]).toBe(entryB);
    expect(base["item:a"]).toBe(entryA);
  });

  test("remove drops the key and ignores a missing one", () => {
    const next = applyTopicOps(base, [{ op: "remove", key: "item:a" }, { op: "remove", key: "item:zzz" }]);
    expect(next).toEqual({ "item:b": entryB });
    expect(next["item:b"]).toBe(entryB);
    expect(base).toEqual({ "item:a": entryA, "item:b": entryB });
  });

  test("append extends a string field and creates it when absent", () => {
    const next = applyTopicOps(base, [
      { op: "append", key: "item:a", field: "text", text: "1" },
      { op: "append", key: "item:a", field: "text", text: "2" },
      { op: "append", key: "item:b", field: "note", text: "n" }
    ]);
    expect(next["item:a"]).toEqual({ seq: 1, text: "a12" });
    expect(next["item:b"]).toEqual({ seq: 2, text: "b", note: "n" });
    expect(entryA.text).toBe("a");
  });

  test("append on a missing key is ignored", () => {
    const next = applyTopicOps(base, [{ op: "append", key: "item:zzz", field: "text", text: "x" }]);
    expect(next).toBe(base);
  });

  test("replace swaps the whole data and later ops build on it", () => {
    const value = { "item:x": { seq: 9 } };
    const next = applyTopicOps(base, [{ op: "replace", value }, { op: "upsert", key: "item:y", value: 1 }]);
    expect(next).toEqual({ "item:x": { seq: 9 }, "item:y": 1 });
    expect(value).toEqual({ "item:x": { seq: 9 } });
  });

  test("no-op ops keep the same data identity", () => {
    expect(applyTopicOps(base, [])).toBe(base);
    expect(applyTopicOps(base, [{ op: "upsert", key: "item:a", value: entryA }])).toBe(base);
  });
});

describe("orderedEntries", () => {
  test("filters by prefix and sorts by seq", () => {
    const data = { "item:b": { seq: 2 }, "other:x": { seq: 0 }, "item:a": { seq: 1 }, "item:c": { seq: 3 } };
    expect(orderedEntries<{ seq: number }>(data, "item:").map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });
});

describe("TopicCache", () => {
  test("applies the snapshot and a later patch", async () => {
    const server = startServer();
    server.snapshots.sidebar = { rev: 4, data: { "row:a": { seq: 1 } } };
    const { cache } = await connect(server);
    let notifications = 0;
    cache.listen("sidebar", () => void (notifications += 1));

    cache.acquire("sidebar");
    expect(cache.state("sidebar")?.status).toBe("subscribing");
    await waitFor(() => cache.state("sidebar")?.status === "ready");
    expect(cache.state("sidebar")).toEqual({ status: "ready", rev: 4, data: { "row:a": { seq: 1 } }, error: null });

    server.patch({ topic: "sidebar", rev: 5, ops: [{ op: "upsert", key: "row:b", value: { seq: 2 } }] });
    await waitFor(() => cache.state("sidebar")?.rev === 5);

    expect(cache.state("sidebar")?.data).toEqual({ "row:a": { seq: 1 }, "row:b": { seq: 2 } });
    expect(notifications).toBeGreaterThanOrEqual(3);
    expect(topicCalls(server, "topics.subscribe")).toHaveLength(1);
  });

  test("buffers patches that arrive before the snapshot and drops stale revs", async () => {
    const server = startServer();
    server.snapshots.app = { rev: 5, data: { a: 1 } };
    server.beforeResult = () => {
      const ops = (key: string): TopicOp[] => [{ op: "upsert", key, value: true }];
      server.patch({ topic: "app", rev: 4, ops: ops("older") });
      server.patch({ topic: "app", rev: 5, ops: ops("stale") });
      server.patch({ topic: "app", rev: 6, ops: ops("fresh") });
      server.patch({ topic: "app", rev: 7, ops: ops("fresher") });
    };
    const { cache } = await connect(server);

    cache.acquire("app");
    await waitFor(() => cache.state("app")?.status === "ready");

    expect(cache.state("app")).toEqual({ status: "ready", rev: 7, data: { a: 1, fresh: true, fresher: true }, error: null });
    expect(topicCalls(server, "topics.subscribe")).toHaveLength(1);
  });

  test("a rev gap resubscribes that topic and takes the new snapshot", async () => {
    const server = startServer();
    server.snapshots.app = { rev: 1, data: { v: "one" } };
    const { cache } = await connect(server);
    cache.acquire("app");
    await waitFor(() => cache.state("app")?.status === "ready");

    server.snapshots.app = { rev: 3, data: { v: "three" } };
    server.patch({ topic: "app", rev: 3, ops: [{ op: "upsert", key: "v", value: "ignored" }] });
    await waitFor(() => cache.state("app")?.rev === 3);

    expect(cache.state("app")?.data).toEqual({ v: "three" });
    expect(topicCalls(server, "topics.subscribe").map((call) => call.params)).toEqual([{ topics: ["app"] }, { topics: ["app"] }]);
  });

  test("duplicate patches are ignored", async () => {
    const server = startServer();
    server.snapshots.app = { rev: 2, data: {} };
    const { cache } = await connect(server);
    cache.acquire("app");
    await waitFor(() => cache.state("app")?.status === "ready");

    server.patch({ topic: "app", rev: 2, ops: [{ op: "upsert", key: "x", value: 1 }] });
    server.patch({ topic: "app", rev: 3, ops: [{ op: "upsert", key: "y", value: 1 }] });
    await waitFor(() => cache.state("app")?.rev === 3);

    expect(cache.state("app")?.data).toEqual({ y: 1 });
    expect(topicCalls(server, "topics.subscribe")).toHaveLength(1);
  });

  test("a reconnect resubscribes every acquired topic in one call, replaces data and bumps epoch", async () => {
    const server = startServer();
    server.snapshots.app = { rev: 1, data: { v: 1 } };
    server.snapshots["session/s1"] = { rev: 1, data: { x: 1 } };
    const { cache } = await connect(server, true);
    cache.acquire("app");
    cache.acquire("session/s1");
    await waitFor(() => cache.state("app")?.status === "ready" && cache.state("session/s1")?.status === "ready");
    const epochs: number[] = [];
    cache.onEpoch((epoch) => epochs.push(epoch));
    let notifications = 0;
    cache.listen("app", () => void (notifications += 1));
    const before = server.calls.length;

    server.snapshots.app = { rev: 9, data: { v: 9 } };
    server.snapshots["session/s1"] = { rev: 2, data: { x: 2 } };
    server.closeClients();
    await waitFor(() => cache.epoch === 1);

    const resubscribes = server.calls.slice(before).filter((call) => call.method === "topics.subscribe");
    expect(resubscribes).toHaveLength(1);
    expect((resubscribes[0]?.params as { topics: string[] }).topics.sort()).toEqual(["app", "session/s1"]);
    expect(cache.state("app")).toEqual({ status: "ready", rev: 9, data: { v: 9 }, error: null });
    expect(cache.state("session/s1")?.data).toEqual({ x: 2 });
    expect(notifications).toBeGreaterThanOrEqual(1);
    expect(epochs).toEqual([1]);
  });

  test("acquire and release in the same tick send nothing", async () => {
    const server = startServer();
    const { cache } = await connect(server);

    cache.acquire("usage")();
    await Bun.sleep(30);

    expect(topicCalls(server)).toHaveLength(0);
    expect(cache.state("usage")).toBeUndefined();
  });

  test("acquires are ref-counted and coalesced into one subscribe, release sends one unsubscribe", async () => {
    const server = startServer();
    const { cache } = await connect(server);

    const first = cache.acquire("sidebar");
    const second = cache.acquire("sidebar");
    cache.acquire("usage");
    await waitFor(() => cache.state("sidebar")?.status === "ready");
    expect(topicCalls(server)).toHaveLength(1);
    expect((topicCalls(server)[0]?.params as { topics: string[] }).topics.sort()).toEqual(["sidebar", "usage"]);

    first();
    first();
    await Bun.sleep(30);
    expect(topicCalls(server)).toHaveLength(1);

    second();
    await waitFor(() => topicCalls(server).length === 2);
    expect(topicCalls(server)[1]).toMatchObject({ method: "topics.unsubscribe", params: { topics: ["sidebar"] } });
    expect(cache.state("sidebar")).toBeUndefined();
  });

  test("patches for a released topic are ignored", async () => {
    const server = startServer();
    server.snapshots.app = { rev: 1, data: {} };
    const { cache } = await connect(server);
    const release = cache.acquire("app");
    await waitFor(() => cache.state("app")?.status === "ready");

    release();
    await Bun.sleep(20);
    server.patch({ topic: "app", rev: 2, ops: [{ op: "upsert", key: "x", value: 1 }] });
    await Bun.sleep(30);

    expect(cache.state("app")).toBeUndefined();
  });

  test("a subscribe error puts the topic in error status with the message", async () => {
    const server = startServer();
    server.failTopics.add("session/missing");
    const { cache } = await connect(server);

    cache.acquire("session/missing");
    await waitFor(() => cache.state("session/missing")?.status === "error");

    expect(cache.state("session/missing")?.error).toBe("unknown topic session/missing");
  });

  test("one failing topic does not take down the others in the same batch", async () => {
    const server = startServer();
    server.failTopics.add("session/missing");
    server.snapshots.app = { rev: 2, data: { ok: true } };
    const { cache } = await connect(server);

    cache.acquire("app");
    cache.acquire("session/missing");
    await waitFor(() => cache.state("session/missing")?.status === "error" && cache.state("app")?.status === "ready");

    expect(cache.state("app")?.data).toEqual({ ok: true });
  });

  test("invalid topics fail locally without a wire call", async () => {
    const server = startServer();
    const { cache } = await connect(server);

    cache.acquire("nope");
    cache.acquire("pty/sess_a:shell");
    await Bun.sleep(30);

    expect(cache.state("nope")?.status).toBe("error");
    expect(cache.state("pty/sess_a:shell")?.status).toBe("error");
    expect(topicCalls(server)).toHaveLength(0);
  });

  test("topics acquired before the connection opens are subscribed after welcome", async () => {
    const server = startServer();
    server.snapshots.app = { rev: 1, data: { v: 1 } };
    const client = new ServerClient({ endpoint: { url: server.url, token: "good" }, client: "web" });
    clients.push(client);
    const cache = new TopicCache(client);
    caches.push(cache);

    cache.acquire("app");
    await Bun.sleep(20);
    expect(topicCalls(server)).toHaveLength(0);

    await client.connect();
    await waitFor(() => cache.state("app")?.status === "ready");

    expect(cache.state("app")?.data).toEqual({ v: 1 });
    expect(cache.epoch).toBe(0);
  });

  test("dispose releases everything and stops reacting to patches", async () => {
    const server = startServer();
    server.snapshots.app = { rev: 1, data: {} };
    const { cache } = await connect(server);
    cache.acquire("app");
    await waitFor(() => cache.state("app")?.status === "ready");

    cache.dispose();
    await waitFor(() => topicCalls(server, "topics.unsubscribe").length === 1);
    server.patch({ topic: "app", rev: 2, ops: [] });
    await Bun.sleep(20);

    expect(topicCalls(server, "topics.unsubscribe")[0]?.params).toEqual({ topics: ["app"] });
    expect(cache.state("app")).toBeUndefined();
    expect(cache.acquire("app")).toBeInstanceOf(Function);
    await Bun.sleep(20);
    expect(topicCalls(server, "topics.subscribe")).toHaveLength(1);
  });

  test("a throwing listener does not break other listeners", async () => {
    const server = startServer();
    const { cache } = await connect(server);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    let notified = 0;
    cache.listen("app", () => {
      throw new Error("listener boom");
    });
    cache.listen("app", () => void (notified += 1));

    cache.acquire("app");
    await waitFor(() => cache.state("app")?.status === "ready");

    expect(notified).toBeGreaterThanOrEqual(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
