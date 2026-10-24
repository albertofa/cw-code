import { describe, expect, it, vi } from "bun:test";
import { TopicRegistry } from "./TopicRegistry.js";

function recordingHooks(log: string[]) {
  return {
    onFirst: (topic: string) => void log.push(`first:${topic}`),
    onSubscribe: (clientId: string, topic: string) => void log.push(`sub:${clientId}:${topic}`),
    onUnsubscribe: (clientId: string, topic: string) => void log.push(`unsub:${clientId}:${topic}`),
    onLast: (topic: string) => void log.push(`last:${topic}`),
  };
}

describe("TopicRegistry", () => {
  it("ref-counts topics across clients", () => {
    const registry = new TopicRegistry();
    const log: string[] = [];
    registry.on("git/", recordingHooks(log));

    expect(registry.subscribe("a", ["git/s1"])).toEqual(["git/s1"]);
    expect(registry.subscribe("b", ["git/s1"])).toEqual(["git/s1"]);
    expect([...registry.subscribers("git/s1")].sort()).toEqual(["a", "b"]);
    expect(registry.activeTopics("git/")).toEqual(["git/s1"]);

    registry.unsubscribe("a", ["git/s1"]);
    expect(registry.activeTopics("git/")).toEqual(["git/s1"]);
    expect(log.filter((entry) => entry.startsWith("last:"))).toEqual([]);

    registry.unsubscribe("b", ["git/s1"]);
    expect(registry.activeTopics("git/")).toEqual([]);
    expect(registry.subscribers("git/s1").size).toBe(0);
    expect(log.filter((entry) => entry.startsWith("last:"))).toEqual(["last:git/s1"]);
  });

  it("runs first before subscribe, and unsubscribe before last", () => {
    const registry = new TopicRegistry();
    const log: string[] = [];
    registry.on("prs", recordingHooks(log));

    registry.subscribe("a", ["prs"]);
    registry.unsubscribe("a", ["prs"]);

    expect(log).toEqual(["first:prs", "sub:a:prs", "unsub:a:prs", "last:prs"]);
  });

  it("fires hooks on dropClient and dropTopic", () => {
    const registry = new TopicRegistry();
    const log: string[] = [];
    registry.on("files/", recordingHooks(log));
    registry.subscribe("a", ["files/x", "files/y"]);
    registry.subscribe("b", ["files/x"]);

    registry.dropClient("a");
    expect(registry.countFor("a")).toBe(0);
    expect(log).toContain("unsub:a:files/x");
    expect(log).toContain("last:files/y");
    expect(log).not.toContain("last:files/x");

    registry.dropTopic("files/x");
    expect(registry.isSubscribed("b", "files/x")).toBe(false);
    expect(log).toContain("unsub:b:files/x");
    expect(log).toContain("last:files/x");
  });

  it("treats a duplicate subscribe as a no-op", () => {
    const registry = new TopicRegistry();
    const log: string[] = [];
    registry.on("sidebar", recordingHooks(log));

    expect(registry.subscribe("a", ["sidebar"])).toEqual(["sidebar"]);
    expect(registry.subscribe("a", ["sidebar", "sidebar"])).toEqual([]);

    expect(registry.countFor("a")).toBe(1);
    expect(log).toEqual(["first:sidebar", "sub:a:sidebar"]);
  });

  it("keeps state consistent when a hook throws", () => {
    const registry = new TopicRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log: string[] = [];
    registry.on("git/", {
      onFirst: () => {
        throw new Error("boom");
      },
      onLast: () => {
        throw new Error("boom");
      },
    });
    registry.on("git/", recordingHooks(log));

    expect(registry.subscribe("a", ["git/s1"])).toEqual(["git/s1"]);
    expect(registry.isSubscribed("a", "git/s1")).toBe(true);
    registry.unsubscribe("a", ["git/s1"]);
    expect(registry.isSubscribed("a", "git/s1")).toBe(false);
    expect(registry.activeTopics("git/")).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(log).toEqual(["first:git/s1", "sub:a:git/s1", "unsub:a:git/s1", "last:git/s1"]);
    warn.mockRestore();
  });

  it("prefers exact-topic hooks over prefix hooks", () => {
    const registry = new TopicRegistry();
    const prefixLog: string[] = [];
    const exactLog: string[] = [];
    registry.on("github/", recordingHooks(prefixLog));
    registry.on("github/runs", recordingHooks(exactLog));

    registry.subscribe("a", ["github/runs", "github/inbox"]);

    expect(exactLog).toEqual(["first:github/runs", "sub:a:github/runs"]);
    expect(prefixLog).toEqual(["first:github/inbox", "sub:a:github/inbox"]);
  });
});
