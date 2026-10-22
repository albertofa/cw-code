import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { GitWatcher, type GitWatchFactory, type GitWatchRoot, type WatcherHandle } from "./GitWatcher.js";

class FakeHandle implements WatcherHandle {
  closed = false;
  private allCb: (event: string, absPath: string) => void = () => {};
  private errorCb: (err: unknown) => void = () => {};

  constructor(
    readonly base: string,
    readonly recursive: boolean,
  ) {}

  add(): void {}

  on(event: "all", cb: (event: string, absPath: string) => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: "all" | "error", cb: (...args: never[]) => void): void {
    if (event === "all") this.allCb = cb as (event: string, absPath: string) => void;
    else this.errorCb = cb as (err: unknown) => void;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  fire(absPath: string): void {
    this.allCb("change", absPath);
  }

  fail(err: unknown): void {
    this.errorCb(err);
  }
}

const COMMON = resolve("/repo/.git");
const GIT_DIR_A = join(COMMON, "worktrees", "a");
const GIT_DIR_B = join(COMMON, "worktrees", "b");
const ROOT_MAIN: GitWatchRoot = { root: resolve("/repo"), gitDir: COMMON, commonDir: COMMON };
const ROOT_A: GitWatchRoot = { root: resolve("/wt/a"), gitDir: GIT_DIR_A, commonDir: COMMON };
const ROOT_B: GitWatchRoot = { root: resolve("/wt/b"), gitDir: GIT_DIR_B, commonDir: COMMON };

describe("GitWatcher", () => {
  let handles: FakeHandle[];
  let factory: GitWatchFactory;
  let onChange: ReturnType<typeof vi.fn<(roots: string[]) => void>>;
  let warn: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let watcher: GitWatcher;

  const handleFor = (base: string): FakeHandle => {
    const handle = handles.find((candidate) => candidate.base === base && !candidate.closed);
    if (!handle) throw new Error(`no open handle for ${base}`);
    return handle;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    handles = [];
    factory = (base, { recursive }) => {
      const handle = new FakeHandle(base, recursive);
      handles.push(handle);
      return handle;
    };
    onChange = vi.fn();
    warn = vi.fn();
    watcher = new GitWatcher(onChange, { factory, debounceMs: 300, warn });
  });

  afterEach(async () => {
    await watcher.dispose();
    vi.useRealTimers();
  });

  it("opens one non-recursive commonDir watcher and one recursive refs watcher shared by worktrees", () => {
    watcher.setRoots([ROOT_A, ROOT_B]);

    expect(handles.filter((handle) => handle.base === COMMON)).toHaveLength(1);
    expect(handleFor(COMMON).recursive).toBe(false);
    expect(handleFor(join(COMMON, "refs")).recursive).toBe(true);
    expect(handleFor(GIT_DIR_A).recursive).toBe(false);
    expect(handleFor(GIT_DIR_B).recursive).toBe(false);
    expect(handles).toHaveLength(4);
  });

  it("does not open a second watcher when gitDir equals commonDir", () => {
    watcher.setRoots([ROOT_MAIN]);

    expect(handles.map((handle) => handle.base).sort()).toEqual([COMMON, join(COMMON, "refs")].sort());
  });

  it("notifies every root sharing the commonDir on a refs change", () => {
    watcher.setRoots([ROOT_A, ROOT_B]);

    handleFor(join(COMMON, "refs")).fire(join(COMMON, "refs", "heads", "cw", "x"));
    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...onChange.mock.calls[0][0]].sort()).toEqual([ROOT_A.root, ROOT_B.root].sort());
  });

  it("notifies on packed-refs and config in the commonDir", () => {
    watcher.setRoots([ROOT_A]);

    handleFor(COMMON).fire(join(COMMON, "packed-refs"));
    vi.advanceTimersByTime(300);
    handleFor(COMMON).fire(join(COMMON, "config"));
    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("notifies only the owning root when HEAD changes in a worktree gitDir", () => {
    watcher.setRoots([ROOT_A, ROOT_B]);

    handleFor(GIT_DIR_A).fire(join(GIT_DIR_A, "HEAD"));
    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([ROOT_A.root]);
  });

  it("matches shared directories regardless of path casing and trailing separators on case-insensitive platforms", () => {
    const variant: GitWatchRoot = { ...ROOT_B, commonDir: `${COMMON}/`, gitDir: GIT_DIR_B };
    watcher.setRoots([ROOT_A, variant]);

    expect(handles.filter((handle) => handle.base === join(COMMON, "refs"))).toHaveLength(1);
  });

  it.each([
    ["index", (dir: string) => join(dir, "index")],
    ["lock file", (dir: string) => join(dir, "HEAD.lock")],
    ["objects", (dir: string) => join(dir, "objects", "ab", "cdef")],
    ["logs", (dir: string) => join(dir, "logs", "HEAD")],
    ["hooks", (dir: string) => join(dir, "hooks", "pre-commit")],
    ["unrelated file", (dir: string) => join(dir, "COMMIT_EDITMSG")],
  ])("ignores %s events", (_name, pathIn) => {
    watcher.setRoots([ROOT_A]);

    handleFor(COMMON).fire(pathIn(COMMON));
    handleFor(GIT_DIR_A).fire(pathIn(GIT_DIR_A));
    handleFor(join(COMMON, "refs")).fire(join(COMMON, "refs", "heads", "x.lock"));
    vi.advanceTimersByTime(1000);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores events outside the relative base", () => {
    watcher.setRoots([ROOT_A]);

    handleFor(GIT_DIR_A).fire(resolve("/elsewhere/HEAD"));
    vi.advanceTimersByTime(1000);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("coalesces a burst into a single notification after the debounce", () => {
    watcher.setRoots([ROOT_A]);
    const refs = handleFor(join(COMMON, "refs"));

    refs.fire(join(COMMON, "refs", "heads", "a"));
    vi.advanceTimersByTime(200);
    refs.fire(join(COMMON, "refs", "heads", "b"));
    vi.advanceTimersByTime(200);
    handleFor(COMMON).fire(join(COMMON, "packed-refs"));
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("closes handles that are no longer needed and keeps the rest", () => {
    watcher.setRoots([ROOT_A, ROOT_B]);
    const refs = handleFor(join(COMMON, "refs"));
    const gitDirB = handleFor(GIT_DIR_B);

    watcher.setRoots([ROOT_A]);

    expect(gitDirB.closed).toBe(true);
    expect(refs.closed).toBe(false);
    expect(handleFor(GIT_DIR_A).closed).toBe(false);

    refs.fire(join(COMMON, "refs", "heads", "x"));
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledWith([ROOT_A.root]);
  });

  it("closes every handle when all roots are removed and drops pending notifications", () => {
    watcher.setRoots([ROOT_A]);
    handleFor(join(COMMON, "refs")).fire(join(COMMON, "refs", "heads", "x"));

    const opened = [...handles];
    watcher.setRoots([]);
    vi.advanceTimersByTime(1000);

    expect(opened.every((handle) => handle.closed)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores events from a closed handle", () => {
    watcher.setRoots([ROOT_A]);
    const gitDirA = handleFor(GIT_DIR_A);
    watcher.setRoots([]);

    gitDirA.fire(join(GIT_DIR_A, "HEAD"));
    vi.advanceTimersByTime(1000);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("reopens a watcher when a removed root comes back", () => {
    watcher.setRoots([ROOT_A]);
    watcher.setRoots([]);
    watcher.setRoots([ROOT_A]);

    expect(handles).toHaveLength(6);
    expect(handleFor(GIT_DIR_A).closed).toBe(false);
  });

  it("closes everything on dispose", async () => {
    watcher.setRoots([ROOT_A, ROOT_B]);

    await watcher.dispose();

    expect(handles.every((handle) => handle.closed)).toBe(true);
  });

  it("warns once per watched base on errors and keeps working", () => {
    watcher.setRoots([ROOT_A]);
    const gitDirA = handleFor(GIT_DIR_A);

    gitDirA.fail(new Error("EPERM"));
    gitDirA.fail(new Error("EPERM"));
    handleFor(COMMON).fail(new Error("ENOSPC"));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("[git-watcher]");
    expect(warn.mock.calls[0][0]).toContain("EPERM");

    handleFor(join(COMMON, "refs")).fire(join(COMMON, "refs", "heads", "x"));
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
