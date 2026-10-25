import type { CommandInvocation, ComposerPrefs, PrRef } from "@cw-code/contracts";
import type { SessionManager } from "../sessions/SessionManager.js";
import { notifyAll, type ThreadService } from "./ThreadService.js";

export interface StartTurnInput {
  prefs?: ComposerPrefs;
  attachments?: string[];
  command?: CommandInvocation;
  skills?: string[];
  prRefs?: PrRef[];
  finalReview?: { ref: PrRef; sha: string };
  acceptFolderHead?: string;
  auto?: boolean;
}

export interface TurnServiceDeps {
  sessions: Pick<SessionManager, "startTurn" | "interrupt" | "listActiveTurns">;
  threads: ThreadService;
}

interface StartingTurn {
  stopRequested: boolean;
}

export class TurnService {
  private readonly starting = new Map<string, StartingTurn>();
  private readonly startedListeners = new Set<(sessionId: string, auto: boolean) => void>();
  private readonly stoppedListeners = new Set<(sessionId: string) => void>();

  constructor(private readonly deps: TurnServiceDeps) {}

  async start(sessionId: string, prompt: string, input: StartTurnInput = {}): Promise<string> {
    const { auto = false, ...options } = input;
    const begun = this.deps.threads.beginTurn(sessionId, prompt, auto);
    const starting: StartingTurn = { stopRequested: false };
    this.starting.set(sessionId, starting);
    let turnId: string;
    try {
      turnId = await this.deps.sessions.startTurn(sessionId, prompt, options);
    } catch (error) {
      this.deps.threads.abortTurn(sessionId, begun);
      throw error;
    } finally {
      if (this.starting.get(sessionId) === starting) this.starting.delete(sessionId);
    }
    this.deps.threads.commitTurn(sessionId, begun.pendingId, turnId);
    notifyAll(this.startedListeners, "[turns] turn started", sessionId, auto);
    if (starting.stopRequested) this.deps.sessions.interrupt(turnId);
    return turnId;
  }

  stop(sessionId: string): void {
    const active = this.deps.sessions.listActiveTurns().filter((turn) => turn.sessionId === sessionId);
    const starting = this.starting.get(sessionId);
    if (active.length === 0 && !starting) return;
    for (const turn of active) this.deps.sessions.interrupt(turn.turnId);
    if (active.length === 0 && starting) starting.stopRequested = true;
    notifyAll(this.stoppedListeners, "[turns] turn stopped", sessionId);
  }

  onTurnStarted(cb: (sessionId: string, auto: boolean) => void): () => void {
    this.startedListeners.add(cb);
    return () => this.startedListeners.delete(cb);
  }

  onTurnStopped(cb: (sessionId: string) => void): () => void {
    this.stoppedListeners.add(cb);
    return () => this.stoppedListeners.delete(cb);
  }
}
