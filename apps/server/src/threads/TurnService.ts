import type { CommandInvocation, ComposerPrefs, PrRef, QueuedMessage, ThreadEvent } from "@cw-code/contracts";
import { SessionBusyError } from "../sessions/SessionBusyError.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { GitTopic } from "../sourceControl/GitTopic.js";
import { combineMessages, type MessageQueue } from "./MessageQueue.js";
import { notifyAll, type SettledTurnEvent, type ThreadService } from "./ThreadService.js";

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
  sessions: Pick<
    SessionManager,
    | "assertCanStartTurn"
    | "startTurn"
    | "interrupt"
    | "listActiveTurns"
    | "listSubagents"
    | "endSubagentWait"
    | "findSession"
    | "subagentWaitSince"
    | "injectMessage"
    | "retractMessage"
    | "canRetractMessages"
  >;
  threads: ThreadService;
  git: Pick<GitTopic, "keptFolderHead">;
  queue: MessageQueue;
}

export interface SendInput {
  attachments?: string[];
  skills?: string[];
}

export type SendResult = { disposition: "started"; turnId: string } | { disposition: "queued"; messageId: string };

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
  private readonly injected = new Set<string>();
  private readonly lastTurns = new Map<string, string>();
  private readonly openTools = new Map<string, Set<string>>();

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
    this.trackTurn(sessionId, turnId);
    notifyAll(this.startedListeners, "[turns] turn started", sessionId, auto, { turnId, ...(origin ? { origin } : {}) });
    if (!starting.stopRequested) this.injectPending(sessionId);
    if (starting.stopRequested) {
      this.deps.sessions.interrupt(turnId);
      this.notifyStopped(sessionId);
    }
    return turnId;
  }

  async send(sessionId: string, prompt: string, input: SendInput = {}): Promise<SendResult> {
    const session = this.deps.sessions.findSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.subagent) throw new Error("subagent sessions do not accept messages");
    if (session.status === "resolved" || session.status === "archived") {
      throw new Error(`session is ${session.status}; reopen it before sending a message`);
    }
    if (!this.busy(sessionId)) {
      if (!this.hasSending(sessionId)) {
        const turnId = await this.start(sessionId, prompt, { attachments: input.attachments, skills: input.skills });
        return { disposition: "started", turnId };
      }
      this.deps.queue.add(sessionId, { text: prompt, attachments: input.attachments, skills: input.skills });
      const pending = this.sendPending(sessionId);
      if (!pending) throw new Error("queued messages could not be sent");
      return { disposition: "started", turnId: await pending };
    }
    const message = this.deps.queue.add(sessionId, { text: prompt, attachments: input.attachments, skills: input.skills });
    await this.inject(sessionId, message);
    return { disposition: "queued", messageId: message.id };
  }

  async unqueue(sessionId: string, messageId: string): Promise<void> {
    const message = this.deps.queue.find(sessionId, messageId);
    if (!message) throw new Error(`unknown queued message ${messageId}`);
    if (!message.removable) throw new Error("message was already handed to the agent and cannot be removed");
    if (this.injected.has(messageId)) {
      const retracted = await this.deps.sessions.retractMessage(sessionId, messageId);
      if (!retracted) throw new Error("message was already delivered to the agent");
      this.injected.delete(messageId);
    }
    this.deps.queue.remove(sessionId, [messageId]);
  }

  flushQueue(sessionId: string): Promise<string> {
    if (this.busy(sessionId)) return Promise.reject(new SessionBusyError("turn running"));
    const messages = this.deps.queue.list(sessionId);
    if (messages.length === 0) return Promise.reject(new Error("no queued messages to send"));
    return this.startQueued(sessionId, messages);
  }

  sendPending(sessionId: string, options: { ignoreWait?: boolean } = {}): Promise<string> | null {
    if (this.busy(sessionId, options.ignoreWait)) return null;
    const sending = this.deps.queue.list(sessionId).filter((message) => message.state === "sending");
    if (sending.length === 0) return null;
    const started = this.startQueued(sessionId, sending);
    started.catch((error: unknown) => {
      console.warn(`[turns] queued messages for session ${sessionId} could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
    return started;
  }

  turnSettled(sessionId: string, event: SettledTurnEvent): void {
    if (this.isStale(sessionId, event.turnId)) return;
    this.openTools.delete(sessionId);
    if (event.type === "turn.error" || event.isError) {
      this.holdQueue(sessionId);
      return;
    }
    this.sendPending(sessionId);
  }

  messageEvent(sessionId: string, event: ThreadEvent): void {
    if (event.type === "user.message") {
      this.injected.delete(event.messageId);
      this.deps.queue.remove(sessionId, [event.messageId]);
    } else if (event.type === "turn.interrupted" && !this.isStale(sessionId, event.turnId)) {
      this.openTools.delete(sessionId);
      this.holdQueue(sessionId);
    }
  }

  toolEvent(sessionId: string, event: Extract<ThreadEvent, { type: "tool.call" | "tool.result" }>): void {
    if (this.isStale(sessionId, event.turnId)) return;
    if (event.type === "tool.result") {
      this.openTools.get(sessionId)?.delete(event.toolCallId);
      return;
    }
    let open = this.openTools.get(sessionId);
    if (!open) {
      open = new Set();
      this.openTools.set(sessionId, open);
    }
    open.add(event.toolCallId);
    this.injectPending(sessionId);
  }

  queueExtras(sessionId: string): { queuedMessages: QueuedMessage[] } {
    return this.deps.queue.extras(sessionId);
  }

  holdQueue(sessionId: string): void {
    for (const message of this.deps.queue.list(sessionId)) this.injected.delete(message.id);
    this.deps.queue.holdAll(sessionId);
  }

  clearQueue(sessionId: string): void {
    for (const message of this.deps.queue.list(sessionId)) this.injected.delete(message.id);
    this.deps.queue.clear(sessionId);
    this.lastTurns.delete(sessionId);
    this.openTools.delete(sessionId);
  }

  /** Records every turn the session starts, including ones started outside this service (reconnect turns). */
  noteTurnStarted(sessionId: string, turnId: string): void {
    this.trackTurn(sessionId, turnId);
  }

  private trackTurn(sessionId: string, turnId: string): void {
    if (this.lastTurns.get(sessionId) === turnId) return;
    this.lastTurns.set(sessionId, turnId);
    this.openTools.delete(sessionId);
  }

  private startQueued(sessionId: string, messages: QueuedMessage[]): Promise<string> {
    const combined = combineMessages(messages);
    const started = this.start(sessionId, combined.prompt, { attachments: combined.attachments, skills: combined.skills });
    const removed = this.deps.queue.remove(
      sessionId,
      messages.map((message) => message.id)
    );
    for (const message of removed) this.injected.delete(message.id);
    return started.catch((error: unknown) => {
      this.deps.queue.restore(sessionId, removed);
      throw error;
    });
  }

  private hasSending(sessionId: string): boolean {
    return this.deps.queue.list(sessionId).some((message) => message.state === "sending");
  }

  private isStale(sessionId: string, turnId: string): boolean {
    const last = this.lastTurns.get(sessionId);
    return last !== undefined && last !== turnId;
  }

  private injectPending(sessionId: string): void {
    for (const message of this.deps.queue.list(sessionId)) {
      if (message.state === "sending" && !this.injected.has(message.id)) void this.inject(sessionId, message);
    }
  }

  private async inject(sessionId: string, message: QueuedMessage): Promise<void> {
    if (this.starting.has(sessionId) || this.deps.sessions.subagentWaitSince(sessionId) !== null) return;
    if (!this.deps.sessions.listActiveTurns().some((turn) => turn.sessionId === sessionId)) return;
    const removable = this.deps.sessions.canRetractMessages(sessionId);
    if (!removable && !this.toolOpen(sessionId)) return;
    if (!removable) this.deps.queue.update(sessionId, message.id, { removable: false });
    this.injected.add(message.id);
    try {
      await this.deps.sessions.injectMessage(sessionId, { id: message.id, prompt: message.text, attachments: message.attachments, skills: message.skills });
    } catch (error) {
      this.injected.delete(message.id);
      this.deps.queue.update(sessionId, message.id, { removable: true });
      console.warn(`[turns] message ${message.id} stays queued for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private toolOpen(sessionId: string): boolean {
    return (this.openTools.get(sessionId)?.size ?? 0) > 0;
  }

  private busy(sessionId: string, ignoreWait = false): boolean {
    if (this.starting.has(sessionId)) return true;
    if (!ignoreWait && this.deps.sessions.subagentWaitSince(sessionId) !== null) return true;
    if (this.deps.sessions.listActiveTurns().some((turn) => turn.sessionId === sessionId)) return true;
    return this.deps.threads.runtime(sessionId).busy;
  }

  stop(sessionId: string): StopResult {
    const result = this.stopSession(sessionId);
    if (!result.stopped) {
      if (!this.deps.sessions.endSubagentWait(sessionId, "stopped")) return result;
      this.notifyStopped(sessionId);
    }
    for (const child of this.deps.sessions.listSubagents(sessionId)) this.stopSession(child.id);
    return { stopped: true };
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
    this.holdQueue(sessionId);
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
