import { isAbsolute, relative, resolve, sep } from "node:path";
import chokidar from "chokidar";
import type { FsChangeEvent } from "@cw-code/contracts";
import { resolveFileTarget } from "./FileService.js";

function isOutside(rel: string): boolean {
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
}

export interface WatcherHandle {
  add(paths: string[]): void;
  on(event: "all", cb: (event: string, absPath: string) => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  close(): Promise<void>;
}

export type WatchFactory = (root: string, paths: string[]) => WatcherHandle;

export interface FileWatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  factory?: WatchFactory;
  warn?: (msg: string) => void;
}

interface WatchSession {
  root: string;
  handle: WatcherHandle;
  watched: Set<string>;
  outside: Map<string, string>;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  firstPendingAt: number | null;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_WAIT_MS = 1000;
const IGNORED_DIRS = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;

export const chokidarFactory: WatchFactory = (root, paths) => {
  const watcher = chokidar.watch(paths, {
    depth: 0,
    ignoreInitial: true,
    ignored: (path) => IGNORED_DIRS.test(relative(root, path)),
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

export class FileWatcher {
  private readonly sessions = new Map<string, WatchSession>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly factory: WatchFactory;
  private readonly warn: (msg: string) => void;

  constructor(
    private readonly emit: (event: FsChangeEvent) => void,
    opts: FileWatcherOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.factory = opts.factory ?? chokidarFactory;
    this.warn = opts.warn ?? ((msg) => console.warn(msg));
  }

  setWatched(sessionId: string, root: string, relPaths: string[]): void {
    const absRoot = resolve(root);
    const { watched: next, outside } = this.resolveAll(absRoot, relPaths);
    let session = this.sessions.get(sessionId);
    if (session && session.root !== absRoot) {
      void this.closeSession(session);
      session = undefined;
    }
    if (!session) {
      this.sessions.set(sessionId, this.openSession(sessionId, absRoot, next, outside));
      return;
    }
    const toAdd = [...next].filter((path) => !session.watched.has(path));
    const hasRemoved = [...session.watched].some((path) => !next.has(path));
    session.watched = next;
    session.outside = outside;
    if (hasRemoved) {
      void this.closeHandle(session.handle);
      this.attach(sessionId, session, this.factory(absRoot, [...next]));
    } else if (toAdd.length > 0) {
      session.handle.add(toAdd);
    }
  }

  async unwatch(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await this.closeSession(session);
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this.closeSession(session)));
  }

  private resolveAll(absRoot: string, relPaths: string[]): { watched: Set<string>; outside: Map<string, string> } {
    const watched = new Set<string>();
    const outside = new Map<string, string>();
    for (const relPath of relPaths) {
      try {
        const abs = resolveFileTarget(absRoot, relPath);
        watched.add(abs);
        if (isOutside(relative(absRoot, abs))) outside.set(abs, relPath);
      } catch (err) {
        this.warn(`ignoring watch path "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { watched, outside };
  }

  private openSession(sessionId: string, root: string, watched: Set<string>, outside: Map<string, string>): WatchSession {
    const session: WatchSession = {
      root,
      handle: this.factory(root, [...watched]),
      watched,
      outside,
      pending: new Set(),
      timer: null,
      firstPendingAt: null,
    };
    this.attach(sessionId, session, session.handle);
    return session;
  }

  private attach(sessionId: string, session: WatchSession, handle: WatcherHandle): void {
    session.handle = handle;
    handle.on("all", (_event, absPath) => {
      if (session.handle === handle) this.record(sessionId, session, absPath);
    });
    handle.on("error", (err) => this.warn(`file watcher error: ${err instanceof Error ? err.message : String(err)}`));
  }

  private record(sessionId: string, session: WatchSession, absPath: string): void {
    if (this.sessions.get(sessionId) !== session) return;
    const rel = relative(session.root, absPath);
    const key = isOutside(rel) ? session.outside.get(resolve(absPath)) : rel.replace(/\\/g, "/");
    if (key === undefined) return;
    session.pending.add(key);
    const now = Date.now();
    session.firstPendingAt ??= now;
    const remaining = Math.max(0, this.maxWaitMs - (now - session.firstPendingAt));
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => this.flush(sessionId, session), Math.min(this.debounceMs, remaining));
  }

  private flush(sessionId: string, session: WatchSession): void {
    session.timer = null;
    session.firstPendingAt = null;
    const paths = [...session.pending];
    session.pending.clear();
    if (paths.length === 0 || this.sessions.get(sessionId) !== session) return;
    this.emit({ sessionId, paths });
  }

  private async closeSession(session: WatchSession): Promise<void> {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.firstPendingAt = null;
    session.pending.clear();
    await this.closeHandle(session.handle);
  }

  private async closeHandle(handle: WatcherHandle): Promise<void> {
    try {
      await handle.close();
    } catch (err) {
      this.warn(`file watcher close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
