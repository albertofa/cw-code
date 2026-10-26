import { describe, expect, test } from "bun:test";
import { TopicHub } from "../topics/TopicHub.js";
import { subscribeIfConnected } from "./shared.js";

function appWith(connected: Set<string>) {
  const topics = new TopicHub(() => {});
  topics.register({
    owns: (topic) => topic.startsWith("pty/"),
    acquire: (topic, hub) => hub.createStore<Record<string, unknown>>(topic, {}),
    release: () => {}
  });
  return { topics, isConnected: (clientId: string) => connected.has(clientId) };
}

describe("subscribeIfConnected", () => {
  test("subscribes a connected client", () => {
    const app = appWith(new Set(["c1"]));
    subscribeIfConnected(app, "c1", ["pty/p1"]);
    expect(app.topics.isSubscribed("c1", "pty/p1")).toBe(true);
  });

  test("leaves no subscription for a client that disconnected while the call was in flight", () => {
    const connected = new Set(["c1"]);
    const app = appWith(connected);
    connected.delete("c1");
    subscribeIfConnected(app, "c1", ["pty/p1"]);
    expect(app.topics.isSubscribed("c1", "pty/p1")).toBe(false);
    expect(app.topics.countFor("c1")).toBe(0);
  });
});
