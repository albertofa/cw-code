import { describe, expect, it } from "bun:test";
import { TopicHub } from "../topics/TopicHub.js";
import type { HistorySnapshot } from "./HistoryService.js";
import { HistoryTopic } from "./HistoryTopic.js";

function snapshotFor(sha: string): HistorySnapshot {
  return {
    head: { sha, branch: "main", detached: false },
    refs: [{ fullName: "refs/heads/main", name: "main", kind: "local", target: sha, isCurrent: true, upstream: null, ahead: 0, behind: 0, upstreamGone: false }]
  };
}

function setup(roots: Record<string, string> = { s1: "/repo", s2: "/other" }) {
  const hub = new TopicHub(() => {});
  let current: HistorySnapshot | Error = snapshotFor("a".repeat(40));
  const watched: string[][] = [];
  const topic = new HistoryTopic(hub, {
    root: async (sessionId) => {
      const root = roots[sessionId];
      if (!root) throw new Error(`unknown session ${sessionId}`);
      return root;
    },
    snapshot: async () => {
      if (current instanceof Error) throw current;
      return current;
    },
    setWatched: (ids) => watched.push(ids)
  });
  return {
    topic,
    watched,
    set: (next: HistorySnapshot | Error) => {
      current = next;
    }
  };
}

describe("HistoryTopic", () => {
  it("publishes head and refs and bumps rev only when they change", async () => {
    const { topic, set } = setup();
    const store = topic.acquire("history/s1");
    await topic.recompute("s1");
    expect(store.snapshot().data).toMatchObject({ rev: 1, error: null, head: { sha: "a".repeat(40) } });

    await topic.recompute("s1");
    expect(store.snapshot().data.rev).toBe(1);

    set(snapshotFor("b".repeat(40)));
    topic.rootsChanged(["/repo"]);
    await topic.recompute("s1");
    expect(store.snapshot().data).toMatchObject({ rev: 2, head: { sha: "b".repeat(40) } });
  });

  it("only recomputes sessions whose checkout changed", async () => {
    const { topic, set } = setup();
    const first = topic.acquire("history/s1");
    const second = topic.acquire("history/s2");
    await Promise.all([topic.recompute("s1"), topic.recompute("s2")]);
    set(snapshotFor("c".repeat(40)));
    topic.rootsChanged(["/other"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.snapshot().data.head?.sha).toBe("a".repeat(40));
    expect(second.snapshot().data.head?.sha).toBe("c".repeat(40));
  });

  it("shows the failure and bumps rev once it recovers", async () => {
    const { topic, set } = setup();
    const store = topic.acquire("history/s1");
    await topic.recompute("s1");
    set(new Error("fatal: not a git repository"));
    await topic.recompute("s1");
    expect(store.snapshot().data).toMatchObject({ head: null, refs: [], rev: 1, error: "fatal: not a git repository" });
    set(snapshotFor("a".repeat(40)));
    await topic.recompute("s1");
    expect(store.snapshot().data).toMatchObject({ rev: 2, error: null });
  });

  it("reports the subscribed sessions as watched and forgets released ones", () => {
    const { topic, watched } = setup();
    topic.acquire("history/s1");
    topic.acquire("history/s2");
    topic.release("history/s1");
    expect(watched.at(-1)).toEqual(["s2"]);
  });
});
