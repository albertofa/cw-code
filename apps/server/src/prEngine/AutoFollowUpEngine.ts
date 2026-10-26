import type { AppSettings, AutoFollowUpPause, BabysitState, PrDetail, PrRef, SessionMeta } from "@cw-code/contracts";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import { withAutomatedWorkflowNote } from "@cw-code/shared/autoFollowUp";
import { prKey } from "@cw-code/shared/prRef";
import { notifyAll } from "../events/notifyAll.js";
import { BRANCH_MISMATCH_MARKER } from "../sessions/branchMismatch.js";
import type { AutoFollowUpMeta } from "../sessions/SessionStore.js";
import { SHUTDOWN_RESERVED_MESSAGE } from "../shutdown/shutdownReservation.js";
import type { SessionRuntime, SettledTurnEvent, ThreadNotice } from "../threads/ThreadService.js";
import { autoFollowUps, babysitState, finalReviewPrompt, followUpPrompt, isWatchable, needsFailedLogs, type AutoFollowUp } from "./babysit.js";
import { seenThrough } from "./prUpdates.js";
import { loadFailedLogs } from "./prWorkflows.js";
import { prRefLabel, sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export const AUTO_FOLLOW_UP_NOTICE_ID = "auto-follow-up";

export interface AutoFollowUpTurnInput {
  auto: true;
  prRefs: PrRef[];
  finalReview?: { ref: PrRef; sha: string };
}

export interface AutoFollowUpEngineDeps {
  sessions(): SessionMeta[];
  settings(): AppSettings;
  runtime(sessionId: string): Pick<SessionRuntime, "busy" | "approvals" | "questions">;
  summaryLookup(): PrSummaryLookup;
  detail(key: string): PrDetail | undefined;
  failedCheckLog(ref: PrRef, runId: number): Promise<string>;
  startTurn(sessionId: string, prompt: string, input: AutoFollowUpTurnInput): Promise<string>;
  markPrSeen(sessionId: string, ref: PrRef, headSha: string | null, seenAt: number | null): void;
  updateAutoFollowUp(sessionId: string, update: (current: AutoFollowUpMeta | undefined) => AutoFollowUpMeta | undefined): boolean;
  postNotice(sessionId: string, notice: ThreadNotice): void;
  shutdownReserved(): boolean;
  enabled?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function noticeErrorText(error: unknown): string {
  const message = errorMessage(error);
  const index = message.indexOf(BRANCH_MISMATCH_MARKER);
  if (index < 0) return message;
  return message.slice(index + BRANCH_MISMATCH_MARKER.length).split(/\r?\n/)[0].trim() || message;
}

function withAutoPause(current: AutoFollowUpMeta | undefined, reason: AutoFollowUpPause): AutoFollowUpMeta {
  if (current?.paused === "user") return current;
  return { turns: current?.turns ?? 0, paused: reason };
}

export class AutoFollowUpEngine {
  private enabled: boolean;
  private readonly started = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<(sessionId: string) => void>();
  private readonly published = new Map<string, string>();
  private pausedBefore = new Set<string>();
  private scheduled = false;
  private disposed = false;

  constructor(private readonly deps: AutoFollowUpEngineDeps) {
    this.enabled = deps.enabled ?? false;
    this.reevaluate();
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.reevaluate();
  }

  babysit(sessionId: string): BabysitState | null {
    const session = this.deps.sessions().find((item) => item.id === sessionId);
    return session ? this.babysitFor(session, this.deps.summaryLookup(), this.deps.settings().prWorkflows) : null;
  }

  onChanged(cb: (sessionId: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  pause(sessionId: string, reason: AutoFollowUpPause = "user"): boolean {
    const known = this.deps.updateAutoFollowUp(sessionId, (current) =>
      reason === "user" ? { turns: current?.turns ?? 0, paused: "user" } : withAutoPause(current, reason)
    );
    this.reevaluate();
    return known;
  }

  resume(sessionId: string): boolean {
    const known = this.deps.updateAutoFollowUp(sessionId, () => undefined);
    this.reevaluate();
    return known;
  }

  turnStarted(sessionId: string, auto: boolean): void {
    this.deps.updateAutoFollowUp(sessionId, (current) => {
      if (auto) return { ...current, turns: (current?.turns ?? 0) + 1 };
      return current?.paused === "user" ? { turns: 0, paused: "user" } : undefined;
    });
    this.reevaluate();
  }

  turnStopped(sessionId: string): void {
    this.pause(sessionId, "interrupted");
  }

  turnInterrupted(sessionId: string, reason: "shutdown" | undefined): void {
    if (reason !== "shutdown") this.pause(sessionId, "interrupted");
  }

  turnSettled(sessionId: string, event: SettledTurnEvent): void {
    if (event.type === "turn.error" || event.isError) this.pause(sessionId, "error");
    else this.reevaluate();
  }

  reevaluate(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.disposed) return;
      try {
        this.evaluate();
      } catch (error) {
        console.warn(`[auto-follow-up] evaluation failed: ${errorMessage(error)}`);
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

  private watchable(session: SessionMeta): boolean {
    return isWatchable(session) && sessionLinks(session).length > 0;
  }

  private babysitFor(session: SessionMeta, lookup: PrSummaryLookup, workflows: AppSettings["prWorkflows"]): BabysitState | null {
    if (!this.watchable(session)) return null;
    return babysitState(session, lookup, workflows, {
      busy: this.deps.runtime(session.id).busy,
      paused: session.autoFollowUp?.paused,
      autoTurns: session.autoFollowUp?.turns ?? 0
    });
  }

  private evaluate(): void {
    const sessions = this.deps.sessions();
    const settings = this.deps.settings();
    const workflows = settings.prWorkflows;
    const lookup = this.deps.summaryLookup();
    this.publishBabysit(sessions, lookup, workflows);
    this.forgetResumed(sessions);
    if (!this.enabled || this.deps.shutdownReserved()) return;
    const watched = sessions.filter((session) => this.watchable(session));
    for (const followUp of this.candidates(watched, lookup, workflows)) {
      if (this.started.has(followUp.signature)) continue;
      const session = watched.find((item) => item.id === followUp.sessionId);
      if (!session) continue;
      this.started.add(followUp.signature);
      this.inFlight.add(followUp.signature);
      void this.send(followUp, settings, harnessLabel(session.driver))
        .then((handled) => {
          if (!handled) this.started.delete(followUp.signature);
        })
        .finally(() => this.inFlight.delete(followUp.signature));
    }
  }

  private candidates(watched: SessionMeta[], lookup: PrSummaryLookup, workflows: AppSettings["prWorkflows"]): AutoFollowUp[] {
    const detailByKey: Record<string, PrDetail> = {};
    for (const session of watched) {
      for (const link of sessionLinks(session)) {
        const key = prKey(link.ref);
        const detail = this.deps.detail(key);
        if (detail) detailByKey[key] = detail;
      }
    }
    return autoFollowUps(
      watched.map((session) => {
        const runtime = this.deps.runtime(session.id);
        return {
          session,
          busy: runtime.busy,
          waitingOnUser: runtime.approvals.length > 0 || runtime.questions.length > 0,
          paused: session.autoFollowUp?.paused !== undefined,
          autoTurns: session.autoFollowUp?.turns ?? 0
        };
      }),
      lookup,
      detailByKey,
      workflows
    );
  }

  private stillCurrent(followUp: AutoFollowUp): boolean {
    if (!this.canSend(followUp.sessionId)) return false;
    const session = this.deps.sessions().find((item) => item.id === followUp.sessionId);
    if (!session || !this.watchable(session)) return false;
    return this.candidates([session], this.deps.summaryLookup(), this.deps.settings().prWorkflows).some(
      (candidate) => candidate.signature === followUp.signature
    );
  }

  private publishBabysit(sessions: SessionMeta[], lookup: PrSummaryLookup, workflows: AppSettings["prWorkflows"]): void {
    const seen = new Set<string>();
    for (const session of sessions) {
      seen.add(session.id);
      const json = JSON.stringify(this.babysitFor(session, lookup, workflows));
      if (this.published.get(session.id) === json) continue;
      const known = this.published.has(session.id);
      this.published.set(session.id, json);
      if (known || json !== "null") notifyAll(this.listeners, "[auto-follow-up] changed", session.id);
    }
    for (const sessionId of [...this.published.keys()]) {
      if (!seen.has(sessionId)) this.published.delete(sessionId);
    }
  }

  private forgetResumed(sessions: SessionMeta[]): void {
    const paused = new Set(sessions.filter((session) => session.autoFollowUp?.paused !== undefined).map((session) => session.id));
    for (const sessionId of this.pausedBefore) {
      if (paused.has(sessionId)) continue;
      for (const signature of this.started) {
        if (signature.startsWith(`${sessionId}:`) && !this.inFlight.has(signature)) this.started.delete(signature);
      }
    }
    this.pausedBefore = paused;
  }

  private canSend(sessionId: string): boolean {
    return this.enabled && !this.disposed && !this.deps.shutdownReserved() && !this.deps.runtime(sessionId).busy;
  }

  private async failedLogsOrNotice(detail: PrDetail): Promise<string> {
    try {
      return await loadFailedLogs(detail, (ref, runId) => this.deps.failedCheckLog(ref, runId));
    } catch (error) {
      console.warn(`[auto-follow-up] failed CI logs for ${prRefLabel(detail.ref)} could not be loaded: ${errorMessage(error)}`);
      return `(Failed CI logs could not be loaded: ${errorMessage(error)}. Read them with \`gh run view --log-failed\`.)`;
    }
  }

  private async send(followUp: AutoFollowUp, settings: AppSettings, harness: string): Promise<boolean> {
    const { sessionId, link, workflow, detail, updates, finalReview } = followUp;
    if (!this.canSend(sessionId)) return false;
    try {
      const failedLogs = !finalReview && needsFailedLogs(workflow.updatePrompt) ? await this.failedLogsOrNotice(detail) : undefined;
      if (!this.stillCurrent(followUp)) return false;
      const prompt = finalReview
        ? withAutomatedWorkflowNote(workflow, finalReviewPrompt(detail))
        : followUpPrompt(detail, link, workflow, updates, settings, harness, failedLogs);
      await this.deps.startTurn(sessionId, prompt, {
        auto: true,
        prRefs: [link.ref],
        ...(finalReview ? { finalReview: { ref: link.ref, sha: detail.headRefOid } } : {})
      });
    } catch (error) {
      if (errorCode(error) === "session-busy" || errorMessage(error) === SHUTDOWN_RESERVED_MESSAGE) return false;
      console.warn(`[auto-follow-up] ${workflow.label} could not send to session ${sessionId}: ${errorMessage(error)}`);
      this.pause(sessionId, "error");
      this.deps.postNotice(sessionId, {
        noticeId: AUTO_FOLLOW_UP_NOTICE_ID,
        text: `${workflow.label} could not send the ${prRefLabel(link.ref)} ${finalReview ? "final review" : "update"}: ${noticeErrorText(error)}. Resume ${workflow.label} in the session's dock to retry.`,
        severity: "error"
      });
      return true;
    }
    try {
      this.deps.markPrSeen(sessionId, link.ref, detail.headRefOid, seenThrough(detail, updates));
    } catch (error) {
      console.warn(`[auto-follow-up] sent but ${prRefLabel(link.ref)} could not be marked seen: ${errorMessage(error)}`);
    }
    return true;
  }
}
