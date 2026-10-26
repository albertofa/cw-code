import type {
  ComposerPrefs,
  CreateSessionOptions,
  DriverKind,
  IssueDetail,
  IssueRef,
  Project,
  PrRef,
  PrSummary,
  PrWorkflow,
  RepoRef,
  ResolvedWorkflowHarness,
  RunRef,
  SessionIssueLink,
  SessionMeta,
  SessionPrLink,
  SessionRunLink,
  WorkflowHarnessRequest,
  WorkflowHarnessResult,
  WorkflowPreview,
  WorkflowPreviewRequest,
  WorkflowRunRequest,
  WorkflowRunResult,
  WorkflowRunResume,
  WorkflowRunStage
} from "@cw-code/contracts";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import type { StartTurnInput } from "../threads/TurnService.js";
import { linkWithWorkflow } from "./sessionPrLinks.js";
import { INHERITED_HARNESS, workflowDriver } from "./workflowHarness.js";
import { isLinkedTo, issueDataTime, repoOf } from "./workflowSubject.js";

export interface WorkflowRunnerDeps {
  preview(req: WorkflowPreviewRequest): Promise<WorkflowPreview>;
  resolveHarness(req: WorkflowHarnessRequest): Promise<WorkflowHarnessResult>;
  workflows(): PrWorkflow[];
  sessions(): SessionMeta[];
  /** True when cw-code owns the worktree path, so it may be reused as the linked workspace. */
  ownsWorktree(path: string): boolean;
  clone(repo: RepoRef): Promise<Project>;
  refreshProjectRepos(): Promise<unknown>;
  createSession(projectId: string, driver: DriverKind, options: CreateSessionOptions): Promise<SessionMeta>;
  setComposer(sessionId: string, prefs: ComposerPrefs): void;
  linkPr(sessionId: string, link: SessionPrLink): void;
  linkIssue(sessionId: string, link: SessionIssueLink): void;
  linkRun(sessionId: string, link: SessionRunLink): void;
  markPrSeen(sessionId: string, ref: PrRef, headSha: string, seenAt: number): void;
  markIssueSeen(sessionId: string, ref: IssueRef, seenAt: number): void;
  markRunSeen(sessionId: string, ref: RunRef, seenAt: number): void;
  startTurn(sessionId: string, prompt: string, input: StartTurnInput): Promise<string>;
  postNotice(sessionId: string, noticeId: string, text: string, severity: "info" | "warning" | "error"): void;
  now?(): number;
}

interface RunState {
  stage: WorkflowRunStage;
  resume: WorkflowRunResume | null;
}

interface RunRecord {
  promise: Promise<WorkflowRunResult>;
  result: WorkflowRunResult | null;
  at: number;
}

interface Ready {
  preview: WorkflowPreview;
  workflow: PrWorkflow;
}

const RUN_RECORD_TTL_MS = 10 * 60_000;
const MAX_RUN_RECORDS = 100;
export const PREVIEW_CHANGED_MESSAGE = "The preview changed — review it again";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resumedStage(resume: WorkflowRunResume, continuing: boolean): WorkflowRunStage {
  if (continuing) return !resume.sent ? "send" : !resume.linked ? "link" : "seen";
  return !resume.linked ? "link" : !resume.sent ? "send" : "seen";
}

function initialStage(req: WorkflowRunRequest): WorkflowRunStage {
  if (req.resume) return resumedStage(req.resume, req.continueSessionId !== null);
  return req.continueSessionId ? "send" : "create";
}

function loadedPr(preview: WorkflowPreview): PrSummary {
  if (!preview.pr || preview.error !== null) throw new Error("pull request details are not loaded");
  return preview.pr;
}

function loadedIssue(preview: WorkflowPreview): IssueDetail {
  if (!preview.issue) throw new Error("issue details are not loaded");
  return preview.issue;
}

function sendInput(preview: WorkflowPreview): StartTurnInput {
  return preview.subject.kind === "pr" ? { prRefs: [preview.subject.ref] } : {};
}

function pushNote(preview: WorkflowPreview, sessionBranch: string | undefined): string | null {
  const { subject, pr } = preview;
  if (subject.kind !== "pr" || !pr?.viewerIsAuthor || !sessionBranch || sessionBranch === pr.headRefName) return null;
  return `You are on branch ${sessionBranch}, not the PR head. To update PR #${subject.ref.number}, push with: git push origin HEAD:${pr.headRefName}`;
}

function sameResume(a: WorkflowRunResume | null, b: WorkflowRunResume | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class WorkflowRunner {
  private readonly now: () => number;
  private readonly records = new Map<string, RunRecord>();

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  run(req: WorkflowRunRequest): Promise<WorkflowRunResult> {
    this.pruneRecords();
    const known = this.records.get(req.runId);
    if (known && !this.startsNewAttempt(known, req)) return known.promise;
    const promise = this.attempt(req).then((result) => {
      record.result = result;
      record.at = this.now();
      return result;
    });
    const record: RunRecord = { promise, result: null, at: this.now() };
    this.records.delete(req.runId);
    this.records.set(req.runId, record);
    return record.promise;
  }

  private startsNewAttempt(known: RunRecord, req: WorkflowRunRequest): boolean {
    const result = known.result;
    if (!result || result.ok) return false;
    return sameResume(result.resume, req.resume);
  }

  private pruneRecords(): void {
    const now = this.now();
    for (const [runId, record] of this.records) {
      if (record.result && now - record.at > RUN_RECORD_TTL_MS) this.records.delete(runId);
    }
    for (const [runId, record] of this.records) {
      if (this.records.size < MAX_RUN_RECORDS) break;
      if (record.result) this.records.delete(runId);
    }
  }

  private async attempt(req: WorkflowRunRequest): Promise<WorkflowRunResult> {
    const state: RunState = { stage: initialStage(req), resume: req.resume };
    try {
      const sessionId = req.continueSessionId ? await this.continueRun(state, req, req.continueSessionId) : await this.newRun(state, req);
      return { ok: true, sessionId };
    } catch (error) {
      const message = describeError(error);
      console.warn(`[workflow] ${req.subject.kind} run failed at ${state.stage}: ${message}`);
      return { ok: false, stage: state.stage, message, resume: state.resume };
    }
  }

  private async prepare(req: WorkflowRunRequest): Promise<Ready> {
    const preview = await this.deps.preview(req);
    const workflow = this.deps.workflows().find((w) => w.id === preview.activeWorkflowId);
    if (!workflow) throw new Error(`workflow ${preview.activeWorkflowId} no longer exists`);
    if (preview.subject.kind === "pr") loadedPr(preview);
    if (preview.subject.kind === "issue") loadedIssue(preview);
    if (!req.resume && req.expectedRevision !== null && preview.revision !== req.expectedRevision) throw new Error(PREVIEW_CHANGED_MESSAGE);
    return { preview, workflow };
  }

  private session(sessionId: string): SessionMeta {
    const session = this.deps.sessions().find((s) => s.id === sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }

  private async continueRun(state: RunState, req: WorkflowRunRequest, sessionId: string): Promise<string> {
    this.session(sessionId);
    if (state.resume && state.resume.sessionId !== sessionId) throw new Error("the retry belongs to another session");
    const { preview, workflow } = await this.prepare(req);
    let resume = state.resume;
    if (!resume?.sent) {
      state.stage = "send";
      await this.deps.startTurn(sessionId, req.prompt, sendInput(preview));
      resume = state.resume = { sessionId, linked: false, sent: true, note: null };
    }
    if (!resume.linked) {
      state.stage = "link";
      const sent = this.session(sessionId);
      if (!isLinkedTo(sent, preview.subject)) {
        this.link(preview, sessionId, workflow.id, true);
      } else if (preview.adoptsLink && preview.subject.kind === "pr") {
        const adopted = linkWithWorkflow(sent, preview.subject.ref, preview.activeWorkflowId);
        if (adopted) this.deps.linkPr(sessionId, adopted);
      }
      resume = state.resume = { ...resume, linked: true };
    }
    state.stage = "seen";
    this.markSeen(preview, sessionId);
    return sessionId;
  }

  private async newRun(state: RunState, req: WorkflowRunRequest): Promise<string> {
    if (state.resume) this.session(state.resume.sessionId);
    const { preview, workflow } = await this.prepare(req);
    let resume = state.resume ?? (await this.createSession(state, req, preview, workflow));
    if (!resume.linked) {
      state.stage = "link";
      this.link(preview, resume.sessionId, workflow.id, false);
      resume = state.resume = { ...resume, linked: true };
    }
    if (!resume.sent) {
      state.stage = "send";
      const prompt = resume.note ? `${req.prompt}\n\n${resume.note}` : req.prompt;
      await this.deps.startTurn(resume.sessionId, prompt, sendInput(preview));
      resume = state.resume = { ...resume, sent: true };
    }
    state.stage = "seen";
    this.markSeen(preview, resume.sessionId);
    return resume.sessionId;
  }

  private async createSession(state: RunState, req: WorkflowRunRequest, preview: WorkflowPreview, workflow: PrWorkflow): Promise<WorkflowRunResume> {
    const config = workflow.harness ?? INHERITED_HARNESS;
    let projectId = preview.projectId;
    state.stage = "create";
    if (preview.driverMissing) throw new Error(`${harnessLabel(workflowDriver(config, req.composerDriver))} isn't installed`);
    let harness: ResolvedWorkflowHarness | null = preview.harness?.resolved ?? null;
    if (!projectId) {
      state.stage = "clone";
      const project = await this.deps.clone(repoOf(preview.subject));
      await this.deps.refreshProjectRepos();
      projectId = project.id;
      harness = (await this.deps.resolveHarness({ config, composerDriver: req.composerDriver, pendingPrefs: req.pendingPrefs, projectId })).resolved;
    }
    state.stage = "create";
    if (!harness) throw new Error("the harness options are not available");
    const options = this.workspaceOptions(preview, projectId);
    const session = await this.deps.createSession(projectId, harness.driver, options);
    this.reportCreated(session, options);
    this.deps.setComposer(session.id, {
      ...req.pendingPrefs,
      model: harness.model,
      effort: harness.effort,
      permissionMode: harness.permissionMode
    });
    const resume: WorkflowRunResume = { sessionId: session.id, linked: false, sent: false, note: pushNote(preview, session.branch) };
    state.resume = resume;
    return resume;
  }

  private workspaceOptions(preview: WorkflowPreview, projectId: string): CreateSessionOptions {
    const mode = preview.workspace === "checkout" ? "current" : "new";
    const { subject, base } = preview;
    switch (subject.kind) {
      case "pr": {
        const pr = loadedPr(preview);
        const prHead = { number: subject.ref.number, headRefName: pr.headRefName, headRefOid: pr.headRefOid, viewerIsAuthor: pr.viewerIsAuthor };
        const linked = preview.linkedWorktreeSessionId ? this.deps.sessions().find((s) => s.id === preview.linkedWorktreeSessionId) : undefined;
        if (preview.workspace === "linked" && linked?.worktreePath && linked.projectId === projectId && this.deps.ownsWorktree(linked.worktreePath)) {
          return { mode: "previous", reuseWorktreePath: linked.worktreePath, prHead };
        }
        return { mode, prHead };
      }
      case "issue":
        return base?.baseBranch ? { mode, baseBranch: base.baseBranch } : { mode };
      case "run":
        return base?.baseBranch ? { mode, baseBranch: base.baseBranch, baseFallback: "default" } : { mode };
    }
  }

  private reportCreated(session: SessionMeta, options: CreateSessionOptions): void {
    const noticeId = (kind: string) => `workflow:${session.id}:${this.now()}:${kind}`;
    if (session.createNotice) this.deps.postNotice(session.id, noticeId("base"), session.createNotice, "warning");
    const requested = options.mode === "previous" ? options.reuseWorktreePath : undefined;
    if (!requested || !session.worktreePath || session.worktreePath === requested) return;
    const stillHeld = this.deps.sessions().some((s) => s.projectId === session.projectId && s.worktreePath === requested);
    const text = stillHeld
      ? "Created a new worktree instead of reusing the linked one."
      : "Created a new worktree instead: the linked worktree no longer exists.";
    this.deps.postNotice(session.id, noticeId("worktree"), text, "warning");
  }

  private link(preview: WorkflowPreview, sessionId: string, workflowId: string, deferSeen: boolean): void {
    const { subject } = preview;
    switch (subject.kind) {
      case "pr": {
        const pr = loadedPr(preview);
        this.deps.linkPr(sessionId, {
          ref: subject.ref,
          origin: "workflow",
          workflowId,
          lastSeenSha: deferSeen ? "" : pr.headRefOid,
          lastSeenAt: deferSeen ? 0 : pr.updatedAt
        });
        return;
      }
      case "issue": {
        const issue = loadedIssue(preview);
        this.deps.linkIssue(sessionId, { ref: subject.ref, origin: "workflow", workflowId, lastSeenAt: deferSeen ? 0 : issueDataTime(issue) });
        return;
      }
      case "run":
        this.deps.linkRun(sessionId, {
          ref: subject.ref,
          origin: "workflow",
          workflowId,
          lastSeenAt: deferSeen ? 0 : (preview.run?.updatedAt ?? this.now())
        });
    }
  }

  private markSeen(preview: WorkflowPreview, sessionId: string): void {
    const { subject } = preview;
    switch (subject.kind) {
      case "pr":
        if (preview.pr && preview.error === null) this.deps.markPrSeen(sessionId, subject.ref, preview.pr.headRefOid, preview.pr.updatedAt);
        return;
      case "issue":
        if (preview.issue) this.deps.markIssueSeen(sessionId, subject.ref, issueDataTime(preview.issue));
        return;
      case "run":
        if (preview.run) this.deps.markRunSeen(sessionId, subject.ref, preview.run.updatedAt);
    }
  }
}
