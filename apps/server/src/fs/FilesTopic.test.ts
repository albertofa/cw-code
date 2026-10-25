import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { FilesTopicData, GitDecorations } from "@cw-code/contracts";
import { filesTopic } from "@cw-code/shared/topics";
import { advanceTimersByTimeAsync } from "../../tests/testing.js";
import { TopicHub } from "../topics/TopicHub.js";
import { FilesTopic, type FilesTopicDeps } from "./FilesTopic.js";

const CTX = { clientId: "c1", client: "web" as const, auth: { kind: "owner" as const } };
const TOPIC = filesTopic("s1");

function decorations(...paths: string[]): GitDecorations {
  return { available: true, entries: paths.map((path) => ({ path, state: "modified", isDir: false })) };
}

function setup(overrides: Partial<FilesTopicDeps> = {}) {
  let current = decorations("a.ts");
  const computed: string[] = [];
  const watched: Array<{ sessionId: string; root: string; paths: string[] }> = [];
  const unwatched: string[] = [];
  const hub = new TopicHub(() => {});
  const files = new FilesTopic(hub, {
    ensureWorktree: async (sessionId) => `/root/${sessionId}`,
    decorations: async (root) => {
      computed.push(root);
      return current;
    },
    clientPaths: () => ["", "src"],
    clearClientPaths: () => undefined,
    watch: (sessionId, root, paths) => watched.push({ sessionId, root, paths }),
    unwatch: (sessionId) => unwatched.push(sessionId),
    ...overrides
  });
  hub.register(files);
  return {
    hub,
    files,
    computed,
    watched,
    unwatched,
    data: (): Partial<FilesTopicData> => hub.subscribe(CTX, [TOPIC])[TOPIC].data as Partial<FilesTopicData>,
    setDecorations: (next: GitDecorations) => {
      current = next;
    }
  };
}

describe("FilesTopic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("computes the decorations 250 ms after the topic opens", async () => {
    const ctx = setup();
    expect(ctx.data()).toEqual({});
    await advanceTimersByTimeAsync(249);
    expect(ctx.computed).toEqual([]);
    await advanceTimersByTimeAsync(1);
    expect(ctx.computed).toEqual(["/root/s1"]);
    expect(ctx.data()).toEqual({ decorations: decorations("a.ts") });
  });

  test("a burst of file events causes one recompute", async () => {
    const ctx = setup();
    ctx.data();
    await advanceTimersByTimeAsync(250);
    ctx.setDecorations(decorations("a.ts", "b.ts"));
    for (let index = 0; index < 20; index += 1) {
      ctx.files.changed("s1");
      await advanceTimersByTimeAsync(5);
    }
    await advanceTimersByTimeAsync(250);
    expect(ctx.computed).toHaveLength(2);
    expect(ctx.data()).toEqual({ decorations: decorations("a.ts", "b.ts") });
  });

  test("a git publish causes one recompute, and so does a mix of publishes and file events", async () => {
    const ctx = setup();
    ctx.data();
    await advanceTimersByTimeAsync(250);
    ctx.setDecorations(decorations("c.ts"));
    ctx.files.gitPublished("s1");
    ctx.files.changed("s1");
    ctx.files.gitPublished("s1");
    await advanceTimersByTimeAsync(250);
    expect(ctx.computed).toHaveLength(2);
    expect(ctx.data()).toEqual({ decorations: decorations("c.ts") });
  });

  test("events for sessions without a subscriber compute nothing", async () => {
    const ctx = setup();
    ctx.files.changed("s1");
    ctx.files.gitPublished("s2");
    await advanceTimersByTimeAsync(1000);
    expect(ctx.computed).toEqual([]);
  });

  test("an event during a computation triggers exactly one follow-up", async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const ctx = setup({
      decorations: () => {
        calls += 1;
        const result = decorations(`f${calls}.ts`);
        return new Promise<GitDecorations>((resolve) => {
          release = () => resolve(result);
        });
      }
    });
    ctx.data();
    await advanceTimersByTimeAsync(250);
    expect(calls).toBe(1);
    ctx.files.changed("s1");
    await advanceTimersByTimeAsync(250);
    ctx.files.changed("s1");
    await advanceTimersByTimeAsync(250);
    expect(calls).toBe(1);
    release();
    await advanceTimersByTimeAsync(250);
    expect(calls).toBe(2);
    release();
    await advanceTimersByTimeAsync(250);
    expect(calls).toBe(2);
    expect(ctx.data()).toEqual({ decorations: decorations("f2.ts") });
  });

  test("releasing the topic stops recomputes and unwatches the session", async () => {
    const ctx = setup();
    ctx.data();
    await advanceTimersByTimeAsync(250);
    ctx.hub.unsubscribe(CTX, [TOPIC]);
    expect(ctx.unwatched).toEqual(["s1"]);
    ctx.files.changed("s1");
    await advanceTimersByTimeAsync(1000);
    expect(ctx.computed).toHaveLength(1);
  });

  test("watches the union of the client paths while subscribed", async () => {
    const ctx = setup();
    ctx.data();
    await advanceTimersByTimeAsync(0);
    expect(ctx.watched).toEqual([{ sessionId: "s1", root: "/root/s1", paths: ["", "src"] }]);
  });

  test("dispose stops pending recomputes and resync resumes them", async () => {
    const ctx = setup();
    ctx.data();
    await advanceTimersByTimeAsync(250);
    ctx.files.changed("s1");
    ctx.files.dispose();
    await advanceTimersByTimeAsync(1000);
    expect(ctx.computed).toHaveLength(1);
    ctx.hub.resync();
    await advanceTimersByTimeAsync(250);
    expect(ctx.computed).toHaveLength(2);
  });

  test("a failing computation keeps the previous decorations", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fail = false;
    const ctx = setup({
      decorations: async () => {
        if (fail) throw new Error("git missing");
        return decorations("a.ts");
      }
    });
    ctx.data();
    await advanceTimersByTimeAsync(250);
    fail = true;
    ctx.files.changed("s1");
    await advanceTimersByTimeAsync(250);
    expect(ctx.data()).toEqual({ decorations: decorations("a.ts") });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
