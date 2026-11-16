import type { AppSettings, LimitResume as LimitResumeMeta, SessionMeta, ThreadLimitResume } from "@cw-code/contracts";
import { SHUTDOWN_RESERVED_MESSAGE } from "../shutdown/shutdownReservation.js";
import { HARNESS_UPDATE_BUSY_DETAIL } from "./SessionBusyError.js";
import type { SessionRuntime, SettledTurnEvent, ThreadNotice } from "../threads/ThreadService.js";
import type { TurnOrigin } from "../threads/TurnService.js";

export const LIMIT_RESUME_NOTICE_ID = "limit-resume";
export const LIMIT_RESUME_PROMPT =
  "The usage limit that stopped your previous turn has reset. Continue the work you were doing from where it stopped.";
export const LIMIT_SWITCH_PROMPT =
  "Your previous turn stopped because its model reached a usage limit, so this turn runs on another model. Continue the work you were doing from where it stopped.";
/** Waited after the advertised reset so the first request does not land on the boundary. */
export const LIMIT_RESUME_MARGIN_MS = 60_000;
/** Automatic continuations in a row that may end on a limit again before cw-code stops trying. */
export const LIMIT_RESUME_MAX_ATTEMPTS = 3;
/** A reset that passed longer ago than this (server was off) is dropped instead of resumed. */
export const LIMIT_RESUME_STALE_MS = 24 * 60 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface LimitResumeDeps {
  sessions(): SessionMeta[];
  settings(): Pick<AppSettings, "limitAutoResume" | "claudeDefaultModel">;
  runtime(sessionId: string): Pick<SessionRuntime, "busy" | "approvals" | "questions">;
  waitingOnSubagents(sessionId: string): boolean;
  startTurn(sessionId: string, prompt: string): Promise<string>;
  setLimitResume(sessionId: string, next: LimitResumeMeta | undefined): void;
  refresh(sessionId: string): void;
  postNotice(sessionId: string, notice: ThreadNotice): void;
  shutdownReserved(): boolean;
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isClosed(session: SessionMeta): boolean {
  return session.status === "resolved" || session.status === "archived";
}

/**
 * Continues a session after a plan limit ended its turn: on its own once the limit resets, or right away
 * on another model when only the session's model was limited and the user picks one.
 */
export class LimitResume {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Attempts count of the continuation being started, until its turn id is known. */
  private readonly firing = new Map<string, number>();
  /**
   * The latest continuation turn per session and how many attempts it represents. Kept after it settles,
   * until the next turn starts or a stop, so a second settle of the same turn is still counted.
   */
  private readonly resumed = new Map<string, { turnId: string; attempts: number }>();
  private readonly published = new Map<string, string>();
  private disposed = false;

  constructor(private readonly deps: LimitResumeDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private find(sessionId: string): SessionMeta | undefined {
    return this.deps.sessions().find((session) => session.id === sessionId);
  }

  extras(sessionId: string): { limitResume: ThreadLimitResume | null } {
    const session = this.find(sessionId);
    const pending = session?.limitResume;
    if (!session || !pending) return { limitResume: null };
    const model = session.model?.trim() || undefined;
    const fallback = session.driver === "claude" ? this.deps.settings().claudeDefaultModel.trim() : "";
    return {
      limitResume: {
        ...(pending.resetsAt !== undefined ? { resetsAt: pending.resetsAt } : {}),
        ...(pending.window ? { window: pending.window } : {}),
        ...(pending.scope ? { scope: pending.scope } : {}),
        ...(model ? { model } : {}),
        ...(pending.scope && fallback && fallback !== model ? { fallbackModel: fallback } : {})
      }
    };
  }

  turnStarted(sessionId: string, turn: { turnId: string; origin?: TurnOrigin }): void {
    if (turn.origin === "limit-resume") {
      const attempts = this.firing.get(sessionId);
      if (attempts !== undefined) this.resumed.set(sessionId, { turnId: turn.turnId, attempts });
      return;
    }
    this.resumed.delete(sessionId);
    this.clear(sessionId);
  }

  turnStopped(sessionId: string): void {
    this.resumed.delete(sessionId);
    this.clear(sessionId);
  }

  turnSettled(sessionId: string, turnId: string, event: SettledTurnEvent): void {
    const resumed = this.resumed.get(sessionId);
    const counted = resumed?.turnId === turnId;
    // A turn can settle twice (background tasks): the second settle keeps the streak the first one stored.
    // A user turn clears the stored entry when it starts, so its streak still starts at zero.
    const attempts = counted ? resumed.attempts : (this.find(sessionId)?.limitResume?.attempts ?? 0);
    const found = event.type === "turn.done" ? event.usageLimit : undefined;
    const autoResume = this.deps.settings().limitAutoResume;
    // With auto resume off, a model limit still offers to continue on another model, without the scheduled wait.
    const hit = found && !autoResume ? (found.scope === "model" ? { ...found, resetsAt: undefined } : undefined) : found;
    if (!hit) return;
    if (hit.resetsAt === undefined && hit.scope !== "model") return;
    const session = this.find(sessionId);
    if (!session || session.subagent || isClosed(session)) return;
    if (attempts >= LIMIT_RESUME_MAX_ATTEMPTS) {
      this.notify(sessionId, {
        noticeId: LIMIT_RESUME_NOTICE_ID,
        text: `The usage limit ended ${attempts} automatic continuations in a row, so cw-code stopped retrying. Send a message to continue.`,
        severity: "warning"
      });
      return;
    }
    this.deps.setLimitResume(sessionId, {
      ...(hit.resetsAt !== undefined ? { resetsAt: hit.resetsAt } : {}),
      ...(hit.window ? { window: hit.window } : {}),
      ...(hit.scope ? { scope: hit.scope } : {}),
      attempts
    });
    this.arm(sessionId);
  }

  /** Drops the pending continuation; false when the session had none. */
  cancel(sessionId: string): boolean {
    if (!this.find(sessionId)?.limitResume) return false;
    this.clear(sessionId);
    return true;
  }

  /**
   * Continues a limited session now instead of waiting for the reset. The caller has already switched the
   * session's model; this starts the continuation turn on it.
   */
  async continueNow(sessionId: string): Promise<string> {
    const session = this.find(sessionId);
    if (!session?.limitResume) throw new Error("This session is not waiting on a usage limit.");
    if (session.subagent || isClosed(session)) throw new Error("This session can't be continued.");
    if (this.firing.has(sessionId)) throw new Error("The session is already continuing.");
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.firing.set(sessionId, 0);
    let turnId: string;
    try {
      turnId = await this.deps.startTurn(sessionId, LIMIT_SWITCH_PROMPT);
    } catch (error) {
      this.arm(sessionId);
      throw error;
    } finally {
      this.firing.delete(sessionId);
    }
    this.clear(sessionId);
    return turnId;
  }

  sessionChanged(session: SessionMeta): void {
    if (session.limitResume && isClosed(session)) {
      this.clear(session.id);
      return;
    }
    const pending = session.limitResume;
    const key = pending ? `${pending.resetsAt ?? ""}|${pending.scope ?? ""}|${session.model ?? ""}` : undefined;
    if (this.published.get(session.id) === key) return;
    if (key === undefined) this.published.delete(session.id);
    else this.published.set(session.id, key);
    this.deps.refresh(session.id);
  }

  settingsChanged(): void {
    const settings = this.deps.settings();
    if (!settings.limitAutoResume) {
      for (const session of this.deps.sessions()) {
        const pending = session.limitResume;
        if (!pending) continue;
        if (!pending.scope) {
          this.clear(session.id);
          continue;
        }
        if (pending.resetsAt === undefined) continue;
        const timer = this.timers.get(session.id);
        if (timer) clearTimeout(timer);
        this.timers.delete(session.id);
        const { resetsAt: _dropped, ...offer } = pending;
        this.deps.setLimitResume(session.id, offer);
      }
      return;
    }
    for (const session of this.deps.sessions()) {
      if (session.limitResume?.scope) this.deps.refresh(session.id);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  reactivate(): void {
    this.disposed = false;
    for (const session of this.deps.sessions()) {
      if (session.limitResume) this.arm(session.id);
    }
  }

  private clear(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    if (this.find(sessionId)?.limitResume) this.deps.setLimitResume(sessionId, undefined);
  }

  private arm(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.timers.delete(sessionId);
    const resetsAt = this.find(sessionId)?.limitResume?.resetsAt;
    if (resetsAt === undefined || this.disposed) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, resetsAt - this.now()) + LIMIT_RESUME_MARGIN_MS);
    const timer = setTimeout(() => {
      if (this.timers.get(sessionId) !== timer) return;
      this.timers.delete(sessionId);
      void this.fire(sessionId);
    }, delay);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  private async fire(sessionId: string): Promise<void> {
    if (this.disposed || this.firing.has(sessionId)) return;
    const session = this.find(sessionId);
    const pending = session?.limitResume;
    if (!session || !pending || pending.resetsAt === undefined) return;
    const overdue = this.now() - pending.resetsAt;
    if (session.subagent || isClosed(session) || !this.deps.settings().limitAutoResume || overdue > LIMIT_RESUME_STALE_MS) {
      this.clear(sessionId);
      return;
    }
    if (overdue < 0) {
      this.arm(sessionId);
      return;
    }
    if (this.deps.shutdownReserved()) return;
    const runtime = this.deps.runtime(sessionId);
    if (runtime.busy || runtime.approvals.length > 0 || runtime.questions.length > 0 || this.deps.waitingOnSubagents(sessionId)) {
      this.clear(sessionId);
      return;
    }
    this.firing.set(sessionId, pending.attempts + 1);
    try {
      await this.deps.startTurn(sessionId, LIMIT_RESUME_PROMPT);
    } catch (error) {
      if (errorMessage(error) === SHUTDOWN_RESERVED_MESSAGE) return;
      const busy = error as { code?: unknown; detail?: unknown } | null;
      if (busy?.code === "session-busy" && busy.detail === HARNESS_UPDATE_BUSY_DETAIL) {
        // The harness is updating; the reset has passed, so `arm` retries after the margin.
        this.arm(sessionId);
        return;
      }
      this.clear(sessionId);
      if (busy?.code === "session-busy") return;
      console.warn(`[limit-resume] could not continue session ${sessionId}: ${errorMessage(error)}`);
      this.notify(sessionId, {
        noticeId: LIMIT_RESUME_NOTICE_ID,
        text: `The usage limit reset, but cw-code could not continue this session: ${errorMessage(error)}. Send a message to continue.`,
        severity: "error"
      });
      return;
    } finally {
      this.firing.delete(sessionId);
    }
    this.clear(sessionId);
  }

  private notify(sessionId: string, notice: ThreadNotice): void {
    try {
      this.deps.postNotice(sessionId, notice);
    } catch (error) {
      console.warn(`[limit-resume] notice for ${sessionId} failed: ${errorMessage(error)}`);
    }
  }
}
