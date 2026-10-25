import type { Project, SessionMeta, ThreadTurnChanges, TurnChanges } from "@cw-code/contracts";
import { sameRootSessionIds } from "../sessions/sameRoot.js";
import type { ThreadExtras } from "./ThreadService.js";

export interface TurnChangesModelDeps {
  sessions(): SessionMeta[];
  projects(): Project[];
  isOpen(sessionId: string): boolean;
  turnChanges(sessionId: string): Promise<TurnChanges | null>;
  refresh(sessionId: string): void;
}

const LOG_PREFIX = "[turn-changes]";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupByProject(sessions: SessionMeta[]): Record<string, SessionMeta[]> {
  const grouped: Record<string, SessionMeta[]> = {};
  for (const session of sessions) (grouped[session.projectId] ??= []).push(session);
  return grouped;
}

export class TurnChangesModel {
  private readonly cache = new Map<string, ThreadTurnChanges>();
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private readonly rerun = new Set<string>();
  private scheduled = false;

  constructor(private readonly deps: TurnChangesModelDeps) {}

  extras(sessionId: string): ThreadExtras {
    return { turnChanges: this.cache.get(sessionId) ?? null };
  }

  opened(sessionId: string): void {
    if (!this.cache.has(sessionId)) this.queue(sessionId);
  }

  closed(sessionId: string): void {
    if (this.deps.isOpen(sessionId)) return;
    this.cache.delete(sessionId);
    this.queued.delete(sessionId);
    this.rerun.delete(sessionId);
  }

  snapshotChanged(sessionId: string): void {
    for (const id of this.rootSessionIds(sessionId)) {
      if (this.deps.isOpen(id)) this.queue(id);
    }
  }

  private rootSessionIds(sessionId: string): string[] {
    return sameRootSessionIds(groupByProject(this.deps.sessions()), this.deps.projects(), sessionId);
  }

  private queue(sessionId: string): void {
    this.queued.add(sessionId);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    const ids = [...this.queued];
    this.queued.clear();
    for (const id of ids) this.start(id);
  }

  private start(sessionId: string): void {
    if (!this.deps.isOpen(sessionId)) return;
    if (this.running.has(sessionId)) {
      this.rerun.add(sessionId);
      return;
    }
    this.running.add(sessionId);
    void this.drain(sessionId);
  }

  private async drain(sessionId: string): Promise<void> {
    try {
      do {
        this.rerun.delete(sessionId);
        const value = await this.read(sessionId);
        if (!this.deps.isOpen(sessionId)) {
          this.cache.delete(sessionId);
          return;
        }
        this.store(sessionId, value);
      } while (this.rerun.has(sessionId));
    } finally {
      this.running.delete(sessionId);
    }
  }

  private async read(sessionId: string): Promise<ThreadTurnChanges> {
    const rootSessionIds = this.rootSessionIds(sessionId);
    try {
      return { changes: await this.deps.turnChanges(sessionId), error: null, rootSessionIds };
    } catch (error) {
      return { changes: null, error: describeError(error), rootSessionIds };
    }
  }

  private store(sessionId: string, value: ThreadTurnChanges): void {
    const previous = this.cache.get(sessionId);
    this.cache.set(sessionId, value);
    if (previous && JSON.stringify(previous) === JSON.stringify(value)) return;
    try {
      this.deps.refresh(sessionId);
    } catch (error) {
      console.warn(`${LOG_PREFIX} publish for session ${sessionId} failed: ${describeError(error)}`);
    }
  }
}
