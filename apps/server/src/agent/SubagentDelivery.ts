import type { SessionMeta, SubagentResult } from "@cw-code/contracts";
import { buildWakePrompt, type WakeEntry } from "@cw-code/shared/subagents";
import { SHUTDOWN_RESERVED_MESSAGE } from "../shutdown/shutdownReservation.js";
import type { SessionRuntime, ThreadNotice } from "../threads/ThreadService.js";

export const SUBAGENT_DELIVERY_NOTICE_ID = "subagent-delivery";

export interface SubagentDeliveryDeps {
  sessions(): SessionMeta[];
  runtime(sessionId: string): Pick<SessionRuntime, "busy" | "approvals" | "questions">;
  startTurn(sessionId: string, prompt: string): Promise<string>;
  markDelivered(childId: string, turnId: string): void;
  postNotice(sessionId: string, notice: ThreadNotice): void;
  shutdownReserved(): boolean;
}

interface PendingResult {
  child: SessionMeta;
  result: SubagentResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function wakeEntry({ child, result }: PendingResult): WakeEntry {
  return { subagentId: child.id, driver: child.driver, title: child.title, outcome: result.outcome, text: result.text };
}

export class SubagentDelivery {
  private readonly starting = new Set<string>();
  private readonly scoped = new Set<string>();
  private everything = false;
  private scheduled = false;
  private posting = false;
  private disposed = false;

  constructor(private readonly deps: SubagentDeliveryDeps) {}

  reevaluate(parentId?: string): void {
    if (this.disposed || this.posting) return;
    if (parentId === undefined) this.everything = true;
    else this.scoped.add(parentId);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const scope = this.everything ? null : new Set(this.scoped);
      this.everything = false;
      this.scoped.clear();
      if (this.disposed) return;
      try {
        this.evaluate(scope);
      } catch (error) {
        console.warn(`[subagent-delivery] evaluation failed: ${errorMessage(error)}`);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  reactivate(): void {
    this.disposed = false;
    this.reevaluate();
  }

  private evaluate(scope: Set<string> | null): void {
    if (this.deps.shutdownReserved()) return;
    const sessions = this.deps.sessions();
    for (const [parentId, pending] of this.undelivered(sessions, scope)) {
      if (this.starting.has(parentId)) continue;
      if (!pending.some(({ result }) => result.outcome !== "interrupted")) continue;
      const parent = sessions.find((session) => session.id === parentId);
      if (!parent || !this.canWake(parent)) continue;
      this.starting.add(parentId);
      void this.wake(parentId, pending).finally(() => this.starting.delete(parentId));
    }
  }

  private undelivered(sessions: SessionMeta[], scope: Set<string> | null): Map<string, PendingResult[]> {
    const byParent = new Map<string, PendingResult[]>();
    for (const child of sessions) {
      const link = child.subagent;
      if (!link?.result || link.delivered === true) continue;
      if (scope && !scope.has(link.parentSessionId)) continue;
      const pending = byParent.get(link.parentSessionId) ?? [];
      pending.push({ child, result: link.result });
      byParent.set(link.parentSessionId, pending);
    }
    for (const pending of byParent.values()) pending.sort((a, b) => a.result.at - b.result.at);
    return byParent;
  }

  private canWake(parent: SessionMeta): boolean {
    if (parent.subagent || parent.status === "resolved" || parent.status === "archived") return false;
    const runtime = this.deps.runtime(parent.id);
    return !runtime.busy && runtime.approvals.length === 0 && runtime.questions.length === 0;
  }

  private async wake(parentId: string, pending: PendingResult[]): Promise<void> {
    try {
      await this.deps.startTurn(parentId, buildWakePrompt(pending.map(wakeEntry)));
    } catch (error) {
      if (errorCode(error) === "session-busy" || errorMessage(error) === SHUTDOWN_RESERVED_MESSAGE) return;
      console.warn(`[subagent-delivery] could not wake session ${parentId}: ${errorMessage(error)}`);
      this.notifyFailure(parentId, error);
      return;
    }
    for (const { child, result } of pending) {
      try {
        this.deps.markDelivered(child.id, result.turnId);
      } catch (error) {
        console.warn(`[subagent-delivery] woke ${parentId} but ${child.id} could not be marked delivered: ${errorMessage(error)}`);
      }
    }
  }

  private notifyFailure(parentId: string, error: unknown): void {
    this.posting = true;
    try {
      this.deps.postNotice(parentId, {
        noticeId: SUBAGENT_DELIVERY_NOTICE_ID,
        text: `Subagent results could not be delivered to this session: ${errorMessage(error)}. cw-code retries the next time the session settles.`,
        severity: "error"
      });
    } catch (noticeError) {
      console.warn(`[subagent-delivery] notice for ${parentId} failed: ${errorMessage(noticeError)}`);
    } finally {
      this.posting = false;
    }
  }
}
