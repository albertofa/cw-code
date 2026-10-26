import type {
  AppSettings,
  AutoFollowUpPause,
  BabysitPhase,
  BabysitState,
  PrDetail,
  PrRef,
  PrSummary,
  PrUpdate,
  PrWorkflow,
  SessionMeta,
  SessionPrLink
} from "@cw-code/contracts";
import { AUTO_FOLLOW_UP_LIMIT, autoFollowUpWorkflow, runsContinuously, withAutomatedWorkflowNote } from "@cw-code/shared/autoFollowUp";
import { prKey } from "@cw-code/shared/prRef";
import { attributionText, resolveTemplate } from "@cw-code/shared/workflowTemplates";
import { detailNeedsRefresh, seenThrough, updatesSince } from "./prUpdates.js";
import { templateVars } from "./prWorkflows.js";
import { sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export { AUTO_FOLLOW_UP_LIMIT };

const AUTO_FOLLOW_UP_STATUSES: ReadonlySet<SessionMeta["status"]> = new Set(["done", "idle", "holding", "babysit"]);

const FAILED_LOGS_PATTERN = /\{\{\s*checks\.failedLogs\s*\}\}/;

const RUN_FAILED_LOGS_PATTERN = /\{\{\s*run\.failedLogs\s*\}\}/;

function fallbackWorkflowId(pr: Pick<PrSummary, "viewerIsAuthor"> | null): string {
  return pr !== null && !pr.viewerIsAuthor ? "review" : "babysit";
}

export function defaultFollowUpWorkflowId(link: SessionPrLink, pr: Pick<PrSummary, "viewerIsAuthor"> | null): string {
  return link.workflowId || fallbackWorkflowId(pr);
}

export function followUpWorkflow(
  link: SessionPrLink,
  pr: Pick<PrSummary, "viewerIsAuthor"> | null,
  workflows: PrWorkflow[]
): PrWorkflow | null {
  const own = link.workflowId ? workflows.find((w) => w.id === link.workflowId) : undefined;
  return own ?? workflows.find((w) => w.id === fallbackWorkflowId(pr)) ?? null;
}

export function needsFailedLogs(template: string): boolean {
  return FAILED_LOGS_PATTERN.test(template);
}

export function needsRunFailedLogs(template: string): boolean {
  return RUN_FAILED_LOGS_PATTERN.test(template);
}

export function followUpPrompt(
  detail: PrDetail,
  link: SessionPrLink,
  workflow: PrWorkflow,
  updates: PrUpdate[],
  settings: Pick<AppSettings, "prAttributionEnabled" | "prAttributionText">,
  harness: string,
  failedLogs?: string
): string {
  const vars = templateVars(detail, { link, updates, failedLogs, attribution: attributionText(settings, harness), harness });
  return withAutomatedWorkflowNote(workflow, resolveTemplate(workflow.updatePrompt, vars));
}

export function isMergeReady(pr: PrSummary): boolean {
  return pr.state === "OPEN" && (pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "HAS_HOOKS");
}

function finalReviewPassed(link: SessionPrLink, pr: PrSummary | undefined): pr is PrSummary {
  return pr !== undefined && isMergeReady(pr) && link.finalReviewSha === pr.headRefOid;
}

export function finalReviewPrompt(pr: Pick<PrSummary, "ref" | "headRefOid">): string {
  const number = pr.ref.number;
  return `PR #${number} is mergeable at ${pr.headRefOid} according to GitHub.
Do a final review pass of the full diff (\`gh pr diff ${number}\`) before it merges. If something would block the merge, fix it, commit and push. If it is ready, change nothing and say so.`;
}

export interface AutoFollowUpSession {
  session: Pick<SessionMeta, "id" | "status" | "prs">;
  busy: boolean;
  waitingOnUser: boolean;
  paused: boolean;
  autoTurns: number;
}

export interface BabysitControl {
  busy: boolean;
  paused: AutoFollowUpPause | undefined;
  autoTurns: number;
}

function babysitPhase(link: SessionPrLink, pr: PrSummary | undefined, { busy, paused, autoTurns }: BabysitControl): BabysitPhase {
  if (paused) return { kind: "paused", reason: paused };
  if (busy) return { kind: "working" };
  if (finalReviewPassed(link, pr)) return { kind: "done", pr };
  if (autoTurns >= AUTO_FOLLOW_UP_LIMIT) return { kind: "paused", reason: "limit" };
  return { kind: "watching" };
}

export function babysitState(
  session: Pick<SessionMeta, "status" | "prs">,
  summaryByKey: PrSummaryLookup,
  workflows: PrWorkflow[],
  control: BabysitControl
): BabysitState | null {
  if (!isWatchable(session)) return null;
  for (const link of sessionLinks(session)) {
    const workflow = autoFollowUpWorkflow(link, workflows);
    const summary = summaryByKey.get(prKey(link.ref));
    if (!workflow || (summary && summary.state !== "OPEN")) continue;
    return { link, workflow, phase: babysitPhase(link, summary, control), autoTurns: control.autoTurns };
  }
  return null;
}

export function babysitPhaseLabel(phase: BabysitPhase["kind"]): string {
  switch (phase) {
    case "working":
      return "Babysitting";
    case "watching":
      return "Watching";
    case "done":
      return "Ready to merge";
    case "paused":
      return "Paused";
  }
}

export function babysitStatusText(state: BabysitState): string {
  switch (state.phase.kind) {
    case "working":
      return "Working on the PR";
    case "watching":
      return "Watching for failed checks, change requests and comments";
    case "done":
      return "Final review done, ready to merge";
    case "paused":
      switch (state.phase.reason) {
        case "user":
          return "Paused";
        case "interrupted":
          return "Paused because the turn was stopped";
        case "error":
          return "Paused because the last turn failed";
        case "limit":
          return `Paused after ${AUTO_FOLLOW_UP_LIMIT} automatic turns in a row`;
      }
  }
}

export interface AutoFollowUp {
  sessionId: string;
  link: SessionPrLink;
  workflow: PrWorkflow;
  detail: PrDetail;
  updates: PrUpdate[];
  finalReview: boolean;
  signature: string;
}

export function isWatchable(session: Pick<SessionMeta, "status">): boolean {
  return session.status !== "resolved" && session.status !== "archived";
}

export function startsAutoFollowUp(
  session: Pick<SessionMeta, "status">,
  workflow: PrWorkflow | null | undefined,
  pr: Pick<PrSummary, "state"> | null | undefined
): workflow is PrWorkflow {
  return !!workflow && runsContinuously(workflow) && isWatchable(session) && (!pr || pr.state === "OPEN");
}

export type FollowUpMode =
  | { kind: "auto"; workflow: PrWorkflow; phase: BabysitPhase }
  | { kind: "start"; workflow: PrWorkflow }
  | { kind: "once"; workflow: PrWorkflow }
  | { kind: "none" };

export function followUpMode(
  session: Pick<SessionMeta, "status">,
  link: SessionPrLink,
  pr: Pick<PrSummary, "state"> | null,
  workflow: PrWorkflow | null,
  workflows: PrWorkflow[],
  babysit: BabysitState | null
): FollowUpMode {
  const auto = autoFollowUpWorkflow(link, workflows);
  if (auto && babysit && isWatchable(session) && (!pr || pr.state === "OPEN")) {
    return { kind: "auto", workflow: auto, phase: babysit.phase };
  }
  if (!workflow) return { kind: "none" };
  if (!auto && startsAutoFollowUp(session, workflow, pr)) return { kind: "start", workflow };
  return { kind: "once", workflow };
}

export function autoFollowUpRefs(sessions: Pick<SessionMeta, "status" | "prs">[], summaryByKey: PrSummaryLookup, workflows: PrWorkflow[]): PrRef[] {
  const byKey = new Map<string, PrRef>();
  for (const session of sessions) {
    if (!isWatchable(session)) continue;
    for (const link of sessionLinks(session)) {
      const key = prKey(link.ref);
      const summary = summaryByKey.get(key);
      if (summary && summary.state !== "OPEN") continue;
      if (autoFollowUpWorkflow(link, workflows)) byKey.set(key, link.ref);
    }
  }
  return [...byKey.values()];
}

export function autoFollowUps(
  sessions: AutoFollowUpSession[],
  summaryByKey: PrSummaryLookup,
  detailByKey: Record<string, PrDetail>,
  workflows: PrWorkflow[]
): AutoFollowUp[] {
  const result: AutoFollowUp[] = [];
  for (const { session, busy, waitingOnUser, paused, autoTurns } of sessions) {
    if (busy || waitingOnUser || paused || autoTurns >= AUTO_FOLLOW_UP_LIMIT || !AUTO_FOLLOW_UP_STATUSES.has(session.status)) continue;
    for (const link of sessionLinks(session)) {
      const workflow = autoFollowUpWorkflow(link, workflows);
      const key = prKey(link.ref);
      const detail = detailByKey[key];
      if (!workflow || !detail || detail.state !== "OPEN" || detailNeedsRefresh(detail, summaryByKey.get(key))) continue;
      const updates = updatesSince(detail, link);
      const actionable = updates.some((update) => update.actionable);
      const finalReview = !actionable && isMergeReady(detail) && link.finalReviewSha !== detail.headRefOid;
      if (!actionable && !finalReview) continue;
      result.push({
        sessionId: session.id,
        link,
        workflow,
        detail,
        updates,
        finalReview,
        signature: finalReview
          ? `${session.id}:${key}@${detail.headRefOid}:final`
          : `${session.id}:${key}@${detail.headRefOid}:${seenThrough(detail, updates) ?? ""}`
      });
      break;
    }
  }
  return result;
}

export function whyLinkedText(
  link: SessionPrLink,
  pr: Pick<PrSummary, "headRefName"> | null,
  workflows: PrWorkflow[]
): string {
  const number = link.ref.number;
  switch (link.origin) {
    case "opened":
      return pr ? `Branch ${pr.headRefName} is the head of #${number}` : `This session's branch is the head of #${number}`;
    case "workflow": {
      if (!link.workflowId) return `Started from a workflow on #${number}`;
      const label = workflows.find((w) => w.id === link.workflowId)?.label ?? link.workflowId;
      return `Started from the ${label} workflow`;
    }
    case "linked":
      return "Linked manually";
  }
}
