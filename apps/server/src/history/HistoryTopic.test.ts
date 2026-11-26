import { describe, expect, it } from "bun:test";
import { TopicHub } from "../topics/TopicHub.js";
import type { HistorySnapshot } from "./HistoryService.js";
import { HistoryTopic } from "./HistoryTopic.js";

function snapshotFor(sha: string): HistorySnapshot {
  return {
    head: { sha, branch: "main", detached: false },
    refs: [{ fullName: "refs/heads/main", name: "main", kind: "local", target: sha, isCurrent: true, upstream: null, ahead: 0, behind: 0, upstreamGone: false }],
    stashes: [],
    fetchedAt: null
  };
}

const KEY = "0123456789abcdef";

function setup(roots: Record<string, string> = { s1: "/repo", s2: "/other", [`s1:${KEY}`]: "/wt/feature", "project.p1": "/proj", [`project.p1:${KEY}`]: "/proj-wt" }) {
  const hub = new TopicHub(() => {});
  let current: HistorySnapshot | Error = snapshotFor("a".repeat(40));
  let wip = 0;
  const watched: string[][] = [];
  const watchedRoots: string[][] = [];
  const snapshots: Array<[string, boolean]> = [];
  const topic = new HistoryTopic(hub, {
    root: async (scope, key) => {
      const id = "projectId" in scope ? `project.${scope.projectId}` : scope.sessionId;
      const root = roots[key === null ? id : `${id}:${key}`];
      if (!root) throw new Error(`unknown session ${id}`);
      return root;
    },
    snapshot: async (root, withWip) => {
      snapshots.push([root, withWip]);
      if (current instanceof Error) throw current;
      return withWip ? { ...current, wipCount: wip } : current;
    },
    setWatched: (ids, worktreeRoots) => {
      watched.push(ids);
      watchedRoots.push(worktreeRoots);
    }
  });
  return {
    topic,
    watched,
    watchedRoots,
    snapshots,
    setWip: (value: number) => {
      wip = value;
    },
    set: (next: HistorySnapshot | Error) => {
      current = next;
    }
  };
}

describe("HistoryTopic", () => {
  it("publishes head and refs and bumps rev only when they change", async () => {
    const { topic, set } = setup();
    const store = topic.acquire("history/s1");
    await topic.recompute("history/s1");
    expect(store.snapshot().data).toMatchObject({ rev: 1, error: null, head: { sha: "a".repeat(40) } });

    await topic.recompute("history/s1");
    expect(store.snapshot().data.rev).toBe(1);

    set(snapshotFor("b".repeat(40)));
    topic.rootsChanged(["/repo"]);
    await topic.recompute("history/s1");
    expect(store.snapshot().data).toMatchObject({ rev: 2, head: { sha: "b".repeat(40) } });
  });

  it("publishes fetchedAt and bumps rev when it changes", async () => {
    const { topic, set } = setup();
    const store = topic.acquire("history/s1");
    await topic.recompute("history/s1");
    expect(store.snapshot().data).toMatchObject({ rev: 1, fetchedAt: null });

    set({ ...snapshotFor("a".repeat(40)), fetchedAt: 1_700_000_000_000 });
    await topic.recompute("history/s1");
    expect(store.snapshot().data).toMatchObject({ rev: 2, fetchedAt: 1_700_000_000_000 });
  });

  it("bumps rev when only the stash list changes", async () => {
    const { topic, set } = setup();
    const store = topic.acquire("history/s1");
    await topic.recompute("history/s1");
    expect(store.snapshot().data.rev).toBe(1);

    set({ ...snapshotFor("a".repeat(40)), stashes: ["c".repeat(40)] });
    await topic.recompute("history/s1");
    expect(store.snapshot().data.rev).toBe(2);
  });

  it("only recomputes sessions whose checkout changed", async () => {
    const { topic, set } = setup();
    const first = topic.acquire("history/s1");
    const second = topic.acquire("history/s2");
    await Promise.all([topic.recompute("history/s1"), topic.recompute("history/s2")]);
    set(snapshotFor("c".repeat(40)));
    topic.rootsChanged(["/other"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.snapshot().data.head?.sha).toBe("a".repeat(40));
    expect(second.snapshot().data.head?.sha).toBe("c".repeat(40));
  });

  it("shows the failure and bumps rev once it recovers", async () => {
    const { topic, set } = setup();
    const store = topic.acquire("history/s1");
    await topic.recompute("history/s1");
    set(new Error("fatal: not a git repository"));
    await topic.recompute("history/s1");
    expect(store.snapshot().data).toMatchObject({ head: null, refs: [], rev: 1, error: "fatal: not a git repository" });
    set(snapshotFor("a".repeat(40)));
    await topic.recompute("history/s1");
    expect(store.snapshot().data).toMatchObject({ rev: 2, error: null });
  });

  it("reports the subscribed sessions as watched and forgets released ones", () => {
    const { topic, watched } = setup();
    topic.acquire("history/s1");
    topic.acquire("history/s2");
    topic.release("history/s1");
    expect(watched.at(-1)).toEqual(["s2"]);
  });

  it("follows a worktree topic on the worktree's own root and watches that root", async () => {
    const { topic, watched, watchedRoots, snapshots } = setup();
    const store = topic.acquire(`history/s1:${KEY}`);
    await topic.recompute(`history/s1:${KEY}`);
    expect(store.snapshot().data.rev).toBe(1);
    expect(snapshots.at(-1)).toEqual(["/wt/feature", true]);
    expect(watched.at(-1)).toEqual(["s1"]);
    expect(watchedRoots.at(-1)).toEqual(["/wt/feature"]);

    topic.release(`history/s1:${KEY}`);
    expect(watchedRoots.at(-1)).toEqual([]);
  });

  it("bumps a worktree topic's rev when only its uncommitted changes change", async () => {
    const { topic, setWip } = setup();
    const worktree = topic.acquire(`history/s1:${KEY}`);
    const session = topic.acquire("history/s1");
    await Promise.all([topic.recompute(`history/s1:${KEY}`), topic.recompute("history/s1")]);

    setWip(2);
    topic.pollWorktrees();
    topic.sessionChanged("s1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worktree.snapshot().data.rev).toBe(2);
    expect(session.snapshot().data.rev).toBe(1);
  });

  it("recomputes a worktree topic when its own checkout changes", async () => {
    const { topic, set } = setup();
    const worktree = topic.acquire(`history/s1:${KEY}`);
    await topic.recompute(`history/s1:${KEY}`);
    set(snapshotFor("d".repeat(40)));
    topic.rootsChanged(["/wt/feature"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worktree.snapshot().data).toMatchObject({ rev: 2, head: { sha: "d".repeat(40) } });
  });

  it("announces resolved avatars on every topic without bumping rev", async () => {
    const { topic } = setup();
    const store = topic.acquire("history/s1");
    await topic.recompute("history/s1");
    topic.avatarsChanged();
    expect(store.snapshot().data).toMatchObject({ rev: 1, avatarsRev: 1, head: { sha: "a".repeat(40) } });
  });

  it("watches a project topic as a root, without a session id, and refreshes it on poll", async () => {
    const { topic, watched, watchedRoots, snapshots, setWip } = setup();
    const store = topic.acquire("history/project.p1");
    await topic.recompute("history/project.p1");
    expect(snapshots.at(-1)).toEqual(["/proj", true]);
    expect(watched.at(-1)).toEqual([]);
    expect(watchedRoots.at(-1)).toEqual(["/proj"]);
    expect(store.snapshot().data.rev).toBe(1);

    setWip(4);
    topic.pollWorktrees();
    topic.sessionChanged("p1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.snapshot().data.rev).toBe(2);
  });

  it("resolves a worktree under a project scope", async () => {
    const { topic, watchedRoots, snapshots } = setup();
    topic.acquire(`history/project.p1:${KEY}`);
    await topic.recompute(`history/project.p1:${KEY}`);
    expect(snapshots.at(-1)).toEqual(["/proj-wt", true]);
    expect(watchedRoots.at(-1)).toEqual(["/proj-wt"]);
  });

  it("rejects a malformed worktree key", () => {
    const { topic } = setup();
    expect(() => topic.acquire("history/s1:not-a-key")).toThrow("invalid history topic");
  });
});
