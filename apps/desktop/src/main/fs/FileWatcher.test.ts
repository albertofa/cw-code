import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FsChangeEvent } from "@cw-code/contracts";
import { FileWatcher, type WatchFactory, type WatcherHandle } from "./FileWatcher.js";

class FakeHandle implements WatcherHandle {
  added: string[][] = [];
  closed = false;
  private allCb: (event: string, absPath: string) => void = () => {};
  private errorCb: (err: unknown) => void = () => {};

  constructor(
    readonly root: string,
    readonly initial: string[],
  ) {}

  add(paths: string[]): void {
    this.added.push(paths);
  }

  on(event: "all", cb: (event: string, absPath: string) => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: "all" | "error", cb: (...args: never[]) => void): void {
    if (event === "all") this.allCb = cb as (event: string, absPath: string) => void;
    else this.errorCb = cb as (err: unknown) => void;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  fire(absPath: string, event = "change"): void {
    this.allCb(event, absPath);
  }

  fail(err: unknown): void {
    this.errorCb(err);
  }
}

describe("FileWatcher", () => {
  const root = resolve("workspace-root");
  const abs = (rel: string) => join(root, rel);
  let handles: FakeHandle[];
  let events: FsChangeEvent[];
  let warnings: string[];
  let watcher: FileWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    handles = [];
    events = [];
    warnings = [];
    const factory: WatchFactory = (factoryRoot, paths) => {
      const handle = new FakeHandle(factoryRoot, paths);
      handles.push(handle);
      return handle;
    };
    watcher = new FileWatcher((event) => events.push(event), { factory, warn: (msg) => warnings.push(msg) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the watcher with absolute paths and the root for an empty relative path", () => {
    watcher.setWatched("s1", root, ["", "src", "src/a.ts"]);
    expect(handles).toHaveLength(1);
    expect(handles[0].initial).toEqual([root, abs("src"), abs("src/a.ts")]);
  });

  it("adds new paths to the existing watcher", () => {
    watcher.setWatched("s1", root, ["", "src"]);
    watcher.setWatched("s1", root, ["", "src", "lib", "lib/x.ts"]);
    expect(handles).toHaveLength(1);
    expect(handles[0].added).toEqual([[abs("lib"), abs("lib/x.ts")]]);
    expect(handles[0].closed).toBe(false);
  });

  it("recreates the watcher with the full set when a path is removed", () => {
    watcher.setWatched("s1", root, ["", "src", "lib"]);
    watcher.setWatched("s1", root, ["", "lib", "docs"]);
    expect(handles).toHaveLength(2);
    expect(handles[0].closed).toBe(true);
    expect(handles[1].closed).toBe(false);
    expect(handles[1].root).toBe(root);
    expect(handles[1].initial).toEqual([root, abs("lib"), abs("docs")]);
    expect(handles[1].added).toEqual([]);
  });

  it("reports events from the new watcher and ignores the replaced one", () => {
    watcher.setWatched("s1", root, ["", "src"]);
    watcher.setWatched("s1", root, [""]);
    handles[0].fire(abs("stale.txt"));
    handles[1].fire(abs("fresh.txt"));
    vi.advanceTimersByTime(150);
    expect(events).toEqual([{ sessionId: "s1", paths: ["fresh.txt"] }]);
  });

  it("does not touch the watcher when the set is unchanged", () => {
    watcher.setWatched("s1", root, ["", "src"]);
    watcher.setWatched("s1", root, ["src", ""]);
    expect(handles).toHaveLength(1);
    expect(handles[0].added).toEqual([]);
    expect(handles[0].closed).toBe(false);
  });

  it("recreates the watcher when the root changes", () => {
    const otherRoot = resolve("other-root");
    watcher.setWatched("s1", root, ["src"]);
    watcher.setWatched("s1", otherRoot, ["src"]);
    expect(handles).toHaveLength(2);
    expect(handles[0].closed).toBe(true);
    expect(handles[1].initial).toEqual([join(otherRoot, "src")]);
  });

  it("keeps independent watchers per session", () => {
    watcher.setWatched("s1", root, ["src"]);
    watcher.setWatched("s2", root, ["lib"]);
    expect(handles).toHaveLength(2);
    handles[1].fire(abs("lib/a.ts"));
    vi.advanceTimersByTime(150);
    expect(events).toEqual([{ sessionId: "s2", paths: ["lib/a.ts"] }]);
  });

  it("coalesces and dedupes events within the debounce window", () => {
    watcher.setWatched("s1", root, ["", "src"]);
    handles[0].fire(abs("src/a.ts"), "change");
    vi.advanceTimersByTime(100);
    handles[0].fire(abs("src/b.ts"), "add");
    handles[0].fire(abs("src/a.ts"), "change");
    vi.advanceTimersByTime(149);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([{ sessionId: "s1", paths: ["src/a.ts", "src/b.ts"] }]);
  });

  it("flushes at the max wait under continuous events", () => {
    watcher.setWatched("s1", root, [""]);
    for (let i = 0; i < 20; i++) {
      handles[0].fire(abs(`f${i}.txt`));
      vi.advanceTimersByTime(100);
    }
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].paths).toHaveLength(10);
  });

  it("emits again after a flush", () => {
    watcher.setWatched("s1", root, [""]);
    handles[0].fire(abs("a.txt"));
    vi.advanceTimersByTime(150);
    handles[0].fire(abs("b.txt"));
    vi.advanceTimersByTime(150);
    expect(events).toEqual([
      { sessionId: "s1", paths: ["a.txt"] },
      { sessionId: "s1", paths: ["b.txt"] },
    ]);
  });

  it("honors a custom debounce", () => {
    const custom = new FileWatcher((event) => events.push(event), {
      debounceMs: 20,
      factory: (factoryRoot, paths) => {
        const handle = new FakeHandle(factoryRoot, paths);
        handles.push(handle);
        return handle;
      },
    });
    custom.setWatched("s1", root, [""]);
    handles[0].fire(abs("a.txt"));
    vi.advanceTimersByTime(20);
    expect(events).toHaveLength(1);
  });

  it("converts absolute paths to root-relative paths with forward slashes", () => {
    watcher.setWatched("s1", root, [""]);
    handles[0].fire(`${root}/deep/dir/file.ts`);
    handles[0].fire(join(root, "deep", "dir", "other.ts"));
    vi.advanceTimersByTime(150);
    expect(events[0].paths).toEqual(["deep/dir/file.ts", "deep/dir/other.ts"]);
  });

  it("maps the root entry itself to an empty path", () => {
    watcher.setWatched("s1", root, [""]);
    handles[0].fire(root, "unlinkDir");
    vi.advanceTimersByTime(150);
    expect(events).toEqual([{ sessionId: "s1", paths: [""] }]);
  });

  it("drops events outside the root", () => {
    watcher.setWatched("s1", root, [""]);
    handles[0].fire(resolve("elsewhere", "a.txt"));
    vi.advanceTimersByTime(150);
    expect(events).toEqual([]);
  });

  it("drops invalid paths with a warning", () => {
    watcher.setWatched("s1", root, ["../escape", "//server/share", "src"]);
    expect(handles[0].initial).toEqual([abs("src")]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("../escape");
  });

  it("routes watcher errors to warn without throwing", () => {
    watcher.setWatched("s1", root, [""]);
    expect(() => handles[0].fail(new Error("EMFILE"))).not.toThrow();
    expect(warnings).toEqual([expect.stringContaining("EMFILE")]);
  });

  it("closes the watcher and discards pending events on unwatch", async () => {
    watcher.setWatched("s1", root, [""]);
    handles[0].fire(abs("a.txt"));
    await watcher.unwatch("s1");
    vi.advanceTimersByTime(500);
    expect(handles[0].closed).toBe(true);
    expect(events).toEqual([]);
  });

  it("ignores events from a closed watcher after a root change", () => {
    const otherRoot = resolve("other-root");
    watcher.setWatched("s1", root, [""]);
    watcher.setWatched("s1", otherRoot, [""]);
    handles[0].fire(abs("stale.txt"));
    vi.advanceTimersByTime(150);
    expect(events).toEqual([]);
  });

  it("unwatch of an unknown session is a no-op", async () => {
    await expect(watcher.unwatch("missing")).resolves.toBeUndefined();
  });

  it("dispose closes every session", async () => {
    watcher.setWatched("s1", root, [""]);
    watcher.setWatched("s2", root, [""]);
    await watcher.dispose();
    expect(handles.every((handle) => handle.closed)).toBe(true);
  });

  it("creates a fresh watcher after unwatch", async () => {
    watcher.setWatched("s1", root, ["src"]);
    await watcher.unwatch("s1");
    watcher.setWatched("s1", root, ["src"]);
    expect(handles).toHaveLength(2);
  });
});

describe("FileWatcher with chokidar", () => {
  let base: string;
  let root: string;
  let watcher: FileWatcher | null = null;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "cw-code-watch-")));
    root = join(base, "node_modules", "workspace");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "0");
  });

  afterEach(async () => {
    await watcher?.dispose();
    watcher = null;
    await rm(base, { recursive: true, force: true });
  });

  it("keeps reporting changes after a path is removed from the set and added back", async () => {
    const events: FsChangeEvent[] = [];
    watcher = new FileWatcher((event) => events.push(event), { debounceMs: 20 });
    watcher.setWatched("s1", root, ["", "src"]);
    watcher.setWatched("s1", root, [""]);
    watcher.setWatched("s1", root, ["", "src"]);

    let counter = 0;
    await vi.waitFor(
      async () => {
        await writeFile(join(root, "src", "a.ts"), String(++counter));
        expect(events.flatMap((event) => event.paths)).toContain("src/a.ts");
      },
      { timeout: 10_000, interval: 300 },
    );
  }, 15_000);
});
