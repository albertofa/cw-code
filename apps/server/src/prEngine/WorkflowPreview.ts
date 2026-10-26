import { createHash } from "node:crypto";
import type {
  AppSettings,
  DriverKind,
  IssueDetail,
  IssueRef,
  ModelOption,
  PermissionOption,
  PrDetail,
  PrRef,
  PrSummary,
  PrWorkflow,
  ProjectGitHubRepo,
  RunRef,
  SessionMeta,
  WorkflowHarnessRequest,
  WorkflowHarnessResult,
  WorkflowPreview,
  WorkflowPreviewRequest,
  WorkflowRunSummary,
  WorkflowSubject,
  WorkflowTemplatePreview,
  WorkflowTemplatePreviewRequest
} from "@cw-code/contracts";
import { withAutomatedWorkflowNote } from "@cw-code/shared/autoFollowUp";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import { prKey, projectIdFor } from "@cw-code/shared/prRef";
import { attributionText, resolveTemplate } from "@cw-code/shared/workflowTemplates";
import { issueKey, runKey } from "../github/prLinks.js";
import { needsFailedLogs, needsRunFailedLogs, startsAutoFollowUp } from "./babysit.js";
import { summaryOf } from "./PrStore.js";
import { updatesSince } from "./prUpdates.js";
import {
  babysittingSession,
  issueTemplateVars,
  loadFailedLogs,
  loadRunFailedLogs,
  runRefTemplateVars,
  runTemplateVars,
  templateVars,
  type CheckLogFetcher,
  type RunLogFetcher
} from "./prWorkflows.js";
import { linkFor, linkWithWorkflow } from "./sessionPrLinks.js";
import { harnessSummary, INHERITED_HARNESS, resolveWorkflowHarness, workflowDriver } from "./workflowHarness.js";
import {
  effectiveSubject,
  isLinkedTo,
  otherSessionCandidates,
  repoOf,
  resolveIssueBase,
  resolveRunBase,
  subjectLabel,
  workflowsForSubject
} from "./workflowSubject.js";

export interface WorkflowPreviewDeps {
  settings(): AppSettings;
  sessions(): SessionMeta[];
  projects(): Array<{ id: string; name: string }>;
  projectRepos(): Promise<ProjectGitHubRepo[]>;
  installedHarnesses(): DriverKind[];
  recentModels(driver: DriverKind): string[];
  listModels(driver: DriverKind, projectId: string | null): Promise<ModelOption[]>;
  listPermissions(driver: DriverKind, projectId: string | null): Promise<PermissionOption[]>;
  prSummary(key: string): PrSummary | undefined;
  prDetail(key: string): PrDetail | undefined;
  prDetailError(key: string): string | null;
  loadPrDetail(ref: PrRef): Promise<PrDetail>;
  issueDetail(ref: IssueRef): Promise<IssueDetail>;
  cachedRun(ref: RunRef): WorkflowRunSummary | undefined;
  checkLog: CheckLogFetcher;
  runLog: RunLogFetcher;
  now?(): number;
}

type CacheRead<T> = { value: T } | { error: string } | { pending: true };

interface CacheEntry<T> {
  promise: Promise<void>;
  state: { value: T } | { error: string } | null;
  at: number;
}

interface CacheTtl {
  value: number;
  error: number;
}

interface PrData {
  detail: PrDetail | undefined;
  summary: PrSummary | undefined;
  error: string | null;
}

interface LogsRead {
  ready: boolean;
  text: string | undefined;
  error: string | null;
}

const HARNESS_IDS: readonly DriverKind[] = ["claude", "opencode", "codex"];
const PR_REFRESH_MS = 60_000;
const PR_ERROR_RETRY_MS = 60_000;
const ISSUE_TTL: CacheTtl = { value: 60_000, error: 60_000 };
const LOGS_TTL: CacheTtl = { value: 10 * 60_000, error: 60_000 };
const OPTIONS_TTL: CacheTtl = { value: 30_000, error: 10_000 };
const MAX_CACHED = 20;
const NO_LOGS: LogsRead = { ready: true, text: undefined, error: null };
const PENDING_LOGS: LogsRead = { ready: false, text: undefined, error: null };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class LoadCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttl: CacheTtl,
    private readonly now: () => number
  ) {}

  async read(key: string, load: () => Promise<T>, waitForNew: boolean, retry = false): Promise<CacheRead<T>> {
    const existing = this.entries.get(key);
    if (existing?.state) {
      const ttl = "error" in existing.state ? this.ttl.error : this.ttl.value;
      if (!(retry && "error" in existing.state) && this.now() - existing.at <= ttl) return existing.state;
      this.entries.delete(key);
    } else if (existing) {
      await existing.promise;
      return this.settled(key, existing);
    }
    const entry = this.begin(key, load);
    if (!waitForNew) return { pending: true };
    await entry.promise;
    return this.settled(key, entry);
  }

  private begin(key: string, load: () => Promise<T>): CacheEntry<T> {
    const entry: CacheEntry<T> = { promise: Promise.resolve(), state: null, at: this.now() };
    entry.promise = load().then(
      (value) => {
        entry.state = { value };
        entry.at = this.now();
      },
      (error: unknown) => {
        entry.state = { error: describeError(error) };
        entry.at = this.now();
      }
    );
    this.entries.set(key, entry);
    for (const old of [...this.entries.keys()].slice(0, Math.max(0, this.entries.size - MAX_CACHED))) this.entries.delete(old);
    return entry;
  }

  private settled(key: string, entry: CacheEntry<T>): CacheRead<T> {
    return entry.state ?? { error: "load did not finish" };
  }
}

export function defaultModelFor(settings: AppSettings, driver: DriverKind): string {
  switch (driver) {
    case "claude":
      return settings.claudeDefaultModel;
    case "opencode":
      return settings.opencodeDefaultModel;
    case "codex":
      return settings.codexDefaultModel;
  }
}

function fresher(summary: PrSummary | undefined, detail: PrDetail | undefined): PrSummary | undefined {
  if (!summary || !detail) return detail ?? summary;
  return detail.updatedAt >= summary.updatedAt ? detail : summary;
}

function withOverride(text: string, override: string | null, updateMode: boolean): string {
  const extra = override?.trim();
  if (!extra) return text;
  return updateMode ? extra : `${text}\n\n${extra}`;
}

function logsOf(read: CacheRead<string>): LogsRead {
  if ("pending" in read) return PENDING_LOGS;
  if ("error" in read) return { ready: true, text: "", error: read.error };
  return { ready: true, text: read.value, error: null };
}

function optionsOf<T>(read: CacheRead<T[]>): T[] {
  if ("value" in read) return read.value;
  throw new Error("error" in read ? read.error : "load did not finish");
}

function revisionOf(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export class WorkflowPreviewService {
  private readonly issues: LoadCache<IssueDetail>;
  private readonly logs: LoadCache<string>;
  private readonly models: LoadCache<ModelOption[]>;
  private readonly permissions: LoadCache<PermissionOption[]>;
  private readonly prRefreshedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: WorkflowPreviewDeps) {
    this.now = deps.now ?? Date.now;
    this.issues = new LoadCache(ISSUE_TTL, this.now);
    this.logs = new LoadCache(LOGS_TTL, this.now);
    this.models = new LoadCache(OPTIONS_TTL, this.now);
    this.permissions = new LoadCache(OPTIONS_TTL, this.now);
  }

  async resolveHarness(req: WorkflowHarnessRequest): Promise<WorkflowHarnessResult> {
    const driver = workflowDriver(req.config, req.composerDriver);
    const errors: string[] = [];
    const failed = (what: string) => (error: unknown) => {
      errors.push(`${what}: ${describeError(error)}`);
      return [];
    };
    const key = `${driver}:${req.projectId ?? ""}:${revisionOf([this.deps.settings()])}`;
    const [models, permissions] = await Promise.all([
      this.models
        .read(key, () => this.deps.listModels(driver, req.projectId), true)
        .then(optionsOf)
        .catch(failed("models")),
      this.permissions
        .read(key, () => this.deps.listPermissions(driver, req.projectId), true)
        .then(optionsOf)
        .catch(failed("permission modes"))
    ]);
    const resolved = resolveWorkflowHarness(req.config, {
      composerDriver: req.composerDriver,
      pendingPrefs: req.pendingPrefs,
      defaultModel: defaultModelFor(this.deps.settings(), driver),
      recentModels: this.deps.recentModels(driver),
      models,
      permissions
    });
    return {
      resolved,
      summary: harnessSummary(req.config, resolved, { models, permissions, pendingPrefs: req.pendingPrefs }),
      error: errors.length > 0 ? errors.join("; ") : null
    };
  }

  async previewTemplate(req: WorkflowTemplatePreviewRequest): Promise<WorkflowTemplatePreview> {
    const retry = req.retry === true;
    const pr = await this.prData(req.ref, retry);
    const logsNeeded = needsFailedLogs(req.template);
    const logs = !logsNeeded ? NO_LOGS : pr.detail ? await this.prLogs(pr.detail, retry) : PENDING_LOGS;
    const harness = harnessLabel(req.driver);
    const text =
      pr.detail && logs.ready
        ? resolveTemplate(req.template, templateVars(pr.detail, { attribution: req.attribution, harness, failedLogs: logs.text }))
        : null;
    return { text, loaded: pr.detail !== undefined && logs.ready, error: pr.error, logsNeeded, logsReady: logs.ready, logsError: logs.error };
  }

  async preview(req: WorkflowPreviewRequest): Promise<WorkflowPreview> {
    const settings = this.deps.settings();
    const retry = req.retry === true;
    const baseSubject = req.subject;
    const cachedRun = baseSubject.kind === "run" ? this.deps.cachedRun(baseSubject.ref) : undefined;
    const workflows = workflowsForSubject(settings.prWorkflows, baseSubject, cachedRun);
    const sessions = this.deps.sessions();
    const continueSession = req.continueSessionId ? sessions.find((s) => s.id === req.continueSessionId) : undefined;
    const basePr = baseSubject.kind === "pr" ? await this.prData(baseSubject.ref, retry) : null;
    const basePrState = basePr ? fresher(basePr.summary, basePr.detail)?.state : undefined;
    const babysitWorkflow =
      continueSession && baseSubject.kind === "pr" && (basePrState === undefined || basePrState === "OPEN")
        ? (babysittingSession([continueSession], baseSubject.ref, workflows)?.workflow ?? null)
        : null;
    const activeWorkflowId = babysitWorkflow?.id ?? req.workflowId;
    const pickable = babysitWorkflow ? [babysitWorkflow] : workflows.filter((w) => w.enabled || w.id === req.workflowId);
    const workflow: PrWorkflow | undefined = workflows.find((w) => w.id === activeWorkflowId);
    const subject = effectiveSubject(baseSubject, workflow, cachedRun);

    const linkedSessions = sessions
      .filter((s) => s.status !== "archived" && isLinkedTo(s, subject))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const projectId = projectIdFor(await this.deps.projectRepos(), repoOf(subject));
    const continueAlreadyLinked = continueSession ? isLinkedTo(continueSession, subject) : false;
    const adoptedLink =
      continueSession && subject.kind === "pr" && !req.promptOverride?.trim() ? linkWithWorkflow(continueSession, subject.ref, activeWorkflowId) : null;
    const updateMode = continueSession !== undefined && continueAlreadyLinked && adoptedLink === null;
    const linkedOptions =
      continueSession && continueAlreadyLinked && !linkedSessions.includes(continueSession) ? [continueSession, ...linkedSessions] : linkedSessions;
    const otherSessions = otherSessionCandidates(sessions, subject, projectId, continueAlreadyLinked ? undefined : continueSession?.id);
    const projects = this.deps.projects();
    const projectName = projects.find((p) => p.id === projectId)?.name ?? "another project";
    const otherSessionsLabel = otherSessions.every((s) => s.projectId === projectId) ? `Other sessions in ${projectName}` : "Other sessions";

    const harnessConfig = workflow?.harness ?? INHERITED_HARNESS;
    const driver = workflowDriver(harnessConfig, req.composerDriver);
    const installed = this.deps.installedHarnesses();
    const driverMissing = !continueSession && !(installed.length === 0 ? HARNESS_IDS : installed).includes(driver);
    const harnessPromise =
      continueSession || driverMissing
        ? Promise.resolve(null)
        : this.resolveHarness({ config: harnessConfig, composerDriver: req.composerDriver, pendingPrefs: req.pendingPrefs, projectId });
    const effectiveDriver = continueSession?.driver ?? driver;
    const harnessName = harnessLabel(effectiveDriver);
    const linkedWorktree = subject.kind === "pr" ? linkedSessions.find((s) => s.worktreePath && s.projectId === projectId) : undefined;
    const requestedWorkspace = req.workspace ?? workflow?.workspace ?? "worktree";
    const workspace = requestedWorkspace === "linked" && !linkedWorktree ? "worktree" : requestedWorkspace;
    const template = workflow ? (updateMode ? workflow.updatePrompt : workflow.startPrompt) : "";
    const updateSession = updateMode ? continueSession : undefined;

    const [data, harness] = await Promise.all([
      this.subjectData(subject, basePr, cachedRun, template, updateSession, settings, workflow !== undefined, harnessName, retry),
      harnessPromise
    ]);
    const prompt = data.vars && workflow ? withOverride(withAutomatedWorkflowNote(workflow, resolveTemplate(template, data.vars)), req.promptOverride, updateMode) : null;
    const startsContinuous =
      subject.kind === "pr" &&
      !babysitWorkflow &&
      startsAutoFollowUp({ status: continueSession?.status ?? "idle" }, workflow, basePrState ? { state: basePrState } : null) &&
      (!continueAlreadyLinked || adoptedLink !== null);

    return {
      activeWorkflowId,
      pickableWorkflowIds: pickable.map((w) => w.id),
      babysitLocked: babysitWorkflow !== null,
      startsContinuous,
      adoptsLink: adoptedLink !== null,
      subject,
      subjectLabel: subjectLabel(subject, cachedRun?.runNumber),
      updateMode,
      linkedSessionIds: linkedOptions.map((s) => s.id),
      otherSessionIds: otherSessions.map((s) => s.id),
      otherSessionsLabel,
      projectId,
      needsClone: !continueSession && projectId === null,
      workspace,
      linkedWorktreeSessionId: linkedWorktree?.id ?? null,
      driverMissing,
      harness,
      base: subject.kind === "issue" ? resolveIssueBase() : subject.kind === "run" ? resolveRunBase(cachedRun) : null,
      pr: data.pr,
      issue: data.issue,
      run: cachedRun ?? null,
      loaded: data.loaded,
      error: data.error,
      logsNeeded: data.logsNeeded,
      logsReady: data.logs.ready,
      logsError: data.logs.error,
      prompt,
      revision: revisionOf([activeWorkflowId, req.continueSessionId, effectiveDriver, updateMode, prompt])
    };
  }

  private async subjectData(
    subject: WorkflowSubject,
    basePr: PrData | null,
    cachedRun: WorkflowRunSummary | undefined,
    template: string,
    updateSession: SessionMeta | undefined,
    settings: AppSettings,
    hasWorkflow: boolean,
    harness: string,
    retry: boolean
  ): Promise<{
    pr: PrSummary | null;
    issue: IssueDetail | null;
    loaded: boolean;
    error: string | null;
    logsNeeded: boolean;
    logs: LogsRead;
    vars: Record<string, string> | null;
  }> {
    const attribution = attributionText(settings, harness);
    switch (subject.kind) {
      case "pr": {
        const pr = basePr ?? (await this.prData(subject.ref, retry));
        const logsNeeded = needsFailedLogs(template);
        const logs = !logsNeeded ? NO_LOGS : pr.detail ? await this.prLogs(pr.detail, retry) : PENDING_LOGS;
        const link = updateSession ? linkFor(updateSession, subject.ref) : undefined;
        const vars =
          hasWorkflow && pr.detail && logs.ready
            ? templateVars(pr.detail, {
                link,
                updates: link ? updatesSince(pr.detail, link) : undefined,
                failedLogs: logs.text,
                attribution,
                harness
              })
            : null;
        const card = pr.detail ? summaryOf(pr.detail) : (pr.summary ?? null);
        return { pr: card, issue: null, loaded: pr.detail !== undefined && logs.ready, error: pr.detail ? null : pr.error, logsNeeded, logs, vars };
      }
      case "issue": {
        const read = await this.issues.read(issueKey(subject.ref), () => this.deps.issueDetail(subject.ref), true, retry);
        const issue = "value" in read ? read.value : null;
        const key = issueKey(subject.ref);
        const link = updateSession?.issues?.find((item) => issueKey(item.ref) === key);
        const vars = hasWorkflow && issue ? issueTemplateVars(issue, { link, attribution, harness }) : null;
        return { pr: null, issue, loaded: issue !== null, error: "error" in read ? read.error : null, logsNeeded: false, logs: NO_LOGS, vars };
      }
      case "run": {
        const logsNeeded = needsRunFailedLogs(template);
        const logs = logsNeeded ? await this.runLogs(subject.ref, cachedRun, retry) : NO_LOGS;
        const opts = { failedLogs: logs.text, attribution, harness };
        const vars = hasWorkflow && logs.ready ? (cachedRun ? runTemplateVars(cachedRun, opts) : runRefTemplateVars(subject.ref, opts)) : null;
        return { pr: null, issue: null, loaded: logs.ready, error: null, logsNeeded, logs, vars };
      }
    }
  }

  private async prData(ref: PrRef, retry: boolean): Promise<PrData> {
    const key = prKey(ref);
    const now = this.now();
    let detail = this.deps.prDetail(key);
    let error: string | null = null;
    const refreshedAt = this.prRefreshedAt.get(key);
    const knownError = detail ? null : this.deps.prDetailError(key);
    if (knownError && !retry && refreshedAt !== undefined && now - refreshedAt <= PR_ERROR_RETRY_MS) {
      return { detail: undefined, summary: this.deps.prSummary(key), error: knownError };
    }
    if (!detail) {
      this.markRefreshed(key, now);
      try {
        detail = await this.deps.loadPrDetail(ref);
      } catch (err) {
        error = describeError(err);
      }
    } else if (refreshedAt === undefined || now - refreshedAt > PR_REFRESH_MS) {
      this.markRefreshed(key, now);
      this.deps.loadPrDetail(ref).catch(() => undefined);
    }
    return { detail, summary: this.deps.prSummary(key), error };
  }

  private markRefreshed(key: string, now: number): void {
    this.prRefreshedAt.set(key, now);
    if (this.prRefreshedAt.size <= MAX_CACHED * 5) return;
    for (const [entry, at] of this.prRefreshedAt) if (now - at > PR_REFRESH_MS) this.prRefreshedAt.delete(entry);
  }

  private async prLogs(detail: PrDetail, retry: boolean): Promise<LogsRead> {
    const key = `pr:${prKey(detail.ref)}@${detail.headRefOid}`;
    return logsOf(await this.logs.read(key, () => loadFailedLogs(detail, this.deps.checkLog), false, retry));
  }

  private async runLogs(ref: RunRef, run: WorkflowRunSummary | undefined, retry: boolean): Promise<LogsRead> {
    const key = `run:${runKey(ref)}:${run?.status ?? ""}:${run?.conclusion ?? ""}`;
    return logsOf(await this.logs.read(key, () => loadRunFailedLogs(ref, this.deps.runLog), false, retry));
  }
}
