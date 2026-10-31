import type { CommandInvocation, ComposerPrefs, PrRef } from "@cw-code/contracts";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { GitTopic } from "../sourceControl/GitTopic.js";
import { notifyAll, type ThreadService } from "./ThreadService.js";

export type TurnOrigin = "subagent-wake";

export type TurnStartedListener = (sessionId: string, auto: boolean, turn: { turnId: string; origin?: TurnOrigin }) => void;

export interface StartTurnInput {
  prefs?: ComposerPrefs;
  attachments?: string[];
  command?: CommandInvocation;
  skills?: string[];
  prRefs?: PrRef[];
  finalReview?: { ref: PrRef; sha: string };
  acceptFolderHead?: string;
  auto?: boolean;
  origin?: TurnOrigin;
}

export interface TurnServiceDeps {
  sessions: Pick<SessionManager, "assertCanStartTurn" | "startTurn" | "interrupt" | "listActiveTurns" | "listSubagents">;
  threads: ThreadService;
  git: Pick<GitTopic, "keptFolderHead">;
}

export interface StopResult {
  stopped: boolean;
}

interface StartingTurn {
  stopRequested: boolean;
}

export class TurnService {
  private readonly starting = new Map<string, StartingTurn>();
  private readonly startedListeners = new Set<TurnStartedListener>();
  private readonly stoppedListeners = new Set<(sessionId: string) => void>();

  constructor(private readonly deps: TurnServiceDeps) {}

  async start(sessionId: string, prompt: string, input: StartTurnInput = {}): Promise<string> {
    const { auto = false, origin, ...options } = input;
    options.acceptFolderHead ??= this.deps.git.keptFolderHead(sessionId) ?? undefined;
    this.deps.sessions.assertCanStartTurn(sessionId);
    const begun = this.deps.threads.beginTurn(sessionId, prompt, auto);
    const starting: StartingTurn = { stopRequested: false };
    this.starting.set(sessionId, starting);
    let turnId: string;
    try {
      turnId = await this.deps.sessions.startTurn(sessionId, prompt, options);
    } catch (error) {
      this.deps.threads.abortTurn(sessionId, begun);
      if (starting.stopRequested) this.notifyStopped(sessionId);
      throw error;
    } finally {
      if (this.starting.get(sessionId) === starting) this.starting.delete(sessionId);
    }
    this.deps.threads.commitTurn(sessionId, begun.pendingId, turnId);
    notifyAll(this.startedListeners, "[turns] turn started", sessionId, auto, { turnId, ...(origin ? { origin } : {}) });
    if (starting.stopRequested) {
      this.deps.sessions.interrupt(turnId);
      this.notifyStopped(sessionId);
    }
    return turnId;
  }

  stop(sessionId: string): StopResult {
    const result = this.stopSession(sessionId);
    if (result.stopped) {
      for (const child of this.deps.sessions.listSubagents(sessionId)) this.stopSession(child.id);
    }
    return result;
  }

  private stopSession(sessionId: string): StopResult {
    const active = this.deps.sessions.listActiveTurns().filter((turn) => turn.sessionId === sessionId);
    if (active.length === 0) {
      const starting = this.starting.get(sessionId);
      if (!starting) return { stopped: false };
      starting.stopRequested = true;
      return { stopped: true };
    }
    for (const turn of active) this.deps.sessions.interrupt(turn.turnId);
    this.notifyStopped(sessionId);
    return { stopped: true };
  }

  private notifyStopped(sessionId: string): void {
    notifyAll(this.stoppedListeners, "[turns] turn stopped", sessionId);
  }

  onTurnStarted(cb: TurnStartedListener): () => void {
    this.startedListeners.add(cb);
    return () => this.startedListeners.delete(cb);
  }

  onTurnStopped(cb: (sessionId: string) => void): () => void {
    this.stoppedListeners.add(cb);
    return () => this.stoppedListeners.delete(cb);
  }
}
