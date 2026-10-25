import type {
  AppSettings,
  BabysitState,
  BranchMismatch,
  GitStatus,
  PrDetail,
  PrDockEntry,
  PrRef,
  PrUpdate,
  SessionMeta,
  SessionPrItem,
  SessionPrLink
} from "@cw-code/contracts";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import { combinedPrompt } from "@cw-code/shared/prDock";
import { prKey } from "@cw-code/shared/prRef";
import type { ChangeSource } from "../app/ShutdownPublisher.js";
import type { ThreadExtras } from "../threads/ThreadService.js";
import { defaultFollowUpWorkflowId, followUpMode, followUpPrompt, followUpWorkflow, needsFailedLogs, type FollowUpMode } from "./babysit.js";
import { hasUnseen, seenThrough, updatesSince } from "./prUpdates.js";
import { sessionPrItems } from "./sessionPrItems.js";
import { prRefFromUrl, sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export interface SessionPrSources {
  settings(): AppSettings;
  summaryLookup(): PrSummaryLookup;
  detail(key: string): PrDetail | undefined;
  detailError(key: string): string | null;
  babysit(sessionId: string): BabysitState | null;
}

export interface SessionPrModelDeps extends SessionPrSources {
  sessions(): SessionMeta[];
  isOpen(sessionId: string): boolean;
  refresh(sessionId: string): void;
  gitStatus(sessionId: string): GitStatus | null;
  branchMismatch(sessionId: string): BranchMismatch | null;
  startTurn(sessionId: string, prompt: string, input: { prRefs: PrRef[] }): Promise<string>;
  markPrSeen(sessionId: string, ref: PrRef, headSha: string | null, seenAt: number | null): void;
}

export interface DockItem {
  entry: PrDockEntry;
  seenHead: string | null;
  seenAt: number | null;
}

const LOG_PREFIX = "[session-prs]";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function autoHint(mode: FollowUpMode, updates: PrUpdate[]): PrDockEntry["autoHint"] {
  if (mode.kind !== "auto") return null;
  if (mode.phase.kind === "paused") return "paused";
  if (!updates.some((update) => update.actionable)) return "not-actionable";
  if (mode.phase.kind === "working") return "after-turn";
  return "sending";
}

interface DockContext {
  sources: SessionPrSources;
  settings: AppSettings;
  summaryByKey: PrSummaryLookup;
  babysit: BabysitState | null;
}

function dockItem(session: SessionMeta, link: SessionPrLink, { sources, settings, summaryByKey, babysit }: DockContext): DockItem {
  const workflows = settings.prWorkflows;
  const key = prKey(link.ref);
  const detail = sources.detail(key);
  const summary = summaryByKey.get(key);
  const pr = summary ?? detail ?? null;
  const updates = detail ? updatesSince(detail, link) : [];
  const workflow = followUpWorkflow(link, pr, workflows);
  const workflowId = workflow?.id ?? defaultFollowUpWorkflowId(link, pr);
  const logsNeeded = workflow !== null && needsFailedLogs(workflow.updatePrompt);
  const prompt =
    detail && workflow && !logsNeeded && updates.length > 0
      ? followUpPrompt(detail, link, workflow, updates, settings, harnessLabel(session.driver))
      : null;
  return {
    entry: {
      key,
      ref: link.ref,
      updates,
      workflowId,
      workflowLabel: workflow?.label ?? null,
      isReview: workflowId === "review",
      logsNeeded,
      prompt,
      unseen: pr !== null && hasUnseen(pr, link),
      error: sources.detailError(key),
      autoHint: autoHint(followUpMode(session, link, pr, workflow, workflows, babysit), updates)
    },
    seenHead: detail?.headRefOid ?? summary?.headRefOid ?? null,
    seenAt: seenThrough(detail ?? summary, updates)
  };
}

export function sessionDockItems(session: SessionMeta, sources: SessionPrSources): DockItem[] {
  const links = sessionLinks(session);
  if (links.length === 0) return [];
  const context: DockContext = { sources, settings: sources.settings(), summaryByKey: sources.summaryLookup(), babysit: sources.babysit(session.id) };
  return links.map((link) => dockItem(session, link, context));
}

export function sessionPrItemsFor(
  session: SessionMeta,
  git: GitStatus | null,
  mismatch: BranchMismatch | null,
  summaryByKey: PrSummaryLookup,
  detail: (key: string) => PrDetail | undefined
): SessionPrItem[] {
  const gitPr = git?.pullRequest ?? null;
  const branchRef = gitPr ? prRefFromUrl(gitPr.url) : null;
  const keys = [...sessionLinks(session).map((link) => prKey(link.ref)), ...(branchRef ? [prKey(branchRef)] : [])];
  const detailByKey: Record<string, PrDetail> = {};
  for (const key of keys) {
    const found = detail(key);
    if (found) detailByKey[key] = found;
  }
  return sessionPrItems(session, gitPr, summaryByKey, detailByKey, mismatch !== null);
}

function isSendable(entry: PrDockEntry): boolean {
  return !entry.logsNeeded && entry.prompt !== null;
}

export function updatesToSend(items: DockItem[], keys: readonly string[]): { prompt: string; covered: DockItem[] } | null {
  const changed = items.filter((item) => item.entry.updates.length > 0);
  const requested = changed.filter((item) => keys.includes(item.entry.key));
  const covered = changed.length === 1 ? requested : requested.filter((item) => isSendable(item.entry));
  const prompt = changed.length === 1 ? (covered[0]?.entry.prompt ?? null) : combinedPrompt(covered.map((item) => item.entry));
  return covered.length > 0 && prompt ? { prompt, covered } : null;
}

export class SessionPrModel {
  private scheduled = false;

  constructor(private readonly deps: SessionPrModelDeps) {}

  extras(sessionId: string): ThreadExtras {
    const session = this.session(sessionId);
    if (!session) return { prItems: [], prDock: [] };
    const prItems = sessionPrItemsFor(
      session,
      this.deps.gitStatus(sessionId),
      this.deps.branchMismatch(sessionId),
      this.deps.summaryLookup(),
      (key) => this.deps.detail(key)
    );
    const prDock = sessionDockItems(session, this.deps).map((item) => item.entry);
    return JSON.parse(JSON.stringify({ prItems, prDock })) as ThreadExtras;
  }

  watch(...sources: ChangeSource[]): () => void {
    const stops = sources.map((source) => source(() => this.invalidate()));
    return () => {
      for (const stop of stops) stop();
    };
  }

  invalidate(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.refreshOpen();
    });
  }

  async sendUpdates(sessionId: string, keys: readonly string[]): Promise<string> {
    const session = this.requireSession(sessionId);
    const send = updatesToSend(sessionDockItems(session, this.deps), keys);
    if (!send) throw new Error("no pull request updates to send");
    const turnId = await this.deps.startTurn(sessionId, send.prompt, { prRefs: send.covered.map((item) => item.entry.ref) });
    for (const item of send.covered) {
      try {
        this.markSeen(sessionId, item);
      } catch (error) {
        console.warn(`${LOG_PREFIX} sent ${item.entry.key} to session ${sessionId} but could not mark it seen: ${describeError(error)}`);
      }
    }
    return turnId;
  }

  dismissUpdates(sessionId: string, keys: readonly string[]): void {
    const session = this.requireSession(sessionId);
    for (const item of sessionDockItems(session, this.deps)) {
      if (keys.includes(item.entry.key)) this.markSeen(sessionId, item);
    }
  }

  private markSeen(sessionId: string, item: DockItem): void {
    this.deps.markPrSeen(sessionId, item.entry.ref, item.seenHead, item.seenAt);
  }

  private refreshOpen(): void {
    for (const session of this.deps.sessions()) {
      if (!this.deps.isOpen(session.id)) continue;
      try {
        this.deps.refresh(session.id);
      } catch (error) {
        console.warn(`${LOG_PREFIX} refresh for session ${session.id} failed: ${describeError(error)}`);
      }
    }
  }

  private session(sessionId: string): SessionMeta | undefined {
    return this.deps.sessions().find((session) => session.id === sessionId);
  }

  private requireSession(sessionId: string): SessionMeta {
    const session = this.session(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }
}
