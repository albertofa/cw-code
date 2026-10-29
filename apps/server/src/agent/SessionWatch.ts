import type { SessionMeta, SessionStatus } from "@cw-code/contracts";
import type { SettledTurnEvent } from "../threads/ThreadService.js";

export interface WaitResult {
  status: SessionStatus;
  lastResultText: string | null;
  timedOut: boolean;
}

interface SessionWatchDeps {
  getSession(id: string): SessionMeta | undefined;
}

interface Waiter {
  sessionId: string;
  settle(result: { status: SessionStatus | null; timedOut: boolean }): void;
}

export class SessionWatch {
  private readonly results = new Map<string, string | null>();
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly deps: SessionWatchDeps) {}

  sessionChanged(meta: SessionMeta): void {
    if (meta.status === "working") return;
    const settling = [...this.waiters].filter((waiter) => waiter.sessionId === meta.id);
    if (settling.length === 0) return;
    queueMicrotask(() => {
      for (const waiter of settling) waiter.settle({ status: meta.status, timedOut: false });
    });
  }

  turnSettled(sessionId: string, event: SettledTurnEvent): void {
    this.results.set(sessionId, event.type === "turn.done" ? event.resultText : event.message || null);
  }

  lastResult(sessionId: string): string | null {
    return this.results.get(sessionId) ?? null;
  }

  wait(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const session = this.deps.getSession(sessionId);
    if (!session) return Promise.reject(new Error(`unknown session ${sessionId}`));
    if (session.status !== "working") return Promise.resolve(this.resultOf(sessionId, session.status, false));

    return new Promise<WaitResult>((resolve) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
      };
      const waiter: Waiter = {
        sessionId,
        settle: (result) => {
          cleanup();
          const status = result.status ?? this.deps.getSession(sessionId)?.status ?? "working";
          resolve(this.resultOf(sessionId, status, result.timedOut));
        }
      };
      const onAbort = (): void => waiter.settle({ status: null, timedOut: true });
      const timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
      if (signal?.aborted) onAbort();
    });
  }

  dispose(): void {
    for (const waiter of [...this.waiters]) waiter.settle({ status: null, timedOut: true });
  }

  private resultOf(sessionId: string, status: SessionStatus, timedOut: boolean): WaitResult {
    return { status, lastResultText: this.lastResult(sessionId), timedOut };
  }
}
