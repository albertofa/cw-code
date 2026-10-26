import { afterEach, describe, expect, test } from "bun:test";
import type { ServerMessage } from "@cw-code/contracts";
import { PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { registerTopicHandlers } from "../handlers/topics.js";
import { Router } from "../transport/Router.js";
import { WsServer } from "../transport/WsServer.js";
import { TopicHub } from "./TopicHub.js";
import type { TopicStore } from "./TopicStore.js";

const TOKEN = "t".repeat(64);
const servers: WsServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function startHub() {
  const router = new Router();
  const holder: { server: WsServer | null } = { server: null };
  const hub = new TopicHub((clientIds, frame) => holder.server?.sendTo(clientIds, frame));
  const stores = new Map<string, TopicStore<Record<string, unknown>>>();
  hub.register({
    owns: (topic) => topic === "session/test-state",
    acquire: (topic, owner) => {
      const store = owner.createStore<Record<string, unknown>>(topic, { first: 1 });
      stores.set(topic, store);
      return store;
    },
    release: () => {}
  });
  registerTopicHandlers(router, { topics: hub });
  router.handle("test.bump", () => {
    stores.get("session/test-state")?.upsert("bumped", true);
    return "done";
  });
  const server = new WsServer({ host: "127.0.0.1", port: 0, authorize: (token) => (token === TOKEN ? { kind: "owner" } : null), version: "test", router });
  holder.server = server;
  servers.push(server);
  server.onClientClosed((ctx) => hub.clientClosed(ctx));
  const { url } = server.start();
  return { hub, stores, url };
}

async function connectSocket(url: string) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const queue: ServerMessage[] = [];
  const waiting: Array<(message: ServerMessage) => void> = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    const next = waiting.shift();
    if (next) next(message);
    else queue.push(message);
  };
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  const next = (): Promise<ServerMessage> => {
    const queued = queue.shift();
    return queued ? Promise.resolve(queued) : new Promise((resolve) => waiting.push(resolve));
  };
  ws.send(JSON.stringify({ t: "hello", token: TOKEN, protocol: PROTOCOL_VERSION, client: "web" }));
  expect((await next()).t).toBe("welcome");
  return { ws, next, pending: () => queue.length };
}

describe("topic patch transport", () => {
  test("subscribe answers a snapshot, then a store mutation arrives as a patch before the call result", async () => {
    const { url } = startHub();
    const client = await connectSocket(url);
    client.ws.send(JSON.stringify({ t: "call", id: 1, method: "topics.subscribe", params: { topics: ["session/test-state"] } }));
    expect(await client.next()).toEqual({ t: "result", id: 1, ok: true, value: { "session/test-state": { rev: 0, data: { first: 1 } } } });

    client.ws.send(JSON.stringify({ t: "call", id: 2, method: "test.bump" }));
    expect(await client.next()).toEqual({ t: "patch", topic: "session/test-state", rev: 1, ops: [{ op: "upsert", key: "bumped", value: true }] });
    expect(await client.next()).toEqual({ t: "result", id: 2, ok: true, value: "done" });
  });

  test("a client that did not subscribe receives no patch, and a re-subscribe returns the current snapshot", async () => {
    const { url } = startHub();
    const subscriber = await connectSocket(url);
    const bystander = await connectSocket(url);
    subscriber.ws.send(JSON.stringify({ t: "call", id: 1, method: "topics.subscribe", params: { topics: ["session/test-state"] } }));
    await subscriber.next();
    bystander.ws.send(JSON.stringify({ t: "call", id: 1, method: "test.bump" }));
    expect(await bystander.next()).toEqual({ t: "result", id: 1, ok: true, value: "done" });
    expect((await subscriber.next()).t).toBe("patch");
    expect(bystander.pending()).toBe(0);

    subscriber.ws.send(JSON.stringify({ t: "call", id: 2, method: "topics.subscribe", params: { topics: ["session/test-state"] } }));
    expect(await subscriber.next()).toEqual({ t: "result", id: 2, ok: true, value: { "session/test-state": { rev: 1, data: { first: 1, bumped: true } } } });
  });

  test("an unknown topic is rejected with unknown-topic", async () => {
    const { url, hub } = startHub();
    const client = await connectSocket(url);
    client.ws.send(JSON.stringify({ t: "call", id: 1, method: "topics.subscribe", params: { topics: ["session/test-state", "github/nope"] } }));
    expect(await client.next()).toMatchObject({ t: "result", id: 1, ok: false, error: { code: "unknown-topic" } });
    expect(hub.activeTopics("session/")).toEqual([]);
  });
});
