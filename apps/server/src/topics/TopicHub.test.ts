import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CallContext } from "../transport/Router.js";
import { TopicHub, type TopicProvider } from "./TopicHub.js";
import type { TopicStore } from "./TopicStore.js";

type Store = TopicStore<Record<string, unknown>>;

const warn = spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => warn.mockClear());

function ctx(clientId: string): CallContext {
  return { clientId, client: "web", auth: { kind: "owner" } };
}

function setup(prefix = "t/") {
  const sent: Array<{ clientIds: string[]; frame: string }> = [];
  const hub = new TopicHub((clientIds, frame) => sent.push({ clientIds: [...clientIds], frame }));
  const log: string[] = [];
  const stores = new Map<string, Store>();
  const provider: TopicProvider = {
    owns: (topic) => topic.startsWith(prefix),
    acquire(topic, owner) {
      log.push(`acquire:${topic}`);
      const store = owner.createStore<Record<string, unknown>>(topic, { seed: 1 });
      stores.set(topic, store);
      return store;
    },
    release: (topic) => void log.push(`release:${topic}`),
    onSubscribe: (clientId, topic) => void log.push(`sub:${clientId}:${topic}`),
    onUnsubscribe: (clientId, topic) => void log.push(`unsub:${clientId}:${topic}`)
  };
  hub.register(provider);
  return { hub, sent, log, stores, provider };
}

describe("TopicHub", () => {
  test("subscribe returns a snapshot per topic", () => {
    const { hub } = setup();
    expect(hub.subscribe(ctx("a"), ["t/1", "t/2"])).toEqual({ "t/1": { rev: 0, data: { seed: 1 } }, "t/2": { rev: 0, data: { seed: 1 } } });
  });

  test("a repeated subscribe returns a fresh snapshot without double counting", () => {
    const { hub, stores, log } = setup();
    hub.subscribe(ctx("a"), ["t/1"]);
    stores.get("t/1")?.upsert("k", 1);
    const again = hub.subscribe(ctx("a"), ["t/1"]);
    expect(again["t/1"]).toEqual({ rev: 1, data: { seed: 1, k: 1 } });
    expect(hub.countFor("a")).toBe(1);
    expect(hub.subscribers("t/1")).toBe(1);
    expect(log).toEqual(["acquire:t/1", "sub:a:t/1"]);
    hub.unsubscribe(ctx("a"), ["t/1"]);
    expect(log.filter((entry) => entry.startsWith("release:"))).toEqual(["release:t/1"]);
  });

  test("patches go once, serialized, to that topic's subscribers only", () => {
    const { hub, sent, stores } = setup();
    hub.subscribe(ctx("a"), ["t/1"]);
    hub.subscribe(ctx("b"), ["t/1", "t/2"]);
    hub.subscribe(ctx("c"), ["t/2"]);
    stores.get("t/1")?.upsert("k", { v: 1 });
    expect(sent).toEqual([{ clientIds: ["a", "b"], frame: JSON.stringify({ t: "patch", topic: "t/1", rev: 1, ops: [{ op: "upsert", key: "k", value: { v: 1 } }] }) }]);
  });

  test("a store with no subscribers sends nothing", () => {
    const { hub, sent, stores } = setup();
    hub.subscribe(ctx("a"), ["t/1"]);
    const store = stores.get("t/1");
    hub.unsubscribe(ctx("a"), ["t/1"]);
    store?.upsert("k", 1);
    expect(sent).toEqual([]);
  });

  test("acquires on the first subscriber and releases on the last", () => {
    const { hub, log } = setup();
    hub.subscribe(ctx("a"), ["t/1"]);
    hub.subscribe(ctx("b"), ["t/1"]);
    hub.unsubscribe(ctx("a"), ["t/1"]);
    expect(log.filter((entry) => entry.startsWith("acquire") || entry.startsWith("release"))).toEqual(["acquire:t/1"]);
    hub.unsubscribe(ctx("b"), ["t/1"]);
    expect(log).toEqual(["acquire:t/1", "sub:a:t/1", "sub:b:t/1", "unsub:a:t/1", "unsub:b:t/1", "release:t/1"]);
  });

  test("clientClosed releases the topics only that client held", () => {
    const { hub, log } = setup();
    hub.subscribe(ctx("a"), ["t/1", "t/2"]);
    hub.subscribe(ctx("b"), ["t/1"]);
    hub.clientClosed(ctx("a"));
    expect(hub.countFor("a")).toBe(0);
    expect(hub.subscriberIds("t/1")).toEqual(new Set(["b"]));
    expect(log.filter((entry) => entry.startsWith("release:"))).toEqual(["release:t/2"]);
    hub.clientClosed(ctx("b"));
    expect(log.filter((entry) => entry.startsWith("release:"))).toEqual(["release:t/2", "release:t/1"]);
  });

  test("a store recreated for the same topic continues the rev", () => {
    const { hub, stores } = setup();
    hub.subscribe(ctx("a"), ["t/1"]);
    stores.get("t/1")?.upsert("k", 1);
    stores.get("t/1")?.upsert("k", 2);
    hub.unsubscribe(ctx("a"), ["t/1"]);
    const snapshot = hub.subscribe(ctx("a"), ["t/1"]);
    expect(snapshot["t/1"]?.rev).toBe(2);
    stores.get("t/1")?.upsert("k", 3);
    expect(stores.get("t/1")?.rev).toBe(3);
  });

  test("an unknown topic rejects and nothing from the call stays subscribed", () => {
    const { hub, log } = setup();
    expect(() => hub.subscribe(ctx("a"), ["t/1", "other/1"])).toThrow(expect.objectContaining({ code: "unknown-topic" }));
    expect(hub.countFor("a")).toBe(0);
    expect(hub.subscribers("t/1")).toBe(0);
    expect(log).toEqual([]);
  });

  test("a provider that throws on acquire rejects with unknown-topic and rolls back earlier topics", () => {
    const { hub, provider, log } = setup();
    const acquire = provider.acquire.bind(provider);
    provider.acquire = (topic, owner) => {
      if (topic === "t/bad") throw new Error("no such session");
      return acquire(topic, owner);
    };
    expect(() => hub.subscribe(ctx("a"), ["t/1", "t/bad"])).toThrow(expect.objectContaining({ code: "unknown-topic" }));
    expect(hub.countFor("a")).toBe(0);
    expect(hub.activeTopics("t/")).toEqual([]);
    expect(log).toEqual(["acquire:t/1", "sub:a:t/1", "unsub:a:t/1", "release:t/1"]);
  });

  test("unsubscribing a topic the client never held is a no-op", () => {
    const { hub, log } = setup();
    hub.unsubscribe(ctx("a"), ["t/1"]);
    expect(log).toEqual([]);
  });

  test("dropTopic unsubscribes every client of the topic", () => {
    const { hub, log } = setup();
    hub.subscribe(ctx("a"), ["t/1"]);
    hub.subscribe(ctx("b"), ["t/1"]);
    hub.dropTopic("t/1");
    expect(hub.isSubscribed("a", "t/1")).toBe(false);
    expect(log.slice(-3)).toEqual(["unsub:a:t/1", "unsub:b:t/1", "release:t/1"]);
  });

  test("keeps state consistent when a provider hook throws", () => {
    const { hub, provider } = setup();
    provider.onSubscribe = () => {
      throw new Error("boom");
    };
    provider.release = () => {
      throw new Error("boom");
    };
    expect(Object.keys(hub.subscribe(ctx("a"), ["t/1"]))).toEqual(["t/1"]);
    hub.unsubscribe(ctx("a"), ["t/1"]);
    expect(hub.activeTopics("t/")).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  test("acquire runs after the client is listed as a subscriber", () => {
    const { hub, provider } = setup();
    const seen: number[] = [];
    const acquire = provider.acquire.bind(provider);
    provider.acquire = (topic, owner) => {
      seen.push(owner.activeTopics("t/").length);
      return acquire(topic, owner);
    };
    hub.subscribe(ctx("a"), ["t/1"]);
    expect(seen).toEqual([1]);
  });

  test("reacquireAll rebuilds stores from new providers, continues revs and replaces subscriber state", () => {
    const { hub, sent, stores } = setup();
    hub.subscribe(ctx("a"), ["t/1"]);
    stores.get("t/1")?.upsert("old", 1);
    sent.length = 0;

    hub.clearProviders();
    const resynced: string[] = [];
    hub.register({
      owns: (topic) => topic.startsWith("t/"),
      acquire: (topic, owner) => owner.createStore<Record<string, unknown>>(topic, { fresh: true }),
      release: () => {},
      resync: (topic) => void resynced.push(topic)
    });
    hub.reacquireAll();

    expect(sent).toEqual([{ clientIds: ["a"], frame: JSON.stringify({ t: "patch", topic: "t/1", rev: 2, ops: [{ op: "replace", value: { fresh: true } }] }) }]);
    expect(hub.subscribe(ctx("b"), ["t/1"])["t/1"]).toEqual({ rev: 2, data: { fresh: true } });
    expect(resynced).toEqual(["t/1"]);
  });

  test("reacquireAll drops subscribers of a topic no provider owns anymore", () => {
    const { hub } = setup();
    hub.subscribe(ctx("a"), ["t/1"]);
    hub.clearProviders();
    hub.reacquireAll();
    expect(hub.countFor("a")).toBe(0);
  });

  test("resync calls the provider resync of each active topic", () => {
    const { hub, provider } = setup();
    const resynced: string[] = [];
    provider.resync = (topic) => void resynced.push(topic);
    hub.subscribe(ctx("a"), ["t/1", "t/2"]);
    hub.resync();
    expect(resynced).toEqual(["t/1", "t/2"]);
  });
});
