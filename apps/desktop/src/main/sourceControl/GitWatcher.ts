import { join, relative } from "node:path";
import chokidar from "chokidar";
import type { WatcherHandle } from "../fs/FileWatcher.js";
import { comparableRoot } from "../sessions/worktreeCleanup.js";
import { gitWatchEventKind } from "./gitActivity.js";

export type { WatcherHandle };

export interface GitWatchRoot {
  root: string;
  gitDir: string;
  commonDir: string;
}

export type GitWatchFactory = (base: string, opts: { recursive: boolean }) => WatcherHandle;

export interface GitWatcherOptions {
  factory?: GitWatchFactory;
  debounceMs?: number;
  warn?: (msg: string) => void;
}

interface WatchSpec {
  base: string;
  relativeTo: string;
  recursive: boolean;
}

interface TargetPlan {
  specs: WatchSpec[];
  roots: Map<string, string>;
}

interface WatchTarget {
  roots: Map<string, string>;
  handles: WatcherHandle[];
  timer: NodeJS.Timeout | null;
  firstPendingAt: number | null;
  warned: Set<string>;
  closed: boolean;
}

export const GIT_WATCH_DEBOUNCE_MS = 300;
const GIT_WATCH_MAX_WAIT_MS = 1_500;

export const gitChokidarFactory: GitWatchFactory = (base, { recursive }) => {
  const watcher = chokidar.watch(base, {
    ...(recursive ? {} : { depth: 0 }),
    ignoreInitial: true,
    awaitWriteFinish: false,
  });
  return {
    add: (added) => void watcher.add(added),
    on(event: "all" | "error", cb: (...args: never[]) => void) {
      watcher.on(event, cb as never);
    },
    close: () => watcher.close(),
  };
};

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function desiredTargets(entries: GitWatchRoot[]): Map<string, TargetPlan> {
  const targets = new Map<string, TargetPlan>();
  const add = (key: string, specs: WatchSpec[], entry: GitWatchRoot): void => {
    const target = targets.get(key) ?? { specs, roots: new Map<string, string>() };
    target.roots.set(comparableRoot(entry.root), entry.root);
    targets.set(key, target);
  };
  for (const entry of entries) {
    const commonKey = comparableRoot(entry.commonDir);
    add(
      `common:${commonKey}`,
      [
        { base: entry.commonDir, relativeTo: entry.commonDir, recursive: false },
        { base: join(entry.commonDir, "refs", "heads"), relativeTo: entry.commonDir, recursive: true },
        { base: join(entry.commonDir, "refs", "remotes"), relativeTo: entry.commonDir, recursive: true },
      ],
      entry,
    );
    const gitKey = comparableRoot(entry.gitDir);
    if (gitKey !== commonKey) {
      add(`git:${gitKey}`, [{ base: entry.gitDir, relativeTo: entry.gitDir, recursive: false }], entry);
    }
  }
  return targets;
}

export class GitWatcher {
  private readonly targets = new Map<string, WatchTarget>();
  private readonly factory: GitWatchFactory;
  private readonly debounceMs: number;
  private readonly warn: (msg: string) => void;

  constructor(
    private readonly onChange: (roots: string[]) => void,
    opts: GitWatcherOptions = {},
  ) {
    this.factory = opts.factory ?? gitChokidarFactory;
    this.debounceMs = opts.debounceMs ?? GIT_WATCH_DEBOUNCE_MS;
    this.warn = opts.warn ?? ((msg) => console.warn(msg));
  }

  setRoots(entries: GitWatchRoot[]): void {
    const desired = desiredTargets(entries);
    for (const [key, target] of this.targets) {
      if (desired.has(key)) continue;
      this.targets.delete(key);
      void this.closeTarget(target);
    }
    for (const [key, next] of desired) {
      const existing = this.targets.get(key);
      if (existing) {
        existing.roots = next.roots;
        continue;
      }
      this.targets.set(key, this.openTarget(next));
    }
  }

  async dispose(): Promise<void> {
    const targets = [...this.targets.values()];
    this.targets.clear();
    await Promise.all(targets.map((target) => this.closeTarget(target)));
  }

  private openTarget(plan: TargetPlan): WatchTarget {
    const target: WatchTarget = { roots: plan.roots, handles: [], timer: null, firstPendingAt: null, warned: new Set(), closed: false };
    for (const spec of plan.specs) {
      const handle = this.factory(spec.base, { recursive: spec.recursive });
      target.handles.push(handle);
      handle.on("all", (_event, absPath) => this.record(target, spec, absPath));
      handle.on("error", (err) => this.reportError(target, spec, err));
    }
    return target;
  }

  private record(target: WatchTarget, spec: WatchSpec, absPath: string): void {
    if (target.closed) return;
    const rel = relative(spec.relativeTo, absPath);
    if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../")) return;
    if (gitWatchEventKind(rel) !== "relevant") return;
    const now = Date.now();
    target.firstPendingAt ??= now;
    const remaining = Math.max(0, GIT_WATCH_MAX_WAIT_MS - (now - target.firstPendingAt));
    if (target.timer) clearTimeout(target.timer);
    target.timer = setTimeout(() => this.flush(target), Math.min(this.debounceMs, remaining));
  }

  private flush(target: WatchTarget): void {
    target.timer = null;
    target.firstPendingAt = null;
    if (target.closed) return;
    const roots = [...target.roots.values()];
    if (roots.length > 0) this.onChange(roots);
  }

  private reportError(target: WatchTarget, spec: WatchSpec, err: unknown): void {
    if (target.warned.has(spec.base)) return;
    target.warned.add(spec.base);
    this.warn(`[git-watcher] watcher error for ${spec.base}: ${describeError(err)}`);
  }

  private async closeTarget(target: WatchTarget): Promise<void> {
    target.closed = true;
    if (target.timer) clearTimeout(target.timer);
    target.timer = null;
    target.firstPendingAt = null;
    await Promise.all(
      target.handles.map(async (handle) => {
        try {
          await handle.close();
        } catch (err) {
          this.warn(`[git-watcher] close failed: ${describeError(err)}`);
        }
      }),
    );
  }
}
