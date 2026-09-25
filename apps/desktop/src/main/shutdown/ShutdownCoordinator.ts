import { randomUUID } from "node:crypto";
import type {
  ShutdownActiveTurn,
  ShutdownAssessment,
  ShutdownCommitResult,
  ShutdownPrepareRequest,
  ShutdownPrepareResult,
  ShutdownReason,
  ShutdownTerminal
} from "@cw-code/contracts";

export interface ShutdownSessions {
  listShutdownTurns(): ShutdownActiveTurn[];
  backgroundTaskCount(): number;
  beginShutdownReservation(): void;
  clearShutdownReservation(): void;
  interrupt(turnId: string): void;
  cancelBackgroundWork(): void;
  flush(): void;
  shutdownDrivers(timeoutMs: number): Promise<{ timedOut: string[] }>;
  forceStopDrivers(): void;
  reinitializeDrivers(): void;
}

export interface ShutdownPtys {
  list(): ShutdownTerminal[];
  beginShutdownReservation(): void;
  clearShutdownReservation(): void;
  dispose(): void;
  reopen(): void;
}

export interface ShutdownClock {
  sleep(ms: number): Promise<void>;
}

export interface ShutdownCoordinatorDeps {
  sessions: ShutdownSessions;
  ptys: ShutdownPtys;
  clock?: ShutdownClock;
  createToken?: () => string;
  commitExitTimeoutMs?: number;
  log?: (message: string) => void;
}

type Phase = "idle" | "preparing" | "prepared" | "timeout" | "committing";

const DEFAULT_COMMIT_EXIT_TIMEOUT_MS = 30_000;
const PREPARE_GRACE_MS = 2_000;

const realClock: ShutdownClock = {
  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      timer.unref?.();
    })
};

export class ShutdownCoordinator {
  private phase: Phase = "idle";
  private token: string | null = null;
  private reason: ShutdownReason | null = null;
  private servicesStopped = false;
  private generation = 0;
  private commitInFlight: Promise<ShutdownCommitResult> | null = null;
  private readonly sessions: ShutdownSessions;
  private readonly ptys: ShutdownPtys;
  private readonly clock: ShutdownClock;
  private readonly createToken: () => string;
  private readonly commitExitTimeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(deps: ShutdownCoordinatorDeps) {
    this.sessions = deps.sessions;
    this.ptys = deps.ptys;
    this.clock = deps.clock ?? realClock;
    this.createToken = deps.createToken ?? randomUUID;
    this.commitExitTimeoutMs = deps.commitExitTimeoutMs ?? DEFAULT_COMMIT_EXIT_TIMEOUT_MS;
    this.log = deps.log ?? ((message) => console.warn(message));
  }

  assess(): ShutdownAssessment {
    return {
      activeTurns: this.sessions.listShutdownTurns(),
      backgroundTasks: this.sessions.backgroundTaskCount(),
      terminals: this.ptys.list()
    };
  }

  isCommitted(): boolean {
    return this.phase === "committing";
  }

  isIdle(): boolean {
    return this.phase === "idle";
  }

  currentReason(): ShutdownReason | null {
    return this.reason;
  }

  async prepare(request: ShutdownPrepareRequest): Promise<ShutdownPrepareResult> {
    if (this.phase !== "idle") return { ok: false, code: "busy" };
    this.phase = "preparing";
    this.reason = request.reason;
    const generation = this.generation;
    this.sessions.beginShutdownReservation();
    this.ptys.beginShutdownReservation();
    const assessment = this.assess();
    if (assessment.activeTurns.length > 0 && !request.stopActiveTurns) {
      this.releaseReservations();
      this.reset();
      return { ok: false, code: "blocked", assessment };
    }
    this.log(
      `shutdown (${request.reason}): stopping ${assessment.activeTurns.length} turn(s), ${assessment.backgroundTasks} background task(s), ${assessment.terminals.length} terminal(s)`
    );
    this.servicesStopped = true;
    let timedOut: string[];
    try {
      for (const turn of assessment.activeTurns) {
        if (turn.turnId) this.sessions.interrupt(turn.turnId);
      }
      this.sessions.cancelBackgroundWork();
      this.sessions.flush();
      this.ptys.dispose();
      timedOut = await this.boundedDriverShutdown(request.timeoutMs);
    } catch (err) {
      this.log(`shutdown prepare failed: ${(err as Error).message}`);
      if (this.generation === generation) this.recover();
      throw err;
    }
    if (this.generation !== generation) return { ok: false, code: "busy" };
    const token = this.createToken();
    this.token = token;
    if (timedOut.length > 0) {
      this.phase = "timeout";
      this.log(`shutdown (${request.reason}): graceful stop timed out for ${timedOut.join(", ")}`);
      return { ok: false, code: "timeout", pending: timedOut, token };
    }
    this.phase = "prepared";
    return { ok: true, token };
  }

  private async boundedDriverShutdown(timeoutMs: number): Promise<string[]> {
    const deadline = this.clock.sleep(timeoutMs + PREPARE_GRACE_MS).then(() => ({ timedOut: ["drivers"] }));
    const result = await Promise.race([this.sessions.shutdownDrivers(timeoutMs), deadline]);
    return result.timedOut;
  }

  async force(token: string): Promise<ShutdownPrepareResult> {
    this.assertToken(token, ["timeout", "prepared"]);
    if (this.phase === "timeout") {
      this.log(`shutdown (${this.reason ?? "quit"}): force-stopping owned processes`);
      this.sessions.forceStopDrivers();
      this.phase = "prepared";
    }
    return { ok: true, token };
  }

  cancel(token: string): void {
    if (this.phase === "idle") return;
    this.assertToken(token, ["timeout", "prepared"]);
    this.recover();
  }

  commit(token: string, action: () => Promise<void> | void): Promise<ShutdownCommitResult> {
    if (this.phase === "committing" && token === this.token && this.commitInFlight) return this.commitInFlight;
    if (this.phase === "timeout" && token === this.token) {
      return Promise.resolve({ ok: false, message: "some processes have not stopped yet; force stop or cancel first" });
    }
    if (this.phase !== "prepared" || token !== this.token) {
      return Promise.resolve({ ok: false, message: "this restart request is no longer valid; start it again" });
    }
    this.phase = "committing";
    const inFlight = this.runCommit(action);
    this.commitInFlight = inFlight;
    void inFlight.finally(() => {
      if (this.commitInFlight === inFlight) this.commitInFlight = null;
    });
    return inFlight;
  }

  private async runCommit(action: () => Promise<void> | void): Promise<ShutdownCommitResult> {
    const generation = this.generation;
    try {
      await action();
    } catch (err) {
      const message = (err as Error).message;
      this.log(`shutdown (${this.reason ?? "quit"}) commit failed: ${message}`);
      if (this.generation === generation) this.recover();
      return { ok: false, message: `cw-code could not finish the restart: ${message}. Normal use has been restored.` };
    }
    await this.clock.sleep(this.commitExitTimeoutMs);
    if (this.generation !== generation) return { ok: false, message: "the restart was cancelled" };
    this.log(`shutdown (${this.reason ?? "quit"}): process did not exit within ${this.commitExitTimeoutMs}ms; recovering`);
    this.recover();
    return {
      ok: false,
      message: `cw-code did not exit within ${Math.round(this.commitExitTimeoutMs / 1000)}s. Normal use has been restored.`
    };
  }

  recover(): void {
    if (this.phase === "idle") return;
    const restart = this.servicesStopped;
    this.generation += 1;
    this.reset();
    try {
      if (restart) {
        this.sessions.reinitializeDrivers();
        this.ptys.reopen();
      }
    } catch (err) {
      this.log(`shutdown recovery could not restart services: ${(err as Error).message}`);
    } finally {
      this.releaseReservations();
    }
  }

  private reset(): void {
    this.phase = "idle";
    this.token = null;
    this.reason = null;
    this.servicesStopped = false;
  }

  private releaseReservations(): void {
    this.sessions.clearShutdownReservation();
    this.ptys.clearShutdownReservation();
  }

  private assertToken(token: string, phases: Phase[]): void {
    if (typeof token !== "string" || token !== this.token || !phases.includes(this.phase)) {
      throw new Error("this restart request is no longer valid; start it again");
    }
  }
}
