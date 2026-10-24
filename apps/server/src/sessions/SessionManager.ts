import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AppSettings,
  ApprovalDecision,
  CliDriver,
  CommandInvocation,
  CommandOption,
  ComposerPrefs,
  CreateSessionOptions,
  DriverKind,
  GitStatus,
  HistoryMessage,
  ImportableSession,
  ImportSessionRequest,
  ImportSessionResult,
  IssueRef,
  ModelOption,
  NativeSession,
  PermissionOption,
  PrLinkSnapshot,
  PrRef,
  PrSummary,
  Project,
  ProjectSettings,
  RetryConnectionResult,
  RunRef,
  SessionCleanupResult,
  SessionIssueLink,
  SessionMeta,
  SessionPrLink,
  SessionRunLink,
  SessionStatus,
  SettingsPatch,
  ShutdownActiveTurn,
  SubagentToolsResult,
  TaskSnapshot,
  TerminalLaunch,
  ThreadEvent,
  TurnChanges,
  TurnHandle,
  TurnSnapshot,
  UsageLedgerQuery,
  UsageLedgerRow,
  WorktreePruneSummary
} from "@cw-code/contracts";
import { type SessionStatusReason } from "../debug/sessionStatusTrace.js";
import { isWorkingSetStatus } from "@cw-code/shared/workingSet";
import { autoFollowUpWorkflow, babysitsOpenPr } from "@cw-code/shared/autoFollowUp";
import { SessionStore } from "./SessionStore.js";
import {
  addUnlinkedKey,
  applyFinalReview,
  applyLinkSnapshots,
  applyTurnSeen,
  authorLocalBranch,
  collectTrackedPrRefs,
  findIssueLink,
  findLink,
  findRunLink,
  isFinishedPrState,
  latestLinkSnapshots,
  linkFromStatus,
  markLinkSeenAt,
  markSeen,
  onlyFinishedLinks,
  prHeadPlan,
  removeIssueLink,
  removeLink,
  removeRunLink,
  removeUnlinkedKey,
  upsertIssueLink,
  upsertLink,
  upsertRunLink,
  type PrHeadPlan
} from "../github/prLinks.js";
import { prKey, prRefFromUrl } from "../github/prParsers.js";
import { buildTurnEnv, githubAccountEnv } from "./env.js";
import { defaultGitHubAccounts } from "../github/GitHubAccounts.js";
import { changedWorktreeBranch, comparableRoot, isWorktreeOrphaned, looksLikeWorktree, pinsWorktree, rootsOverlap, sameWorktreePath } from "./worktreeCleanup.js";
import { SettingsStore } from "../settings/SettingsStore.js";
import { resolveClaudeModels } from "../settings/settingsUtils.js";
import { permissionOption, withSyntheticFullAccess } from "../providers/permissions.js";
import { TracingCliDriver } from "../debug/tracingDriver.js";
import { CLAUDE_CURATED_MODELS, ClaudeCliDriver } from "../providers/claude/ClaudeCliDriver.js";
import { OpencodeDriver } from "../providers/opencode/OpencodeDriver.js";
import { CodexCliDriver } from "../providers/codex/CodexCliDriver.js";
import { claimedSessionKeys, importableSessions, nativeSessionKey, projectForCwd, withRepositories, type ImportContext, type PendingClaim } from "./sessionImport.js";
import { defaultBinary, execText, GitService, mapLimit, safeSegment, sessionBranchName, type CreatedWorktree, type RemoveWorktreeResult, type ResolveBaseOptions } from "../fs/GitService.js";
import { resolveAttachments } from "./attachments.js";
import { AUTO_TITLE_TIMEOUT_MS, buildTitlePrompt, parseGeneratedMetadata } from "./autoTitle.js";
import { branchNameForTitle, ownsSessionBranch, shouldRenameSessionBranch, TEMP_BRANCH_PATTERN } from "./branchName.js";
import { sanitizeProjectSettings } from "./projectSettings.js";
import { describeScriptResult, runWorktreeScript, scriptLabel } from "./worktreeScripts.js";
import { NEW_SESSION_TITLE, pickRestoreCandidate } from "./sessionRestore.js";
import { cwCodeHome, opencodeServerDir, sessionDbPath, settingsFilePath, titleGenDir, usageDir, worktreesDir } from "../paths/appPaths.js";
import { UsageLedger } from "../usage/UsageLedger.js";
import { shutdownReservedError } from "../shutdown/shutdownReservation.js";
import { overlayLiveTasks } from "../tasks/overlayLiveTasks.js";
import { PendingRequests, type PendingRequest } from "./PendingRequests.js";

export interface SessionManagerOptions {
  dbPath?: string;
  settingsPath?: string;
  sessionStore?: SessionStore;
  settingsStore?: SettingsStore;
  onEvent?: (sessionId: string, event: ThreadEvent) => void;
  onTitle?: (sessionId: string, title: string) => void;
  onResolved?: (sessionId: string) => void;
  drivers?: Partial<Record<DriverKind, CliDriver>>;
  gitService?: GitService;
  worktreesRoot?: string;
  prHead?: (ref: PrRef) => string | null;
  prHeadRefresh?: (ref: PrRef) => Promise<string | null>;
  prState?: (ref: PrRef) => PrSummary["state"] | null;
  prStateRefresh?: (ref: PrRef) => Promise<PrSummary["state"] | null>;
  prUpdatedAt?: (ref: PrRef) => number | null;
  usageLedger?: UsageLedger;
  driverFactory?: DriverFactory;
  /** Earlier app data folders whose worktrees may still hold sessions cw-code started. */
  legacyAppRoots?: string[];
}

export type DriverFactory = (
  route: (event: ThreadEvent) => void,
  getSettings: () => AppSettings,
  isInWorkingSet: (sessionId: string) => boolean
) => Record<DriverKind, CliDriver>;

export function defaultDriverFactory(overrides: Partial<Record<DriverKind, CliDriver>> = {}): DriverFactory {
  return (route, getSettings, isInWorkingSet) => ({
    claude: overrides.claude ?? new TracingCliDriver(new ClaudeCliDriver(route, getSettings, undefined, undefined, isInWorkingSet)),
    opencode:
      overrides.opencode ??
      new TracingCliDriver(new OpencodeDriver(route, getSettings, undefined, { sharedRoot: opencodeServerDir() })),
    codex: overrides.codex ?? new TracingCliDriver(new CodexCliDriver(route, getSettings))
  });
}

export interface BackgroundWork {
  sessionId: string;
  turnId: string;
  kind: "title";
}

const DRIVER_KINDS: DriverKind[] = ["claude", "opencode", "codex"];
const DRIVER_SHUTDOWN_GRACE_MS = 1000;

interface TitleTurn {
  sessionId: string;
  placeholder: string;
  applyTitle: boolean;
  expectBranch: boolean;
  text: string;
  settled: boolean;
  timer: NodeJS.Timeout;
  driver: CliDriver;
  promise: Promise<string | null>;
  resolve: (title: string | null) => void;
}

interface BranchOutcome {
  deleted: boolean;
  unmergedCommits?: boolean;
}

const DELTA_FLUSH_MS = 24;

function gitlinkReason(paths: string[]): string {
  return `Submodule or nested repository changes cannot be undone: ${paths.join(", ")}`;
}

function conflictReason(paths: string[]): string {
  return `Changed since the turn ended: ${paths.join(", ")}`;
}

function turnReachesPast(turn: TurnSnapshot, since: number): boolean {
  const endedAt = turn.endedAt ?? Number.NaN;
  if (!Number.isFinite(turn.capturedAt) || !Number.isFinite(endedAt) || !Number.isFinite(since)) return true;
  return Math.max(turn.capturedAt, endedAt) > since;
}

const INTERRUPT_SETTLE_TIMEOUT_MS = 3_000;
const INTERRUPT_SETTLE_POLL_MS = 100;

function withCreateNotice(session: SessionMeta, notice: string | null): SessionMeta {
  return notice ? { ...session, createNotice: notice } : session;
}

function storableBaseRef(baseRef: string | undefined, branch: string, options: CreateSessionOptions): { baseRef?: string } {
  const ref = baseRef?.trim();
  if (!ref || options.prHead || ref === "HEAD" || ref === branch) return {};
  return { baseRef: ref };
}

function driverBusy(driver: CliDriver, sessionId: string): boolean {
  try {
    return driver.activity?.().busySessionIds.includes(sessionId) ?? false;
  } catch (err) {
    console.warn(`driver activity check failed for ${sessionId}: ${(err as Error).message}`);
    return false;
  }
}

function driverLiveTasks(driver: CliDriver, sessionId: string): TaskSnapshot[] {
  try {
    return driver.liveTasks?.(sessionId) ?? [];
  } catch (err) {
    console.warn(`driver live tasks failed for ${sessionId}: ${(err as Error).message}`);
    return [];
  }
}

const SETTLEABLE_STATUSES: ReadonlySet<SessionStatus> = new Set(["holding", "done", "babysit"]);

function autoFinishedTarget(value: AppSettings["prFinishedSessionStatus"]): value is "idle" | "resolved" | "archived" {
  return value !== "none";
}

export class SessionManager {
  private store: SessionStore;
  private settings: SettingsStore;
  private drivers: Record<DriverKind, CliDriver>;
  private driverFactory: DriverFactory;
  private driverGeneration = 0;
  private shutdownReserved = false;
  private driverFailure: string | null = null;
  private interruptedForShutdown = new Set<string>();
  private activeTurns = new Map<string, { sessionId: string; startedAt: number }>();
  private settledTurns = new Map<string, string>();
  private pendingRequests = new PendingRequests();
  private titleTurns = new Map<string, TitleTurn>();
  private firstPrompts = new Map<string, string>();
  private pendingTurns = new Set<string>();
  private pendingResolves = new Map<string, { status: SessionStatus; promise: Promise<SessionCleanupResult> }>();
  private folderChains = new Map<string, Promise<void>>();
  private settleSweep: Promise<string[]> | null = null;
  private idleSweep: Promise<string[]> | null = null;
  private worktreeRecovery = new Map<string, Promise<string>>();
  private branchRenamed = new Set<string>();
  private generatedBranches = new Map<string, string>();
  private worktreeSetups = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private missingTokenWarned = new Set<string>();
  private linkSnapshotCache: { revision: number; byKey: Map<string, PrLinkSnapshot> } | null = null;
  private onEvent: (sessionId: string, event: ThreadEvent) => void;
  private onTitle: (sessionId: string, title: string) => void;
  private onResolved: (sessionId: string) => void;
  private onSession: (session: SessionMeta) => void = () => {};
  private git: GitService;
  private worktreesRoot: string;
  private deltaBuffer = new Map<string, { sessionId: string; text: string; timer: NodeJS.Timeout }>();
  private pendingUndos = new Set<string>();
  private pendingBranchSwitches = new Set<string>();
  private pendingCheckoutRoots = new Set<string>();
  private endSnapshots = new Map<string, Promise<void>>();
  private disposed = false;
  private prHead: (ref: PrRef) => string | null;
  private prHeadRefresh?: (ref: PrRef) => Promise<string | null>;
  private prState: (ref: PrRef) => PrSummary["state"] | null;
  private prStateRefresh?: (ref: PrRef) => Promise<PrSummary["state"] | null>;
  private prUpdatedAt: (ref: PrRef) => number | null;
  private turnPrRefs = new Map<string, PrRef[]>();
  private turnFinalReviews = new Map<string, { ref: PrRef; sha: string }>();
  private usageLedger: UsageLedger;
  private titleGenPath: string;
  private nativeSessions = new Map<string, NativeSession>();
  private remoteSlugs = new Map<string, string | null>();
  private legacyAppRoots: string[];

  constructor(opts: SessionManagerOptions = {}) {
    const dbPath = opts.dbPath ?? sessionDbPath();
    this.store = opts.sessionStore ?? new SessionStore(dbPath);
    const dataDir = opts.dbPath ? dirname(dbPath) : null;
    this.settings = opts.settingsStore ?? new SettingsStore(opts.settingsPath ?? (dataDir ? join(dataDir, "cw-settings.json") : settingsFilePath()));
    this.onEvent = opts.onEvent ?? (() => {});
    this.onTitle = opts.onTitle ?? (() => {});
    this.onResolved = opts.onResolved ?? (() => {});
    this.git = opts.gitService ?? new GitService(() => this.settings.get());
    this.worktreesRoot = opts.worktreesRoot ?? worktreesDir();
    const prHead = opts.prHead ?? (() => null);
    const prState = opts.prState ?? (() => null);
    const prUpdatedAt = opts.prUpdatedAt ?? (() => null);
    const stored = (ref: PrRef): PrLinkSnapshot | undefined => this.linkSnapshot(ref, prUpdatedAt(ref));
    this.prHead = (ref) => stored(ref)?.headRefOid || prHead(ref);
    this.prHeadRefresh = opts.prHeadRefresh;
    this.prState = (ref) => stored(ref)?.state ?? prState(ref);
    this.prStateRefresh = opts.prStateRefresh;
    this.prUpdatedAt = (ref) => stored(ref)?.updatedAt || prUpdatedAt(ref);
    this.usageLedger = opts.usageLedger ?? new UsageLedger(dataDir ? join(dataDir, "usage") : usageDir());
    this.titleGenPath = dataDir ? join(dataDir, "title-gen") : titleGenDir();
    this.legacyAppRoots = opts.legacyAppRoots ?? [];
    this.driverFactory = opts.driverFactory ?? defaultDriverFactory(opts.drivers);
    this.drivers = this.buildDrivers();
  }

  private buildDrivers(): Record<DriverKind, CliDriver> {
    this.driverGeneration += 1;
    const generation = this.driverGeneration;
    const route = (event: ThreadEvent): void => {
      if (generation === this.driverGeneration) this.routeEvent(event);
    };
    return this.driverFactory(
      route,
      () => this.settings.get(),
      (sessionId) => {
        const status = this.store.getSession(sessionId)?.status;
        return status !== undefined && isWorkingSetStatus(status);
      }
    );
  }

  private uniqueDrivers(): Array<{ kinds: DriverKind[]; driver: CliDriver }> {
    const byInstance = new Map<CliDriver, DriverKind[]>();
    for (const kind of DRIVER_KINDS) {
      const driver = this.drivers[kind];
      byInstance.set(driver, [...(byInstance.get(driver) ?? []), kind]);
    }
    return [...byInstance].map(([driver, kinds]) => ({ driver, kinds }));
  }

  private routeEvent(event: ThreadEvent): void {
    if (this.titleTurns.has(event.turnId)) {
      this.handleTitleTurnEvent(event);
      return;
    }
    if (event.type === "assistant.delta") {
      this.bufferDelta(
        event.turnId,
        this.activeTurns.get(event.turnId)?.sessionId ?? this.settledTurns.get(event.turnId) ?? "",
        event.text
      );
      return;
    }
    if (event.type === "turn.done") {
      const countUsageTurn = !this.settledTurns.has(event.turnId);
      this.flushDelta(event.turnId);
      this.handleDriverEvent(event.sessionId, event, countUsageTurn);
      return;
    }
    this.flushDelta(event.turnId);
    if (event.type === "task.updated") {
      if (this.store.getSession(event.sessionId)) this.handleDriverEvent(event.sessionId, event);
      return;
    }
    const sessionId = this.activeTurns.get(event.turnId)?.sessionId ?? this.settledTurns.get(event.turnId) ?? "";
    this.handleDriverEvent(sessionId, event);
  }

  private settleTurn(turnId: string, sessionId: string): void {
    this.activeTurns.delete(turnId);
    for (const [settledTurnId, owner] of this.settledTurns) {
      if (owner === sessionId) this.settledTurns.delete(settledTurnId);
    }
    this.settledTurns.set(turnId, sessionId);
  }

  private handleTitleTurnEvent(event: ThreadEvent): void {
    const turn = this.titleTurns.get(event.turnId);
    if (!turn) return;
    if (event.type === "assistant.delta") {
      if (!turn.settled) turn.text += event.text;
      return;
    }
    if (event.type === "turn.done") {
      if (!turn.settled) {
        if (event.isError) turn.text = "";
        else if (!turn.text.trim()) turn.text = event.resultText;
      }
      this.finishTitleTurn(event.turnId);
      return;
    }
    if (event.type === "turn.error") {
      turn.text = "";
      this.finishTitleTurn(event.turnId);
      return;
    }
    if (event.type === "approval.request") {
      void turn.driver.respondToApproval?.(event.request.requestId, "decline").catch(() => {});
      return;
    }
    if (event.type === "question.request") {
      void turn.driver.respondToQuestion?.(event.request.requestId, {}).catch(() => {});
    }
  }

  private finishTitleTurn(turnId: string): void {
    const turn = this.titleTurns.get(turnId);
    if (!turn || turn.settled) return;
    turn.settled = true;
    this.titleTurns.delete(turnId);
    clearTimeout(turn.timer);
    const { title, branch } = parseGeneratedMetadata(turn.text, turn.expectBranch);
    if (branch) this.generatedBranches.set(turn.sessionId, branch);
    if (!title || !turn.applyTitle) {
      turn.resolve(null);
      return;
    }
    const session = this.store.getSession(turn.sessionId);
    if (!session || session.title !== turn.placeholder || session.title === title) {
      turn.resolve(null);
      return;
    }
    this.store.updateSession(turn.sessionId, { title });
    this.onTitle(turn.sessionId, title);
    turn.resolve(title);
  }

  private bufferDelta(turnId: string, sessionId: string, text: string): void {
    if (!text) return;
    const pending = this.deltaBuffer.get(turnId);
    if (pending) {
      pending.text += text;
      if (pending.sessionId === "" && sessionId !== "") pending.sessionId = sessionId;
      return;
    }
    const timer = setTimeout(() => this.flushDelta(turnId), DELTA_FLUSH_MS);
    timer.unref?.();
    this.deltaBuffer.set(turnId, { sessionId, text, timer });
  }

  private flushDelta(turnId: string): void {
    const pending = this.deltaBuffer.get(turnId);
    if (!pending) return;
    this.deltaBuffer.delete(turnId);
    clearTimeout(pending.timer);
    if (!pending.text) return;
    this.handleDriverEvent(pending.sessionId, { type: "assistant.delta", turnId, text: pending.text });
  }

  setEmitter(onEvent: (sessionId: string, event: ThreadEvent) => void): void {
    this.onEvent = onEvent;
  }

  setTitleEmitter(onTitle: (sessionId: string, title: string) => void): void {
    this.onTitle = onTitle;
  }

  setSessionEmitter(onSession: (session: SessionMeta) => void): void {
    this.onSession = onSession;
  }

  private emitSession(sessionId: string): SessionMeta {
    const updated = this.store.getSession(sessionId);
    if (!updated) throw new Error(`unknown session ${sessionId}`);
    this.onSession(updated);
    return updated;
  }

  getSettings(): AppSettings {
    return this.settings.get();
  }

  setSettings(patch: SettingsPatch): AppSettings {
    const next = this.settings.set(patch);
    if (patch.prWorkflows) {
      for (const session of this.store.listAllSessions()) {
        if (this.endStaleBabysit(session.id)) this.emitSession(session.id);
      }
    }
    return next;
  }

  private linkSnapshot(ref: PrRef, liveUpdatedAt: number | null): PrLinkSnapshot | undefined {
    if (this.linkSnapshotCache?.revision !== this.store.revision) {
      this.linkSnapshotCache = { revision: this.store.revision, byKey: latestLinkSnapshots(this.store.listAllSessions()) };
    }
    const stored = this.linkSnapshotCache.byKey.get(prKey(ref));
    if (!stored || (liveUpdatedAt !== null && liveUpdatedAt > stored.updatedAt)) return undefined;
    return stored;
  }

  applyPrSnapshots(snapshots: Map<string, PrLinkSnapshot>): string[] {
    const changed: string[] = [];
    for (const session of this.store.listAllSessions()) {
      if (session.status === "resolved" || session.status === "archived") continue;
      const prs = applyLinkSnapshots(session.prs, snapshots);
      if (!prs) continue;
      this.store.replacePrLinksQuietly(session.id, prs);
      changed.push(session.id);
    }
    for (const sessionId of changed) {
      this.endStaleBabysit(sessionId);
      this.emitSession(sessionId);
    }
    return changed;
  }

  trackedPrRefs(): Array<{ ref: PrRef; snapshot?: PrLinkSnapshot }> {
    return collectTrackedPrRefs(this.store.listAllSessions());
  }

  private babysits(session: SessionMeta): boolean {
    return babysitsOpenPr(session.prs, this.settings.get().prWorkflows, (ref) => isFinishedPrState(this.prState(ref)));
  }

  private turnEndStatus(sessionId: string): SessionStatus {
    const session = this.store.getSession(sessionId);
    return session && this.babysits(session) ? "babysit" : "done";
  }

  private endStaleBabysit(sessionId: string): boolean {
    const session = this.store.getSession(sessionId);
    if (session?.status !== "babysit" || this.babysits(session)) return false;
    this.store.updateSession(sessionId, { status: "holding" }, "babysit-ended");
    return true;
  }

  private handleDriverEvent(sessionId: string, event: ThreadEvent, countUsageTurn = true): void {
    if (event.type === "turn.done") {
      this.recordUsage(event, countUsageTurn);
      const backgroundTasks = event.backgroundTasks ?? 0;
      if (backgroundTasks > 0) {
        this.store.updateSession(
          event.sessionId,
          {
            resumeCursor: event.resumeCursor,
            status: "working"
          },
          "turn-done-background"
        );
      } else {
        const wasActive = this.activeTurns.has(event.turnId);
        const turnStartedAt = this.activeTurns.get(event.turnId)?.startedAt;
        this.settleTurn(event.turnId, event.sessionId);
        this.dropPendingRequests(this.pendingRequests.clearTurn(event.turnId));
        const stillActive = [...this.activeTurns.values()].some((entry) => entry.sessionId === event.sessionId);
        if (stillActive) {
          this.store.updateSession(event.sessionId, { resumeCursor: event.resumeCursor });
        } else {
          this.store.updateSession(event.sessionId, { resumeCursor: event.resumeCursor, status: this.turnEndStatus(event.sessionId) }, "turn-done");
        }
        this.captureEndSnapshot(event.sessionId, event.turnId);
        if (wasActive && !event.isError) void this.renameBranchForTitle(event.sessionId, event.turnId);
        const covered = this.turnPrRefs.get(event.turnId) ?? [];
        const finalReview = event.isError ? undefined : this.turnFinalReviews.get(event.turnId);
        this.turnPrRefs.delete(event.turnId);
        this.turnFinalReviews.delete(event.turnId);
        this.syncPrSeenAfterTurn(event.sessionId, covered, turnStartedAt, finalReview);
      }
    }
    if (event.type === "turn.error") {
      if (sessionId) this.settleTurn(event.turnId, sessionId);
      else this.activeTurns.delete(event.turnId);
      this.dropPendingRequests(this.pendingRequests.clearTurn(event.turnId));
      this.turnPrRefs.delete(event.turnId);
      this.turnFinalReviews.delete(event.turnId);
      if (sessionId) {
        this.captureEndSnapshot(sessionId, event.turnId);
        this.store.updateSession(
          sessionId,
          {
            status: "holding",
            ...(event.resumeCursor ? { resumeCursor: event.resumeCursor } : {})
          },
          "turn-error"
        );
      }
    }
    if (event.type === "approval.request" || event.type === "question.request") {
      if (sessionId) {
        this.pendingRequests.add(
          event.type === "approval.request"
            ? { kind: "approval", sessionId, turnId: event.turnId, request: event.request }
            : { kind: "question", sessionId, turnId: event.turnId, request: event.request }
        );
        this.store.updateSession(sessionId, { status: "input-required" }, "approval-pending");
      }
    }
    if (event.type === "approval.resolved" || event.type === "question.resolved") {
      this.pendingRequests.resolve(event.requestId);
      if (sessionId && this.activeTurns.has(event.turnId)) {
        this.store.updateSession(sessionId, { status: "working" }, "approval-resolved");
      }
    }
    if (event.type === "permission.mode.reported") {
      if (sessionId) {
        this.store.updateSession(sessionId, { effectivePermissionMode: event.mode ?? undefined });
        if (this.store.getSession(sessionId)) this.emitSession(sessionId);
      }
    }
    this.onEvent(sessionId, event);
  }

  private recordUsage(event: Extract<ThreadEvent, { type: "turn.done" }>, countTurn = true): void {
    if (event.usage.length === 0) return;
    const session = this.store.getSession(event.sessionId);
    if (!session) return;
    try {
      this.usageLedger.record({
        turnId: event.turnId,
        sessionId: event.sessionId,
        projectId: session.projectId,
        driver: session.driver,
        at: new Date(),
        usage: event.usage,
        countTurn
      });
    } catch (err) {
      console.warn(`usage ledger record failed for session ${event.sessionId}: ${(err as Error).message}`);
    }
  }

  queryUsageLedger(query: UsageLedgerQuery): UsageLedgerRow[] {
    return this.usageLedger.query(query);
  }

  driversForProbe(): Record<DriverKind, CliDriver> {
    this.assertNotReserved();
    return this.drivers;
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  addProject(rootPath: string): Project {
    return this.store.addProject(rootPath);
  }

  getProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    return project;
  }

  projectForSession(sessionId: string): Project {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return this.getProject(session.projectId);
  }

  setProjectGitHubAccount(projectId: string, account: { host: string; login: string } | null): Project {
    const project = this.store.updateProject(projectId, { githubAccount: account ?? undefined }, account === null);
    void this.refreshGitHubToken(project);
    return project;
  }

  updateProjectSettings(projectId: string, settings: ProjectSettings): Project {
    return this.store.updateProjectSettings(projectId, settings);
  }

  async listSessions(projectId: string): Promise<SessionMeta[]> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    return this.store.listSessions(projectId);
  }

  listAllSessions(): SessionMeta[] {
    return this.store.listAllSessions();
  }

  async createSession(projectId: string, driver: DriverKind, options: CreateSessionOptions = {}): Promise<SessionMeta> {
    this.assertNotReserved();
    if (options.baseFallback !== undefined && options.baseFallback !== "default") {
      throw new Error("invalid base fallback");
    }
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const id = `sess_${randomUUID().slice(0, 8)}`;
    const mode = options.mode ?? (options.useWorktree === false ? "current" : "new");
    const repository = await this.git.isRepository(project.rootPath);
    this.assertNotReserved();
    if (!repository) {
      return this.store.createSession(projectId, driver, "New session", { id });
    }
    if (mode === "current") {
      return this.createCurrentCheckoutSession(project, driver, id, options);
    }
    if (mode === "previous" && options.reuseWorktreePath) {
      const reused = await this.reusableWorktree(project, options.reuseWorktreePath);
      this.assertNotReserved();
      if (reused) {
        return this.store.createSession(projectId, driver, "New session", {
          id,
          worktreePath: reused.path,
          branch: reused.branch
        });
      }
    }
    const worktree = await this.createSessionWorktree(project, id, options);
    const session = this.store.createSession(projectId, driver, "New session", {
      id,
      worktreePath: worktree.path,
      branch: worktree.branch,
      ...storableBaseRef(worktree.baseRef, worktree.branch, options)
    });
    this.startWorktreeSetup(session, project, worktree.path);
    return withCreateNotice(session, worktree.baseWarning);
  }

  private pendingImportClaims(): PendingClaim[] {
    const turnStarts = new Map<string, number>();
    for (const { sessionId, startedAt } of this.activeTurns.values()) {
      turnStarts.set(sessionId, Math.min(turnStarts.get(sessionId) ?? startedAt, startedAt));
    }
    const claims: PendingClaim[] = [];
    for (const session of this.store.listAllSessions()) {
      const root = this.sessionRoot(session);
      if (!root) continue;
      const ranWithoutCursor =
        !session.resumeCursor &&
        (session.lastTurnSnapshot !== undefined || session.title.trim().toLowerCase() !== NEW_SESSION_TITLE.toLowerCase());
      const since =
        turnStarts.get(session.id) ??
        (this.pendingTurns.has(session.id) ? Date.now() : undefined) ??
        (ranWithoutCursor ? (session.lastTurnSnapshot?.capturedAt ?? session.createdAt) : undefined);
      if (since !== undefined) claims.push({ driver: session.driver, root, since });
    }
    return claims;
  }

  private importContext(): ImportContext {
    return {
      claimed: claimedSessionKeys(this.store.listAllSessions()),
      pending: this.pendingImportClaims(),
      projects: this.store.listProjects(),
      appRoots: [cwCodeHome(), this.worktreesRoot, this.titleGenPath, ...this.legacyAppRoots]
    };
  }

  async listImportableSessions(driver: DriverKind): Promise<ImportableSession[]> {
    this.assertNotReserved();
    const target = this.drivers[driver];
    if (!target.listNativeSessions) throw new Error(`${driver} does not expose its session list`);
    const native = await target.listNativeSessions();
    for (const session of native) this.nativeSessions.set(nativeSessionKey(session.driver, session.resumeCursor), session);
    const visible = importableSessions(native, this.importContext());
    await this.lookupRemotes(visible.filter((session) => !session.repository).map((session) => session.cwd));
    return withRepositories(visible, this.remoteSlugs);
  }

  private async lookupRemotes(cwds: string[]): Promise<void> {
    const pending = [...new Set(cwds.map(comparableRoot))].filter((key) => !this.remoteSlugs.has(key));
    const byKey = new Map(cwds.map((cwd) => [comparableRoot(cwd), cwd]));
    await mapLimit(pending, 8, async (key) => {
      const cwd = byKey.get(key) ?? key;
      if (!existsSync(cwd)) {
        this.remoteSlugs.set(key, null);
        return;
      }
      try {
        this.remoteSlugs.set(key, (await this.git.githubRemote(cwd))?.slug ?? null);
      } catch (err) {
        console.warn(`git remote lookup failed for ${cwd}: ${(err as Error).message}`);
        this.remoteSlugs.set(key, null);
      }
    });
  }

  async importSession(request: ImportSessionRequest): Promise<ImportSessionResult> {
    this.assertNotReserved();
    const key = nativeSessionKey(request.driver, request.resumeCursor);
    if (!this.nativeSessions.has(key)) await this.listImportableSessions(request.driver);
    const native = this.nativeSessions.get(key);
    if (!native) throw new Error(`The ${request.driver} session ${request.resumeCursor} was not found`);
    const [importable] = importableSessions([native], this.importContext());
    if (!importable) throw new Error(`The ${request.driver} session ${request.resumeCursor} is already managed by cw-code`);
    if (!existsSync(native.cwd)) throw new Error(`The folder of this session no longer exists: ${native.cwd}`);
    const project = projectForCwd(this.store.listProjects(), native.cwd) ?? this.store.addProject(native.cwd);
    const session = this.store.createSession(project.id, native.driver, native.title, { resumeCursor: native.resumeCursor });
    return { project, session };
  }

  private async createCurrentCheckoutSession(
    project: Project,
    driver: DriverKind,
    id: string,
    options: CreateSessionOptions
  ): Promise<SessionMeta> {
    return this.withFolderLock(project.rootPath, () => this.createCurrentCheckoutSessionLocked(project, driver, id, options));
  }

  private async withFolderLock<T>(root: string, run: () => Promise<T>): Promise<T> {
    const key = comparableRoot(root);
    const previous = this.folderChains.get(key) ?? Promise.resolve();
    const next = previous.then(run);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    this.folderChains.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.folderChains.get(key) === tail) this.folderChains.delete(key);
    }
  }

  private async createCurrentCheckoutSessionLocked(
    project: Project,
    driver: DriverKind,
    id: string,
    options: CreateSessionOptions
  ): Promise<SessionMeta> {
    this.assertNotReserved();
    if (!(await this.git.hasCommits(project.rootPath))) {
      const session = this.store.createSession(project.id, driver, "New session", { id });
      return withCreateNotice(session, `${project.name} has no commits yet; the session runs without its own branch`);
    }
    const plan = options.prHead ? await this.planPrHead(project, options) : null;
    this.assertNotReserved();
    if (plan?.kind === "base" && (await this.isCheckedOutAtRoot(project, plan.branch))) {
      return this.store.createSession(project.id, driver, "New session", { id, branch: plan.branch });
    }
    await this.assertCheckoutReady(project);
    if (plan?.kind === "attach") {
      await this.withPendingCheckout(project, async () => {
        await this.assertCheckoutReady(project);
        await this.git.checkoutBranch(project.rootPath, plan.branch);
        await this.git.initSubmodules(project.rootPath);
      });
      return this.store.createSession(project.id, driver, "New session", { id, branch: plan.branch });
    }
    const { base, ...baseOptions } = await this.requestedBase(project, plan, options);
    this.assertNotReserved();
    const resolved = await this.git.resolveBase(project.rootPath, base, baseOptions);
    this.assertNotReserved();
    const branch = await this.withPendingCheckout(project, async () => {
      await this.assertCheckoutReady(project);
      const created = await this.git.switchToNewBranch(project.rootPath, sessionBranchName(id), resolved.ref);
      await this.git.initSubmodules(project.rootPath);
      return created;
    });
    const session = this.store.createSession(project.id, driver, "New session", { id, branch, ...storableBaseRef(resolved.ref, branch, options) });
    return withCreateNotice(session, resolved.warning);
  }

  private async withPendingCheckout<T>(project: Project, run: () => Promise<T>): Promise<T> {
    this.pendingCheckoutRoots.add(project.rootPath);
    try {
      return await run();
    } finally {
      this.pendingCheckoutRoots.delete(project.rootPath);
    }
  }

  private async isCheckedOutAtRoot(project: Project, branch: string): Promise<boolean> {
    const info = (await this.git.branches(project.rootPath)).find((item) => !item.remote && item.name === branch);
    if (!info?.worktreePath) return false;
    const repositoryRoot = await this.git.repositoryRoot(project.rootPath);
    return sameWorktreePath(info.worktreePath, project.rootPath) || sameWorktreePath(info.worktreePath, repositoryRoot);
  }

  private async assertCheckoutReady(project: Project): Promise<void> {
    const busy = this.busySiblingOnFolder(project);
    if (busy) throw new Error(`${busy.title} is running in ${project.name} — wait for it to finish or use a new worktree`);
    if (await this.git.isWorkingTreeDirty(project.rootPath)) {
      throw new Error(`${project.name} has uncommitted changes — commit or stash them, or use a new worktree`);
    }
  }

  private busySiblingOnFolder(project: Project): SessionMeta | null {
    return (
      this.store.listAllSessions().find((other) => {
        if (other.worktreePath || !pinsWorktree(other)) return false;
        const otherRoot = this.sessionRoot(other);
        if (otherRoot === null || !rootsOverlap(otherRoot, project.rootPath)) return false;
        return (
          this.hasTurnInFlight(other.id) ||
          this.pendingUndos.has(other.id) ||
          this.pendingBranchSwitches.has(other.id) ||
          this.pendingResolves.has(other.id)
        );
      }) ?? null
    );
  }

  private async requestedBase(
    project: Project,
    plan: PrHeadPlan | null,
    options: CreateSessionOptions
  ): Promise<{ base: string | undefined } & ResolveBaseOptions> {
    if (plan?.kind === "base") return { base: plan.branch, exact: true };
    if (plan?.kind === "fetch") return { base: await this.git.fetchPullRequestHead(project.rootPath, plan.number), exact: true };
    return { base: options.baseBranch, exact: false, fallbackToDefault: options.baseFallback === "default", projectName: project.name };
  }

  private async createSessionWorktree(project: Project, id: string, options: CreateSessionOptions): Promise<CreatedWorktree> {
    const plan = options.prHead ? await this.planPrHead(project, options) : null;
    this.assertNotReserved();
    if (plan?.kind === "attach") {
      const target = join(this.worktreesRoot, safeSegment(project.id), safeSegment(id));
      return this.git.attachWorktree(project.rootPath, target, plan.branch);
    }
    const { base, ...baseOptions } = await this.requestedBase(project, plan, options);
    this.assertNotReserved();
    return this.git.createWorktree(project.rootPath, project.id, id, this.worktreesRoot, base, baseOptions);
  }

  private async planPrHead(project: Project, options: CreateSessionOptions): Promise<PrHeadPlan | null> {
    const branches = await this.git.branches(project.rootPath);
    const local = authorLocalBranch(options, branches);
    const tip = local ? await this.localBranchTip(project.rootPath, local.name) : null;
    return prHeadPlan(options, branches, local && tip ? { [local.name]: tip } : {});
  }

  private async localBranchTip(root: string, branch: string): Promise<string | null> {
    const binary = this.settings.get().gitBinaryPath?.trim() || defaultBinary("git");
    try {
      return (await execText(binary, ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], root)).trim() || null;
    } catch (err) {
      console.warn(`could not resolve local branch '${branch}': ${(err as Error).message}`);
      return null;
    }
  }

  private async reusableWorktree(project: Project, requested: string): Promise<CreatedWorktree | null> {
    try {
      const repositoryRoot = await this.git.repositoryRoot(project.rootPath);
      const parent = resolve(join(this.worktreesRoot, safeSegment(project.id)));
      const entry = (await this.git.worktrees(repositoryRoot)).find((wt) => sameWorktreePath(wt.path, requested));
      if (!entry) return null;
      const path = resolve(entry.path);
      if (!existsSync(path)) return null;
      const rel = relative(parent, path);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
      const branch = entry.branch ?? (await this.git.currentBranch(path));
      if (!branch) return null;
      return { path, branch, repositoryRoot, baseRef: branch, baseWarning: null };
    } catch (err) {
      console.warn(`worktree reuse rejected for '${requested}': ${(err as Error).message}`);
      return null;
    }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    this.store.updateSession(sessionId, { title });
    if (session.resumeCursor) {
      await this.drivers[session.driver].renameSession(session.resumeCursor, title);
    }
  }

  setSessionStatus(sessionId: string, status: SessionStatus, reason: SessionStatusReason = "user-set-status"): SessionMeta {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    this.store.updateSession(sessionId, { status }, reason);
    const updated = this.store.getSession(sessionId);
    if (!updated) throw new Error(`unknown session ${sessionId}`);
    return updated;
  }

  syncFromStatus(sessionId: string, status: GitStatus): SessionMeta | null {
    const stored = this.store.getSession(sessionId);
    if (!stored) return null;
    const branch = changedWorktreeBranch(stored, status);
    if (branch) this.store.updateSession(sessionId, { branch });
    const session = this.store.getSession(sessionId) ?? stored;
    const ref = status.pullRequest ? prRefFromUrl(status.pullRequest.url) : null;
    const headSha = ref ? this.prHead(ref) : null;
    const link = linkFromStatus(session, status, Date.now(), headSha);
    if (link) this.store.updateSession(sessionId, { prs: upsertLink(session.prs, link) });
    return branch || link ? this.emitSession(sessionId) : null;
  }

  linkPr(sessionId: string, link: SessionPrLink): SessionMeta {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const prUnlinked = removeUnlinkedKey(session.prUnlinked, prKey(link.ref));
    this.store.updateSession(sessionId, { prs: upsertLink(session.prs, link), prUnlinked });
    this.endStaleBabysit(sessionId);
    return this.emitSession(sessionId);
  }

  unlinkPr(sessionId: string, ref: PrRef): SessionMeta {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const prUnlinked = addUnlinkedKey(session.prUnlinked, prKey(ref));
    this.store.updateSession(sessionId, { prs: removeLink(session.prs, ref), prUnlinked });
    this.endStaleBabysit(sessionId);
    return this.emitSession(sessionId);
  }

  markPrSeen(sessionId: string, ref: PrRef, headSha: string | null, seenAt: number | null): SessionMeta {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const link = findLink(session.prs, ref);
    if (link) this.store.updateSession(sessionId, { prs: upsertLink(session.prs, markSeen(link, headSha, seenAt ?? Date.now())) });
    return this.emitSession(sessionId);
  }

  linkIssue(sessionId: string, link: SessionIssueLink): SessionMeta {
    const session = this.requireSession(sessionId);
    this.store.updateSession(sessionId, { issues: upsertIssueLink(session.issues, link) });
    return this.emitSession(sessionId);
  }

  unlinkIssue(sessionId: string, ref: IssueRef): SessionMeta {
    const session = this.requireSession(sessionId);
    this.store.updateSession(sessionId, { issues: removeIssueLink(session.issues, ref) });
    return this.emitSession(sessionId);
  }

  markIssueSeen(sessionId: string, ref: IssueRef, seenAt: number): SessionMeta {
    const session = this.requireSession(sessionId);
    const link = findIssueLink(session.issues, ref);
    if (link) this.store.updateSession(sessionId, { issues: upsertIssueLink(session.issues, markLinkSeenAt(link, seenAt)) });
    return this.emitSession(sessionId);
  }

  markRunSeen(sessionId: string, ref: RunRef, seenAt: number): SessionMeta {
    const session = this.requireSession(sessionId);
    const link = findRunLink(session.runs, ref);
    if (link) this.store.updateSession(sessionId, { runs: upsertRunLink(session.runs, markLinkSeenAt(link, seenAt)) });
    return this.emitSession(sessionId);
  }

  linkRun(sessionId: string, link: SessionRunLink): SessionMeta {
    const session = this.requireSession(sessionId);
    this.store.updateSession(sessionId, { runs: upsertRunLink(session.runs, link) });
    return this.emitSession(sessionId);
  }

  unlinkRun(sessionId: string, ref: RunRef): SessionMeta {
    const session = this.requireSession(sessionId);
    this.store.updateSession(sessionId, { runs: removeRunLink(session.runs, ref) });
    return this.emitSession(sessionId);
  }

  private requireSession(sessionId: string): SessionMeta {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }

  private syncPrSeenAfterTurn(
    sessionId: string,
    coveredRefs: PrRef[],
    turnStartedAt: number | undefined,
    finalReview: { ref: PrRef; sha: string } | undefined
  ): void {
    const session = this.store.getSession(sessionId);
    const links = session?.prs ?? [];
    if (links.length === 0) return;
    const coveredKeys = new Set(coveredRefs.map((ref) => prKey(ref)));
    const soleLinkCovered = coveredKeys.size === 0 && links.length === 1;
    const workflows = this.settings.get().prWorkflows;
    const targets = links.map((link) => ({
      ref: link.ref,
      covered: soleLinkCovered || coveredKeys.has(prKey(link.ref)),
      ...(turnStartedAt !== undefined && autoFollowUpWorkflow(link, workflows) ? { seenUntil: turnStartedAt } : {})
    }));
    const worktreePath = session?.worktreePath;
    const now = Date.now();
    void (async () => {
      const [heads, worktreeHead] = await Promise.all([
        Promise.all(targets.map((target) => this.turnEndHead(target.ref))),
        worktreePath && targets.some((target) => !target.covered)
          ? this.git.headSha(worktreePath).catch(() => null)
          : Promise.resolve(null)
      ]);
      const current = this.store.getSession(sessionId);
      if (!current?.prs) return;
      const results = targets.map((target, index) => ({ ...target, head: heads[index].head, seenAt: this.prUpdatedAt(target.ref) }));
      const seen = applyTurnSeen(current.prs, results, worktreeHead, now);
      const reviewedIndex = finalReview ? targets.findIndex((target) => prKey(target.ref) === prKey(finalReview.ref)) : -1;
      const reviewedHead = reviewedIndex >= 0 ? heads[reviewedIndex].refreshed : null;
      const prs = finalReview ? applyFinalReview(seen, finalReview, reviewedHead) : seen;
      if (prs === current.prs) return;
      this.store.updateSession(sessionId, { prs });
      this.emitSession(sessionId);
    })();
  }

  private async turnEndHead(ref: PrRef): Promise<{ head: string | null; refreshed: string | null }> {
    if (isFinishedPrState(this.prState(ref))) return { head: this.prHead(ref), refreshed: null };
    const refreshed = (await this.prHeadRefresh?.(ref).catch(() => null)) ?? null;
    return { head: refreshed ?? this.prHead(ref), refreshed };
  }

  expireHoldingSessions(sessionIds: string[]): SessionMeta[] {
    const expired: SessionMeta[] = [];
    for (const sessionId of sessionIds) {
      const updated = this.store.expireHolding(sessionId);
      if (updated) expired.push(updated);
    }
    return expired;
  }

  settleFinishedPrSessions(): Promise<string[]> {
    if (this.settleSweep) return this.settleSweep;
    const sweep = this.runFinishedPrSweep().finally(() => {
      if (this.settleSweep === sweep) this.settleSweep = null;
    });
    this.settleSweep = sweep;
    return sweep;
  }

  resolveExpiredIdleSessions(now = Date.now()): Promise<string[]> {
    if (this.idleSweep) return this.idleSweep;
    const sweep = this.runIdleSweep(now).finally(() => {
      if (this.idleSweep === sweep) this.idleSweep = null;
    });
    this.idleSweep = sweep;
    return sweep;
  }

  private sessionBusy(sessionId: string): boolean {
    if (this.pendingTurns.has(sessionId) || this.pendingResolves.has(sessionId)) return true;
    for (const entry of this.activeTurns.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  private async runFinishedPrSweep(): Promise<string[]> {
    const settled: string[] = [];
    for (const session of this.store.listAllSessions()) {
      if (!SETTLEABLE_STATUSES.has(session.status)) continue;
      if (session.status !== "babysit" && !autoFinishedTarget(this.settings.get().prFinishedSessionStatus)) continue;
      if (!session.prs?.length) continue;
      if (this.sessionBusy(session.id)) continue;
      try {
        const finishedKeys = new Set<string>();
        for (const link of session.prs) {
          const known = this.prState(link.ref);
          if (!isFinishedPrState(known)) {
            const refresh = this.prStateRefresh;
            const refreshed = refresh ? await refresh(link.ref).catch(() => null) : null;
            if (!isFinishedPrState(refreshed ?? known)) break;
          }
          finishedKeys.add(prKey(link.ref));
        }
        const current = this.store.getSession(session.id);
        if (!current || !SETTLEABLE_STATUSES.has(current.status)) continue;
        if (finishedKeys.size !== (current.prs?.length ?? 0)) continue;
        if (!onlyFinishedLinks(current.prs, finishedKeys)) continue;
        if (this.sessionBusy(session.id)) continue;
        const target = this.settings.get().prFinishedSessionStatus;
        if (!autoFinishedTarget(target)) {
          if (current.status !== "babysit") continue;
          this.setSessionStatus(session.id, "holding", "babysit-ended");
        } else if (target === "idle") {
          this.setSessionStatus(session.id, "idle", "pr-finished");
        } else {
          const result = await this.resolveSession(session.id, target, {
            removeWorktree: true,
            forceBranch: false,
            auto: true,
            stillEligible: (candidate) =>
              this.settings.get().prFinishedSessionStatus === target &&
              SETTLEABLE_STATUSES.has(candidate.status) &&
              onlyFinishedLinks(candidate.prs, finishedKeys)
          });
          if (this.store.getSession(session.id)?.status !== target) continue;
          if (result.error) console.warn(`finished-PR cleanup failed for session ${session.id}: ${result.error}`);
        }
        this.emitSession(session.id);
        settled.push(session.id);
      } catch (err) {
        console.warn(`finished-PR sweep failed for session ${session.id}: ${(err as Error).message}`);
      }
    }
    return settled;
  }

  private idleCutoffReached(session: SessionMeta, now: number): boolean {
    if (session.status !== "idle") return false;
    const idleSince = session.idleSince;
    if (idleSince === undefined || !Number.isFinite(idleSince)) return false;
    const days = this.settings.get().idleResolveAfterDays;
    return days > 0 && idleSince <= now - days * 86_400_000;
  }

  private async runIdleSweep(now: number): Promise<string[]> {
    if (this.settings.get().idleResolveAfterDays <= 0) return [];
    const resolved: string[] = [];
    for (const session of this.store.listAllSessions()) {
      if (!this.idleCutoffReached(session, now)) continue;
      if (this.sessionBusy(session.id)) continue;
      const current = this.store.getSession(session.id);
      if (!current || !this.idleCutoffReached(current, now)) continue;
      try {
        const result = await this.resolveSession(session.id, "resolved", {
          removeWorktree: true,
          forceBranch: false,
          reason: "idle-expired",
          auto: true,
          stillEligible: (candidate) => this.idleCutoffReached(candidate, now)
        });
        if (this.store.getSession(session.id)?.status !== "resolved") continue;
        if (result.error) console.warn(`idle-expired cleanup failed for session ${session.id}: ${result.error}`);
        this.emitSession(session.id);
        resolved.push(session.id);
      } catch (err) {
        console.warn(`idle sweep failed for session ${session.id}: ${(err as Error).message}`);
      }
    }
    return resolved;
  }

  async resolveSession(
    sessionId: string,
    status: SessionStatus,
    opts: {
      removeWorktree?: boolean;
      forceBranch?: boolean;
      reason?: SessionStatusReason;
      auto?: boolean;
      stillEligible?: (session: SessionMeta) => boolean;
    } = {}
  ): Promise<SessionCleanupResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const project = this.getProject(session.projectId);
    for (const entry of this.activeTurns.values()) {
      if (entry.sessionId === sessionId) throw new Error("session busy (turn active)");
    }
    if (this.pendingTurns.has(sessionId)) throw new Error("session busy (turn pending)");
    const pending = this.pendingResolves.get(sessionId);
    if (pending) {
      if (pending.status === status) return pending.promise;
      await pending.promise.catch(() => undefined);
      return this.resolveSession(sessionId, status, opts);
    }
    if (this.undoPendingOnRoot(session)) throw new Error("session busy (undo pending)");
    const run = this.runResolve(session, status, project, opts);
    const entry = { status, promise: run };
    this.pendingResolves.set(sessionId, entry);
    try {
      return await run;
    } finally {
      if (this.pendingResolves.get(sessionId) === entry) this.pendingResolves.delete(sessionId);
    }
  }

  private async runResolve(
    session: SessionMeta,
    status: SessionStatus,
    project: Project,
    opts: {
      removeWorktree?: boolean;
      forceBranch?: boolean;
      reason?: SessionStatusReason;
      auto?: boolean;
      stillEligible?: (session: SessionMeta) => boolean;
    }
  ): Promise<SessionCleanupResult> {
    const sessionId = session.id;
    const endingTurn = session.lastTurnSnapshot?.turnId;
    if (endingTurn) await this.endSnapshots.get(endingTurn);
    const recovery = this.worktreeRecovery.get(sessionId);
    if (recovery) {
      await recovery.catch(() => undefined);
      if (this.worktreeRecovery.has(sessionId)) throw new Error("session busy (recovery in progress)");
    }
    const refreshed = this.store.getSession(sessionId);
    const current = refreshed ?? session;
    if (opts.stillEligible && !opts.stillEligible(current)) {
      return { sessionId, status, worktreeOrphaned: false, worktreeRemoved: false, branchDeleted: false };
    }
    return await this.resolveSessionInner(current, status, project, opts);
  }

  private async resolveSessionInner(
    session: SessionMeta,
    status: SessionStatus,
    project: Project,
    opts: {
      removeWorktree?: boolean;
      forceBranch?: boolean;
      reason?: SessionStatusReason;
      auto?: boolean;
      stillEligible?: (session: SessionMeta) => boolean;
    }
  ): Promise<SessionCleanupResult> {
    const sessionId = session.id;
    this.firstPrompts.delete(sessionId);
    this.branchRenamed.delete(sessionId);
    this.cancelTitleTurns(sessionId);
    this.dropPendingRequests(this.pendingRequests.clearSession(sessionId));
    this.store.updateSession(
      sessionId,
      { status, ...(opts.auto ? { autoResolved: true } : {}) },
      opts.reason ?? (status === "archived" ? "archive" : "resolve")
    );
    this.emitSession(sessionId);
    this.onResolved(sessionId);
    this.generatedBranches.delete(sessionId);
    await this.stopWorktreeSetup(sessionId);
    const worktreePath = session.worktreePath;
    try {
      await this.drivers[session.driver].stopSession?.(sessionId);
    } catch (err) {
      return {
        sessionId,
        status,
        ...(worktreePath ? { worktreePath } : {}),
        worktreeOrphaned: worktreePath ? isWorktreeOrphaned(this.store.listAllSessions(), worktreePath, sessionId) : false,
        worktreeRemoved: false,
        branchDeleted: false,
        error: `could not stop ${session.driver} session: ${(err as Error).message}`
      };
    }
    if (!worktreePath) {
      return { sessionId, status, worktreeOrphaned: false, worktreeRemoved: false, branchDeleted: false };
    }
    const worktreeOrphaned = isWorktreeOrphaned(this.store.listAllSessions(), worktreePath, sessionId);
    if (!worktreeOrphaned || !opts.removeWorktree) {
      if (!worktreeOrphaned && (status === "resolved" || status === "archived")) {
        this.store.updateSession(sessionId, { worktreePath: undefined });
      }
      const unmergedCommitCount =
        !opts.removeWorktree && worktreeOrphaned && session.branch
          ? await this.git.unmergedCommitCount(project.rootPath, session.branch)
          : undefined;
      return {
        sessionId,
        status,
        worktreePath,
        worktreeOrphaned,
        worktreeRemoved: false,
        branchDeleted: false,
        ...(unmergedCommitCount !== null && unmergedCommitCount !== undefined && unmergedCommitCount > 0
          ? { unmergedCommitCount }
          : {})
      };
    }
    const destroyScriptError = await this.runDestroyScript(session, project, worktreePath);
    const scriptFailure = destroyScriptError ? { destroyScriptError } : {};
    let removal: RemoveWorktreeResult;
    try {
      removal = await this.git.removeWorktree(project.rootPath, worktreePath, { force: false });
    } catch (err) {
      return {
        sessionId,
        status,
        worktreePath,
        worktreeOrphaned: true,
        worktreeRemoved: false,
        branchDeleted: false,
        error: (err as Error).message,
        ...scriptFailure
      };
    }
    if (!removal.removed) {
      if (!removal.dirtyBlocked) this.store.updateSession(sessionId, { worktreePath: undefined });
      return {
        sessionId,
        status,
        worktreePath,
        worktreeOrphaned: true,
        worktreeRemoved: false,
        ...(removal.dirtyBlocked ? { dirtyBlocked: true } : {}),
        branchDeleted: false,
        ...scriptFailure
      };
    }
    const branchOutcome = session.branch
      ? await this.deleteOrphanBranch(project.rootPath, session.branch, worktreePath, opts.forceBranch === true, session.namedBranch)
      : null;
    const patch: Partial<Pick<SessionMeta, "worktreePath" | "branch">> = { worktreePath: undefined };
    if (session.branch && branchOutcome?.deleted) patch.branch = undefined;
    this.store.updateSession(sessionId, patch);
    return {
      sessionId,
      status,
      worktreePath,
      worktreeOrphaned: true,
      worktreeRemoved: true,
      branchDeleted: branchOutcome?.deleted ?? false,
      ...(branchOutcome?.unmergedCommits ? { unmergedCommits: true } : {}),
      ...scriptFailure
    };
  }

  private cancelTitleTurns(sessionId: string): void {
    for (const [turnId, turn] of [...this.titleTurns]) {
      if (turn.sessionId !== sessionId) continue;
      turn.settled = true;
      this.titleTurns.delete(turnId);
      clearTimeout(turn.timer);
      turn.resolve(null);
      try {
        turn.driver.interrupt(turnId);
      } catch {
      }
    }
  }

  private async deleteOrphanBranch(
    repoRoot: string,
    branch: string,
    removedPath: string,
    force: boolean,
    namedBranch: string | undefined
  ): Promise<BranchOutcome> {
    if (!ownsSessionBranch(branch, namedBranch)) return { deleted: false };
    try {
      const branches = await this.git.branches(repoRoot);
      const info = branches.find((b) => b.name === branch && !b.remote);
      if (!info) return { deleted: false };
      if (info.worktreePath && !sameWorktreePath(info.worktreePath, removedPath)) {
        return { deleted: false };
      }
      const outcome = await this.git.deleteBranch(repoRoot, branch, { force: force || undefined });
      return { deleted: outcome.deleted, ...(outcome.unmergedCommits ? { unmergedCommits: true } : {}) };
    } catch (err) {
      console.warn(`branch cleanup failed for '${branch}': ${(err as Error).message}`);
      return { deleted: false };
    }
  }

  async pruneStaleWorktrees(): Promise<WorktreePruneSummary> {
    const summary: WorktreePruneSummary = { scanned: 0, removed: 0, skipped: 0, failed: 0, errors: [], keptDirty: [], clearedSessionIds: [], destroyScriptErrors: [] };
    if (!existsSync(this.worktreesRoot)) {
      this.clearMissingWorktrees(summary);
      return summary;
    }
    const sessions = this.store.listAllSessions();
    const touchedProjects = new Set<string>();
    for (const projectDir of readdirSync(this.worktreesRoot, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = join(this.worktreesRoot, projectDir.name);
      const project = this.store.getProject(projectDir.name);
      for (const sessionDir of readdirSync(projectPath, { withFileTypes: true })) {
        if (!sessionDir.isDirectory()) continue;
        const dirPath = join(projectPath, sessionDir.name);
        summary.scanned += 1;
        if (sessions.some((s) => pinsWorktree(s) && s.worktreePath && sameWorktreePath(s.worktreePath, dirPath))) continue;
        if (looksLikeWorktree(dirPath)) touchedProjects.add(project?.id ?? projectDir.name);
        await this.removeStaleDir(project, sessionDir.name, dirPath, summary);
      }
      if (!project && existsSync(projectPath)) {
        try {
          if (readdirSync(projectPath).length === 0) rmSync(projectPath, { recursive: true, force: true });
        } catch {
        }
      }
    }
    for (const projectId of touchedProjects) {
      const project = this.store.getProject(projectId);
      if (!project) continue;
      try {
        await this.git.pruneWorktrees(project.rootPath, this.worktreesRoot);
      } catch (err) {
        summary.errors.push(`${project.rootPath}: worktree prune failed: ${(err as Error).message}`);
      }
    }
    this.clearMissingWorktrees(summary);
    return summary;
  }

  private clearMissingWorktrees(summary: WorktreePruneSummary): void {
    for (const session of this.store.listAllSessions()) {
      if (session.worktreePath && !pinsWorktree(session) && !existsSync(session.worktreePath)) {
        this.store.updateSession(session.id, { worktreePath: undefined });
        summary.clearedSessionIds.push(session.id);
      }
    }
  }

  private async removeStaleDir(project: Project | undefined, sessionId: string, dirPath: string, summary: WorktreePruneSummary): Promise<void> {
    if (!looksLikeWorktree(dirPath)) {
      summary.skipped += 1;
      return;
    }
    const repoRoot = project?.rootPath ?? null;
    if (repoRoot && await this.git.worktreeDirty(dirPath)) {
      summary.keptDirty.push(dirPath);
      return;
    }
    const destroyFailure = project
      ? await this.runDestroyScript({ id: sessionId, branch: this.store.getSession(sessionId)?.branch }, project, dirPath)
      : undefined;
    if (destroyFailure) summary.destroyScriptErrors.push(`${dirPath}: ${destroyFailure}`);
    try {
      if (repoRoot) await this.git.removeWorktree(repoRoot, dirPath, { force: true });
      else rmSync(dirPath, { recursive: true, force: true });
    } catch {
      try {
        rmSync(dirPath, { recursive: true, force: true });
      } catch (rmErr) {
        summary.failed += 1;
        summary.errors.push(`${dirPath}: ${(rmErr as Error).message}`);
        return;
      }
    }
    if (existsSync(dirPath)) {
      summary.failed += 1;
      summary.errors.push(`${dirPath}: could not be removed`);
      return;
    }
    summary.removed += 1;
  }

  resumeCursorFor(sessionId: string): string {
    return this.store.getSession(sessionId)?.resumeCursor ?? "";
  }

  async terminalLaunch(sessionId: string, kind: string, cwd: string): Promise<TerminalLaunch | null> {
    const session = this.store.getSession(sessionId);
    if (!session || session.driver !== kind) return null;
    return (await this.drivers[session.driver].terminalLaunch?.(cwd)) ?? null;
  }

  getComposer(sessionId: string): ComposerPrefs {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const model = session.model;
    const permissionMode = session.permissionMode ?? "auto";
    return {
      model,
      effort: session.effort ?? "medium",
      variant: session.variant,
      permissionMode:
        permissionMode === "auto" ||
        permissionMode === "acceptEdits" ||
        permissionMode === "bypassPermissions" ||
        permissionMode === "manual"
          ? permissionMode
          : "manual"
    };
  }

  setComposer(sessionId: string, prefs: ComposerPrefs): ComposerPrefs {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    this.store.updateComposer(sessionId, prefs);
    return this.getComposer(sessionId);
  }

  async getHistory(sessionId: string): Promise<HistoryMessage[]> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error(`unknown project ${session.projectId}`);
    const messages = await this.loadHistory(session, project);
    return overlayLiveTasks(messages, driverLiveTasks(this.drivers[session.driver], sessionId));
  }

  private async loadHistory(session: SessionMeta, project: Project): Promise<HistoryMessage[]> {
    if (!session.resumeCursor) {
      const healed = await this.healMissingCursor(session, project);
      if (!healed) return [];
      return healed;
    }
    let messages: HistoryMessage[];
    try {
      messages = await this.drivers[session.driver].getHistory(await this.ensureWorktree(session.id), session.resumeCursor);
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`history failed for ${session.id}: ${message}`);
      throw new Error(`Could not load history for this session: ${message}. Retry to reconnect.`);
    }
    if (messages.length > 0) return messages;
    return this.verifyEmptyHistory(session, project);
  }

  async getSubagentTools(sessionId: string, agentId: string): Promise<SubagentToolsResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const driver = this.drivers[session.driver];
    if (!driver.getSubagentTools) return { items: [] };
    return driver.getSubagentTools(await this.ensureWorktree(sessionId), session.resumeCursor, agentId);
  }

  private async healMissingCursor(session: SessionMeta, project: Project): Promise<HistoryMessage[] | null> {
    if (session.title.trim().toLowerCase() === NEW_SESSION_TITLE.toLowerCase()) return null;
    if (this.pendingTurns.has(session.id)) return null;
    for (const entry of this.activeTurns.values()) {
      if (entry.sessionId === session.id) return null;
    }
    let cwd: string;
    try {
      cwd = await this.ensureWorktree(session.id);
    } catch (err) {
      console.warn(`history restore failed for ${session.id}: ${(err as Error).message}`);
      return null;
    }
    return this.adoptUnclaimedSession(session, project, cwd, null);
  }

  private async verifyEmptyHistory(session: SessionMeta, project: Project): Promise<HistoryMessage[]> {
    for (const entry of this.activeTurns.values()) {
      if (entry.sessionId === session.id) return [];
    }
    let cwd: string;
    try {
      cwd = await this.ensureWorktree(session.id);
    } catch (err) {
      throw new Error(`Could not load history for this session: ${(err as Error).message}. Retry to reconnect.`);
    }
    let listed: SessionMeta[];
    try {
      listed = await this.drivers[session.driver].listSessions(cwd, project.id);
    } catch (err) {
      throw new Error(`Could not load history for this session: ${(err as Error).message}. Retry to reconnect.`);
    }
    const self = listed.find((s) => s.driver === session.driver && s.resumeCursor === session.resumeCursor);
    if (self) {
      if (self.updatedAt > self.createdAt) {
        throw new Error(
          `History came back empty but the ${session.driver} session ${session.resumeCursor} shows activity. This looks like a transient read, retry to reconnect.`
        );
      }
      return [];
    }
    const healed = await this.adoptUnclaimedSession(session, project, cwd, listed);
    if (healed) return healed;
    throw new Error(
      `The ${session.driver} session ${session.resumeCursor} for this thread was not found. It may have been deleted outside the app, retry to look again or start a new thread.`
    );
  }

  private async adoptUnclaimedSession(
    session: SessionMeta,
    project: Project,
    cwd: string,
    listed: SessionMeta[] | null
  ): Promise<HistoryMessage[] | null> {
    let candidates: SessionMeta[];
    if (listed) {
      candidates = listed;
    } else {
      try {
        candidates = await this.drivers[session.driver].listSessions(cwd, project.id);
      } catch (err) {
        console.warn(`history restore failed for ${session.id}: ${(err as Error).message}`);
        return null;
      }
    }
    const claimed = new Set(
      this.store
        .listAllSessions()
        .filter((s) => s.driver === session.driver && s.resumeCursor)
        .map((s) => `${s.driver}:${s.resumeCursor}`)
    );
    const cursor = pickRestoreCandidate(
      session.title,
      candidates
        .filter((s) => s.driver === session.driver)
        .map((s) => ({
          resumeCursor: s.resumeCursor,
          title: s.title,
          updatedAt: s.updatedAt,
          claimed: claimed.has(`${s.driver}:${s.resumeCursor}`)
        }))
    );
    if (!cursor) return null;
    this.store.updateSession(session.id, { resumeCursor: cursor });
    console.warn(`history restored for ${session.id}: adopted ${session.driver} session ${cursor}`);
    try {
      return await this.drivers[session.driver].getHistory(cwd, cursor);
    } catch (err) {
      console.warn(`history restore failed for ${session.id}: ${(err as Error).message}`);
      return null;
    }
  }

  private sessionEnvVars(
    sessionId: string,
    session: SessionMeta | undefined,
    project: Project | undefined,
    cwd: string,
    withGitHubAccount = false
  ): Record<string, string> {
    return {
      CW_WORKTREE_PATH: cwd,
      CW_PROJECT_ROOT: project?.rootPath ?? cwd,
      CW_SESSION_ID: session?.id ?? sessionId,
      ...(withGitHubAccount ? this.githubAccountVars(session?.id ?? sessionId, project) : {})
    };
  }

  private githubAccountVars(sessionId: string, project: Project | undefined): Record<string, string> {
    const account = project?.githubAccount;
    if (!account) return {};
    const token = defaultGitHubAccounts.cachedToken(account.host, account.login);
    if (!token && !this.missingTokenWarned.has(sessionId)) {
      this.missingTokenWarned.add(sessionId);
      console.warn(`[git] no cached GitHub token for ${account.login}@${account.host}; agent uses gh's active account`);
    }
    return githubAccountEnv(account, token);
  }

  private async refreshGitHubToken(project: Project): Promise<void> {
    const account = project.githubAccount;
    if (!account) return;
    try {
      await defaultGitHubAccounts.token(account.host, account.login);
    } catch (err) {
      console.warn(`[git] could not refresh the GitHub token for ${account.login}@${account.host}: ${(err as Error).message}`);
    }
  }

  async terminalEnv(sessionId: string, cwd: string): Promise<Record<string, string>> {
    const session = this.store.getSession(sessionId);
    const project = session ? this.store.getProject(session.projectId) : undefined;
    if (project) await this.refreshGitHubToken(project);
    return this.turnEnv(sessionId, cwd);
  }

  turnEnv(sessionId: string, cwd: string): Record<string, string> {
    const session = this.store.getSession(sessionId);
    const project = session ? this.store.getProject(session.projectId) : undefined;
    return buildTurnEnv(process.env, this.sessionEnvVars(sessionId, session, project, cwd, true));
  }

  private async captureTurnSnapshot(sessionId: string, cwd: string): Promise<Omit<TurnSnapshot, "turnId"> | null> {
    if (!(await this.git.isRepository(cwd))) return null;
    const capturedAt = Date.now();
    try {
      return { sha: await this.git.snapshotWorkingTree(cwd), capturedAt };
    } catch (err) {
      const error = (err as Error).message || "snapshot failed";
      console.warn(`turn snapshot failed for ${sessionId}: ${error}`);
      return { capturedAt, error };
    }
  }

  private captureEndSnapshot(sessionId: string, turnId: string, settled?: () => Promise<void>): void {
    const snapshot = this.store.getSession(sessionId)?.lastTurnSnapshot;
    if (snapshot?.turnId !== turnId || snapshot.endedAt !== undefined || this.endSnapshots.has(turnId)) return;
    if (!snapshot.sha) {
      this.store.updateSession(sessionId, { lastTurnSnapshot: { ...snapshot, endedAt: Date.now() } });
      return;
    }
    const task = (settled ? settled() : Promise.resolve())
      .then(() => this.writeEndSnapshot(sessionId, turnId))
      .catch((err: Error) => console.warn(`turn end snapshot could not be stored for ${sessionId}: ${err.message}`))
      .finally(() => {
        if (this.endSnapshots.get(turnId) === task) this.endSnapshots.delete(turnId);
      });
    this.endSnapshots.set(turnId, task);
  }

  private async writeEndSnapshot(sessionId: string, turnId: string): Promise<void> {
    const endedAt = Date.now();
    let result: Pick<TurnSnapshot, "endSha" | "endError">;
    try {
      result = { endSha: await this.git.snapshotWorkingTree(this.rootFor(sessionId)) };
    } catch (err) {
      const endError = (err as Error).message || "snapshot failed";
      console.warn(`turn end snapshot failed for ${sessionId}: ${endError}`);
      result = { endError };
    }
    if (this.disposed) return;
    const current = this.store.getSession(sessionId)?.lastTurnSnapshot;
    if (current?.turnId !== turnId) return;
    this.store.updateSession(sessionId, { lastTurnSnapshot: { ...current, ...result, endedAt } });
    this.emitSession(sessionId);
  }

  private async driverSettled(driver: CliDriver, sessionId: string): Promise<void> {
    const deadline = Date.now() + INTERRUPT_SETTLE_TIMEOUT_MS;
    while (!this.disposed && Date.now() < deadline && driverBusy(driver, sessionId)) {
      await delay(Math.min(INTERRUPT_SETTLE_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  private async settledSnapshot(sessionId: string): Promise<{ session: SessionMeta; snapshot: TurnSnapshot | undefined }> {
    const turnId = this.requireSession(sessionId).lastTurnSnapshot?.turnId;
    if (turnId) await this.endSnapshots.get(turnId);
    const session = this.requireSession(sessionId);
    return { session, snapshot: session.lastTurnSnapshot };
  }

  private sessionRoot(session: SessionMeta): string | null {
    return session.worktreePath ?? this.store.getProject(session.projectId)?.rootPath ?? null;
  }

  private sameRootSessions(session: SessionMeta): SessionMeta[] {
    const root = this.sessionRoot(session);
    if (!root) return [session];
    return this.store.listAllSessions().filter((other) => {
      if (other.id === session.id) return true;
      const otherRoot = this.sessionRoot(other);
      return otherRoot !== null && rootsOverlap(otherRoot, root);
    });
  }

  private branchSwitchPendingOnRoot(session: SessionMeta): boolean {
    if (this.sameRootSessions(session).some((other) => this.pendingBranchSwitches.has(other.id))) return true;
    const root = this.sessionRoot(session);
    return root !== null && [...this.pendingCheckoutRoots].some((pending) => rootsOverlap(pending, root));
  }

  private async assertFolderOnSessionBranch(session: SessionMeta, project: Project, cwd: string, acceptedHead: string | undefined): Promise<void> {
    if (session.worktreePath || !session.branch) return;
    const head = await this.git.folderHead(cwd);
    if (!head || head.value === session.branch || head.value === acceptedHead) return;
    const label = head.detached ? "a detached HEAD" : head.value;
    throw new Error(`[cw-branch-mismatch] ${project.name} is on ${label}, not this session's branch ${session.branch}.`);
  }

  private undoPendingOnRoot(session: SessionMeta): boolean {
    return this.sameRootSessions(session).some((other) => this.pendingUndos.has(other.id));
  }

  private undoBlocker(session: SessionMeta, snapshot: TurnSnapshot): string | null {
    if (this.hasTurnInFlight(session.id)) return "Cannot undo while a turn is running";
    if (this.pendingUndos.has(session.id)) return "Undo already in progress";
    if (!snapshot.endSha) {
      if (snapshot.endError) return `The end-of-turn snapshot failed: ${snapshot.endError}`;
      return this.endSnapshots.has(snapshot.turnId) ? "The end-of-turn snapshot is still being captured" : "The turn has no end-of-turn snapshot";
    }
    if (snapshot.undoneAt !== undefined) return "This turn was already undone";
    if (this.branchSwitchPendingOnRoot(session)) return "session busy (branch switch pending)";
    for (const other of this.sameRootSessions(session)) {
      if (this.pendingResolves.has(other.id)) return "session busy (resolve pending)";
      if (this.worktreeRecovery.has(other.id)) return "session busy (recovery in progress)";
      if (other.id === session.id) continue;
      if (this.hasTurnInFlight(other.id)) return `Another session is running a turn in this folder ("${other.title}")`;
      if (this.pendingUndos.has(other.id)) return `Another session is undoing a turn in this folder ("${other.title}")`;
      const otherTurn = other.lastTurnSnapshot;
      if (otherTurn && turnReachesPast(otherTurn, snapshot.capturedAt)) {
        return `A later turn in another session changed this folder ("${other.title}")`;
      }
    }
    return null;
  }

  async turnDiffRange(sessionId: string): Promise<{ base?: string; head?: string }> {
    const { snapshot } = await this.settledSnapshot(sessionId);
    if (!snapshot?.sha) return {};
    return { base: snapshot.sha, ...(snapshot.endSha ? { head: snapshot.endSha } : {}) };
  }

  async turnChanges(sessionId: string): Promise<TurnChanges | null> {
    const { session, snapshot } = await this.settledSnapshot(sessionId);
    if (!snapshot?.sha) return null;
    const root = this.rootFor(sessionId);
    const endSha = snapshot.endSha ?? null;
    const { files, gitlinks } = await this.git.snapshotChanges(root, snapshot.sha, endSha ?? undefined);
    const conflicts = endSha && snapshot.undoneAt === undefined
      ? await this.git.snapshotConflicts(root, snapshot.sha, endSha, files.map((file) => file.path))
      : [];
    const reason = this.undoBlocker(session, snapshot)
      ?? (gitlinks.length > 0 ? gitlinkReason(gitlinks) : null)
      ?? (conflicts.length > 0 ? conflictReason(conflicts) : null)
      ?? (files.length === 0 ? "The turn changed no files" : null);
    return { turnId: snapshot.turnId, files, endSha, undoable: reason === null, ...(reason ? { reason } : {}), conflicts };
  }

  async undoTurn(sessionId: string, turnId: string, expectedEndSha: string): Promise<TurnChanges> {
    const session = this.requireSession(sessionId);
    const snapshot = session.lastTurnSnapshot;
    if (this.hasTurnInFlight(sessionId)) throw new Error("Cannot undo while a turn is running");
    if (!snapshot?.sha) throw new Error("No snapshot for the last turn");
    if (snapshot.turnId !== turnId) throw new Error("Only the latest turn can be undone");
    const blocker = this.undoBlocker(session, snapshot);
    if (blocker) throw new Error(blocker);
    const startSha = snapshot.sha;
    const endSha = snapshot.endSha;
    if (!endSha || endSha !== expectedEndSha) throw new Error("The turn's end snapshot changed since it was reviewed; refresh and try again");
    this.pendingUndos.add(sessionId);
    try {
      const root = this.rootFor(sessionId);
      const { files, gitlinks } = await this.git.snapshotChanges(root, startSha, endSha);
      if (gitlinks.length > 0) throw new Error(gitlinkReason(gitlinks));
      const conflicts = await this.git.snapshotConflicts(root, startSha, endSha, files.map((file) => file.path));
      if (conflicts.length > 0) throw new Error(conflictReason(conflicts));
      const restored = await this.git.restoreSnapshot(root, startSha, files);
      const current = this.store.getSession(sessionId)?.lastTurnSnapshot;
      if (current?.turnId === turnId) {
        this.store.updateSession(sessionId, { lastTurnSnapshot: { ...current, undoneAt: Date.now() } });
        this.emitSession(sessionId);
      }
      return { turnId, files: restored, endSha, undoable: false, reason: "This turn was already undone", conflicts: [] };
    } finally {
      this.pendingUndos.delete(sessionId);
    }
  }

  async switchBranch(sessionId: string, branch: string): Promise<GitStatus> {
    return this.withBranchSwitch(sessionId, async () => {
      const session = this.requireSession(sessionId);
      const project = this.projectForSession(sessionId);
      const root = await this.ensureWorktree(sessionId);
      if (!session.worktreePath && (await this.git.isWorkingTreeDirty(root))) {
        throw new Error(`${project.name} has uncommitted changes — commit or stash them before switching branches`);
      }
      const label = await this.git.checkoutBranch(root, branch);
      const head = await this.git.currentBranch(root);
      if (head !== label) throw new Error(`Switching ${project.name} to '${label}' did not take effect; it is on ${head ?? "a detached HEAD"}`);
      this.updateSessionBranch(sessionId, label);
      return this.git.status(root, project);
    });
  }

  async withBranchSwitch<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const session = this.requireSession(sessionId);
    if (session.worktreePath) return this.runBranchSwitch(sessionId, run);
    return this.withFolderLock(this.rootForProject(session.projectId), () => this.runBranchSwitch(sessionId, run));
  }

  private async runBranchSwitch<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const session = this.requireSession(sessionId);
    if (this.undoPendingOnRoot(session)) throw new Error("session busy (undo pending)");
    if (this.branchSwitchPendingOnRoot(session)) throw new Error("session busy (branch switch pending)");
    const running = this.sameRootSessions(session).find((other) => this.hasTurnInFlight(other.id));
    if (running) {
      const projectName = this.store.getProject(running.projectId)?.name ?? "this folder";
      throw new Error(`${running.title} is running in ${projectName} — wait for it to finish before switching branches`);
    }
    this.pendingBranchSwitches.add(sessionId);
    try {
      return await run();
    } finally {
      this.pendingBranchSwitches.delete(sessionId);
    }
  }

  private hasTurnInFlight(sessionId: string): boolean {
    if (this.pendingTurns.has(sessionId)) return true;
    for (const entry of this.activeTurns.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  async startTurn(
    sessionId: string,
    prompt: string,
    opts?: {
      prefs?: ComposerPrefs;
      attachments?: string[];
      command?: CommandInvocation;
      skills?: string[];
      prRefs?: PrRef[];
      finalReview?: { ref: PrRef; sha: string };
      acceptFolderHead?: string;
    }
  ): Promise<string> {
    this.assertNotReserved();
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.status === "resolved" || session.status === "archived") {
      throw new Error(`session is ${session.status}; reopen it before starting a turn`);
    }
    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error(`unknown project ${session.projectId}`);
    for (const [turnId, entry] of this.activeTurns) {
      if (entry.sessionId === sessionId) throw new Error(`session busy (turn ${turnId})`);
    }
    if (this.pendingTurns.has(sessionId)) throw new Error("session busy (turn pending)");
    if (this.pendingResolves.has(sessionId)) throw new Error("session busy (resolve pending)");
    if (this.undoPendingOnRoot(session)) throw new Error("session busy (undo pending)");
    if (this.branchSwitchPendingOnRoot(session)) throw new Error(`${project.name} is switching branches — try again in a moment`);
    this.pendingTurns.add(sessionId);
    try {
      const cwd = await this.ensureWorktree(sessionId);
      await this.worktreeSetups.get(sessionId)?.promise;
      await this.assertFolderOnSessionBranch(session, project, cwd, opts?.acceptFolderHead);
      const snapshot = await this.captureTurnSnapshot(sessionId, cwd);
      this.assertNotReserved();
      const firstMessage = session.title === NEW_SESSION_TITLE && !opts?.command;
      const placeholder = prompt.slice(0, 60);
      if (firstMessage) {
        this.firstPrompts.set(sessionId, prompt);
        this.store.updateSession(sessionId, { title: placeholder });
        this.onTitle(sessionId, placeholder);
      }
      const stored = this.getComposer(sessionId);
      const prefs = { ...stored, ...(opts?.prefs ?? {}) };
      const driver = this.drivers[session.driver];
      if (session.driver === "claude") await this.refreshGitHubToken(project);
      this.assertNotReserved();
      const handle = driver.startTurn({
        sessionId,
        prompt,
        cwd,
        resumeCursor: session.resumeCursor,
        model: prefs.model,
        effort: prefs.effort,
        variant: prefs.variant,
        permissionMode: prefs.permissionMode,
        attachments: resolveAttachments(project.rootPath, cwd, opts?.attachments ?? []),
        ...(opts?.command ? { command: opts.command } : {}),
        ...(!opts?.command && opts?.skills?.length ? { skills: opts.skills } : {}),
        env: buildTurnEnv(process.env, this.sessionEnvVars(session.id, session, project, cwd, session.driver === "claude"))
      });
      this.activeTurns.set(handle.turnId, { sessionId, startedAt: Date.now() });
      if (opts?.prRefs && opts.prRefs.length > 0) this.turnPrRefs.set(handle.turnId, opts.prRefs);
      if (opts?.finalReview) this.turnFinalReviews.set(handle.turnId, opts.finalReview);
      const lastTurnSnapshot = snapshot ? { turnId: handle.turnId, ...snapshot } : undefined;
      const snapshotChanged = lastTurnSnapshot !== undefined || session.lastTurnSnapshot !== undefined;
      this.store.updateSession(sessionId, { status: "working", lastTurnSnapshot }, "turn-start");
      if (snapshotChanged) this.emitSession(sessionId);
      if (firstMessage) this.maybeAutoTitle(sessionId, prompt, placeholder);
      return handle.turnId;
    } finally {
      this.pendingTurns.delete(sessionId);
    }
  }

  private maybeAutoTitle(sessionId: string, prompt: string, placeholder: string): void {
    if (!prompt.trim()) return;
    const applyTitle = this.settings.get().autoTitleEnabled;
    if (!applyTitle && !this.branchInstructionsFor(sessionId)) return;
    this.launchTitleTurn(sessionId, prompt, placeholder, applyTitle).catch((err: Error) => {
      console.warn(`title generation skipped for ${sessionId}: ${err.message}`);
    });
  }

  private branchInstructionsFor(sessionId: string): string | undefined {
    const session = this.store.getSession(sessionId);
    if (!session?.worktreePath || !session.branch || !TEMP_BRANCH_PATTERN.test(session.branch)) return undefined;
    return sanitizeProjectSettings(this.store.getProject(session.projectId)?.settings).branchInstructions;
  }

  async regenerateTitle(sessionId: string): Promise<string> {
    this.assertNotReserved();
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const source = await this.titleSource(session);
    if (!source.trim()) throw new Error("No session message to generate a title from yet");
    const title = await this.launchTitleTurn(sessionId, source, session.title);
    if (!title) throw new Error("Title generation failed. Check the configured harness and model.");
    return title;
  }

  private async titleSource(session: SessionMeta): Promise<string> {
    if (session.resumeCursor) {
      const history = await this.getHistory(session.id);
      const firstUser = history.find((message) => message.role === "user" && message.text.trim());
      if (firstUser) return firstUser.text;
    }
    const firstPrompt = this.firstPrompts.get(session.id);
    if (firstPrompt) return firstPrompt;
    return session.title === NEW_SESSION_TITLE ? "" : session.title;
  }

  private launchTitleTurn(sessionId: string, prompt: string, placeholder: string, applyTitle = true): Promise<string | null> {
    if (this.shutdownReserved) return Promise.reject(shutdownReservedError());
    for (const pending of this.titleTurns.values()) {
      if (pending.sessionId === sessionId && !pending.settled) return pending.promise;
    }
    const settings = this.settings.get();
    const driver = this.drivers[settings.autoTitleDriver];
    const titleSessionId = `title:${sessionId}`;
    const titleRoot = this.titleGenRoot();
    const projectId = this.store.getSession(sessionId)?.projectId;
    const titleInstructions = sanitizeProjectSettings(projectId ? this.store.getProject(projectId)?.settings : undefined).titleInstructions;
    const branchInstructions = this.branchRenamed.has(sessionId) ? undefined : this.branchInstructionsFor(sessionId);
    let handle: TurnHandle;
    try {
      handle = driver.startTurn({
        sessionId: titleSessionId,
        prompt: buildTitlePrompt(prompt, { title: titleInstructions, branch: branchInstructions }),
        cwd: titleRoot,
        model: settings.autoTitleModel.trim() || undefined,
        effort: settings.autoTitleEffort,
        permissionMode: "auto",
        maxTurns: 1,
        env: buildTurnEnv(process.env, this.sessionEnvVars(titleSessionId, undefined, undefined, titleRoot))
      });
    } catch (err) {
      console.warn(`title generation failed for ${sessionId}: ${(err as Error).message}`);
      return Promise.resolve(null);
    }
    let resolve: (title: string | null) => void = () => {};
    const promise = new Promise<string | null>((settle) => {
      resolve = settle;
    });
    const timer = setTimeout(() => {
      const turn = this.titleTurns.get(handle.turnId);
      if (!turn || turn.settled) return;
      turn.settled = true;
      this.titleTurns.delete(handle.turnId);
      turn.resolve(null);
      driver.interrupt(handle.turnId);
    }, AUTO_TITLE_TIMEOUT_MS);
    timer.unref?.();
    this.titleTurns.set(handle.turnId, {
      sessionId,
      placeholder,
      applyTitle,
      expectBranch: branchInstructions !== undefined,
      text: "",
      settled: false,
      timer,
      driver,
      promise,
      resolve
    });
    return promise;
  }

  private titleGenRoot(): string {
    mkdirSync(this.titleGenPath, { recursive: true });
    return this.titleGenPath;
  }

  warmOpencodeModels(): void {
    if (this.shutdownReserved) {
      console.warn("opencode model warmup skipped: cw-code is preparing to restart");
      return;
    }
    const pending = this.drivers.opencode.listModels?.(this.titleGenRoot());
    void pending?.catch((err) => {
      console.warn(`opencode model warmup failed: ${(err as Error).message}`);
    });
  }

  async listCommands(sessionId: string): Promise<CommandOption[]> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const cwd =
      session.worktreePath && existsSync(session.worktreePath)
        ? session.worktreePath
        : this.rootForProject(session.projectId);
    return this.listCommandsFor(session.projectId, session.driver, cwd);
  }

  async listCommandsFor(projectId: string, driver: DriverKind, cwd?: string): Promise<CommandOption[]> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const driverInstance = this.drivers[driver];
    if (typeof driverInstance.listCommands !== "function") return [];
    this.assertNotReserved();
    return driverInstance.listCommands(cwd ?? project.rootPath);
  }

  async listModels(sessionId: string): Promise<ModelOption[]> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.driver === "claude") return this.listModelsFor(session.projectId, "claude");
    this.assertNotReserved();
    try {
      const cwd =
        session.worktreePath && existsSync(session.worktreePath)
          ? session.worktreePath
          : this.rootForProject(session.projectId);
      return await this.listModelsFor(session.projectId, session.driver, cwd);
    } catch (err) {
      console.warn(`model list failed for ${sessionId}: ${(err as Error).message}`);
      return [];
    }
  }

  async listModelsFor(projectId: string, driver: DriverKind, cwd?: string): Promise<ModelOption[]> {
    if (driver === "claude") {
      return resolveClaudeModels(this.settings.get(), CLAUDE_CURATED_MODELS);
    }
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const driverInstance = this.drivers[driver];
    if (typeof driverInstance.listModels !== "function") return [];
    this.assertNotReserved();
    try {
      return await driverInstance.listModels(cwd ?? project.rootPath);
    } catch (err) {
      console.warn(`model list failed: ${(err as Error).message}`);
    }
    return [];
  }

  async listModelsForHarness(driver: DriverKind): Promise<ModelOption[]> {
    if (driver === "claude") {
      return resolveClaudeModels(this.settings.get(), CLAUDE_CURATED_MODELS);
    }
    const driverInstance = this.drivers[driver];
    if (typeof driverInstance.listModels !== "function") return [];
    this.assertNotReserved();
    try {
      return await driverInstance.listModels(this.titleGenRoot());
    } catch (err) {
      console.warn(`model list failed for ${driver}: ${(err as Error).message}`);
      throw err;
    }
  }

  private fallbackPermissionModes(): PermissionOption[] {
    return withSyntheticFullAccess([
      permissionOption("manual", true),
      permissionOption("acceptEdits", true),
      permissionOption("auto", true),
      permissionOption("bypassPermissions", true)
    ]);
  }

  async listPermissionModes(sessionId: string): Promise<PermissionOption[]> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    this.assertNotReserved();
    try {
      const cwd =
        session.worktreePath && existsSync(session.worktreePath)
          ? session.worktreePath
          : this.rootForProject(session.projectId);
      return await this.listPermissionModesFor(session.projectId, session.driver, cwd);
    } catch (err) {
      console.warn(`permission list failed for ${sessionId}: ${(err as Error).message}`);
      return this.fallbackPermissionModes();
    }
  }

  async listPermissionModesFor(projectId: string, driver: DriverKind, cwd?: string): Promise<PermissionOption[]> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const driverInstance = this.drivers[driver];
    if (typeof driverInstance.listPermissionModes === "function") {
      this.assertNotReserved();
      try {
        return withSyntheticFullAccess(await driverInstance.listPermissionModes(cwd ?? project.rootPath));
      } catch (err) {
        console.warn(`permission list failed: ${(err as Error).message}`);
      }
    }
    return this.fallbackPermissionModes();
  }

  async listPermissionModesForHarness(driver: DriverKind): Promise<PermissionOption[]> {
    const driverInstance = this.drivers[driver];
    if (typeof driverInstance.listPermissionModes === "function") {
      this.assertNotReserved();
      try {
        return withSyntheticFullAccess(await driverInstance.listPermissionModes(this.titleGenRoot()));
      } catch (err) {
        console.warn(`permission list failed for ${driver}: ${(err as Error).message}`);
        throw err;
      }
    }
    return this.fallbackPermissionModes();
  }

  listActiveTurns(): Array<{ sessionId: string; turnId: string; startedAt: number }> {
    return [...this.activeTurns].map(([turnId, entry]) => ({
      sessionId: entry.sessionId,
      turnId,
      startedAt: entry.startedAt
    }));
  }

  interrupt(turnId: string): void {
    const sessionId = this.activeTurns.get(turnId)?.sessionId;
    if (!sessionId) return;
    const session = this.store.getSession(sessionId);
    const driver = session ? this.drivers[session.driver] : undefined;
    driver?.interrupt(turnId);
    this.settleTurn(turnId, sessionId);
    this.dropPendingRequests(this.pendingRequests.clearTurn(turnId));
    this.turnPrRefs.delete(turnId);
    this.turnFinalReviews.delete(turnId);
    this.captureEndSnapshot(sessionId, turnId, driver ? () => this.driverSettled(driver, sessionId) : undefined);
    this.store.updateSession(sessionId, { status: "holding" }, "turn-interrupted");
    if (!session) return;
    if (this.shutdownReserved) this.interruptedForShutdown.add(sessionId);
    this.emitSession(sessionId);
  }

  async retryConnection(sessionId: string): Promise<RetryConnectionResult> {
    this.assertNotReserved();
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    for (const entry of this.activeTurns.values()) {
      if (entry.sessionId === sessionId) throw new Error("session busy (turn in progress)");
    }
    const driver = this.drivers[session.driver];
    if (typeof driver.retryConnection !== "function") {
      return { status: "done", history: await this.getHistory(sessionId) };
    }
    const cwd = await this.ensureWorktree(sessionId);
    this.assertNotReserved();
    const result = await driver.retryConnection({
      sessionId,
      cwd,
      resumeCursor: session.resumeCursor,
      permissionMode: this.getComposer(sessionId).permissionMode
    });
    if (result.status === "running" && result.turnId) {
      this.activeTurns.set(result.turnId, { sessionId, startedAt: Date.now() });
      this.store.updateSession(sessionId, { status: "working" }, "retry-connected");
    } else {
      this.store.updateSession(sessionId, { status: "idle" }, "retry-idle");
    }
    return { ...result, history: overlayLiveTasks(result.history, driverLiveTasks(driver, sessionId)) };
  }

  listPendingRequests(sessionId: string): PendingRequest[] {
    return this.pendingRequests.list(sessionId);
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    await this.answerPendingRequest(requestId, "approval", async (driver) => {
      if (typeof driver.respondToApproval !== "function") throw new Error(`${driver.kind} cannot answer approvals`);
      await driver.respondToApproval(requestId, decision);
    });
  }

  async respondQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    await this.answerPendingRequest(requestId, "question", async (driver) => {
      if (typeof driver.respondToQuestion !== "function") throw new Error(`${driver.kind} cannot answer questions`);
      await driver.respondToQuestion(requestId, answers);
    });
  }

  private async answerPendingRequest(
    requestId: string,
    kind: PendingRequest["kind"],
    answer: (driver: CliDriver) => Promise<void>
  ): Promise<void> {
    const entry = this.pendingRequests.claim(requestId, kind);
    try {
      const session = this.store.getSession(entry.sessionId);
      if (!session) throw new Error(`unknown session ${entry.sessionId}`);
      await answer(this.drivers[session.driver]);
    } catch (err) {
      this.pendingRequests.release(requestId);
      throw err;
    }
  }

  private dropPendingRequests(entries: PendingRequest[]): void {
    for (const entry of entries) {
      const requestId = entry.request.requestId;
      this.onEvent(
        entry.sessionId,
        entry.kind === "approval"
          ? { type: "approval.resolved", turnId: entry.turnId, requestId }
          : { type: "question.resolved", turnId: entry.turnId, requestId, answers: null }
      );
    }
  }

  rootFor(sessionId: string): string {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.worktreePath) {
      if (!existsSync(session.worktreePath)) throw new Error(`session worktree is missing: ${session.worktreePath}`);
      return session.worktreePath;
    }
    return this.rootForProject(session.projectId);
  }

  async sessionStatusContext(sessionId: string): Promise<{ root: string; project: Project; baseRef?: string }> {
    const root = await this.ensureWorktree(sessionId);
    const session = this.requireSession(sessionId);
    const project = this.getProject(session.projectId);
    return { root, project, ...(session.baseRef ? { baseRef: session.baseRef } : {}) };
  }

  async ensureWorktree(sessionId: string): Promise<string> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.worktreePath && existsSync(session.worktreePath)) return session.worktreePath;
    if (!session.worktreePath) return this.rootForProject(session.projectId);
    if (session.status === "resolved" || session.status === "archived") {
      throw new Error(`session is ${session.status}; its worktree was removed`);
    }
    const pending = this.worktreeRecovery.get(sessionId);
    if (pending) return pending;
    this.assertNotReserved();
    const recovery = this.recoverWorktree(sessionId, session).finally(() => {
      this.worktreeRecovery.delete(sessionId);
    });
    this.worktreeRecovery.set(sessionId, recovery);
    return recovery;
  }

  private async recoverWorktree(sessionId: string, session: SessionMeta): Promise<string> {
    const project = this.getProject(session.projectId);
    const expectedPath = join(this.worktreesRoot, session.projectId, sessionId);
    try {
      await this.git.pruneWorktrees(project.rootPath, this.worktreesRoot);
    } catch (err) {
      throw new Error(`could not prune worktrees for session ${sessionId} before recovery: ${(err as Error).message}`);
    }
    this.assertNotReserved();
    const branchExists = session.branch ? await this.branchExists(project.rootPath, session.branch) : false;
    this.assertNotReserved();
    if (session.branch && branchExists) {
      try {
        const attached = await this.git.attachWorktree(project.rootPath, expectedPath, session.branch);
        this.startWorktreeSetup(session, project, attached.path);
        return attached.path;
      } catch (err) {
        console.warn(`worktree attach failed for ${sessionId}: ${(err as Error).message}`);
      }
      this.assertNotReserved();
    }
    let worktree: CreatedWorktree;
    try {
      worktree = await this.git.createWorktree(
        project.rootPath,
        project.id,
        sessionId,
        this.worktreesRoot,
        session.branch,
        { exact: true }
      );
    } catch (err) {
      throw new Error(
        `could not recreate worktree for session ${sessionId} at ${expectedPath} from branch '${session.branch ?? "HEAD"}': ${(err as Error).message}`
      );
    }
    if (worktree.branch !== session.branch) this.updateSessionBranch(sessionId, worktree.branch);
    this.startWorktreeSetup(session, project, worktree.path);
    return worktree.path;
  }

  private worktreeScriptEnv(sessionId: string, project: Project, worktreePath: string, branch: string | undefined): Record<string, string> {
    const session = this.store.getSession(sessionId);
    return buildTurnEnv(process.env, {
      ...this.sessionEnvVars(sessionId, session, project, worktreePath),
      ...(branch ? { CW_BRANCH: branch } : {})
    });
  }

  private emitNotice(sessionId: string, noticeId: string, text: string, severity: "info" | "warning" | "error"): void {
    this.onEvent(sessionId, { type: "session.notice", turnId: noticeId, sessionId, noticeId, text, severity });
  }

  private startWorktreeSetup(session: SessionMeta, project: Project, worktreePath: string): void {
    const script = sanitizeProjectSettings(project.settings).setupScript;
    if (!script) return;
    const sessionId = session.id;
    this.worktreeSetups.get(sessionId)?.controller.abort();
    const controller = new AbortController();
    const noticeId = `setup:${sessionId}:${Date.now()}`;
    this.emitNotice(sessionId, noticeId, `${scriptLabel("setup")} running…`, "info");
    const promise = runWorktreeScript({
      script,
      cwd: worktreePath,
      env: this.worktreeScriptEnv(sessionId, project, worktreePath, this.store.getSession(sessionId)?.branch ?? session.branch),
      signal: controller.signal
    })
      .then((result) => {
        const text = describeScriptResult("setup", result);
        if (!result.ok) console.warn(`[worktree] session ${sessionId}: ${text}`);
        this.emitNotice(sessionId, noticeId, text, result.ok ? "info" : "error");
      })
      .catch((err: Error) => console.warn(`[worktree] setup script bookkeeping failed for ${sessionId}: ${err.message}`))
      .finally(() => {
        if (this.worktreeSetups.get(sessionId)?.promise === promise) this.worktreeSetups.delete(sessionId);
      });
    this.worktreeSetups.set(sessionId, { promise, controller });
  }

  private async stopWorktreeSetup(sessionId: string): Promise<void> {
    const setup = this.worktreeSetups.get(sessionId);
    if (!setup) return;
    setup.controller.abort();
    await setup.promise;
  }

  private async runDestroyScript(session: Pick<SessionMeta, "id" | "branch">, project: Project, worktreePath: string): Promise<string | undefined> {
    const script = sanitizeProjectSettings(project.settings).destroyScript;
    if (!script || !existsSync(worktreePath)) return undefined;
    if (await this.git.worktreeDirty(worktreePath).catch(() => false)) return undefined;
    const result = await runWorktreeScript({
      script,
      cwd: worktreePath,
      env: this.worktreeScriptEnv(session.id, project, worktreePath, session.branch)
    });
    if (result.ok) return undefined;
    const text = describeScriptResult("destroy", result);
    console.warn(`[worktree] session ${session.id}: ${text}`);
    return text;
  }

  private async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    try {
      const branches = await this.git.branches(repoRoot);
      return branches.some((b) => b.name === branch && !b.remote);
    } catch (err) {
      console.warn(`branch lookup failed for '${branch}': ${(err as Error).message}`);
      return false;
    }
  }

  updateSessionBranch(sessionId: string, branch: string): void {
    if (!this.store.getSession(sessionId)) throw new Error(`unknown session ${sessionId}`);
    this.store.updateSession(sessionId, { branch });
    this.emitSession(sessionId);
  }

  private branchShared(sessionId: string, worktreePath: string, branch: string): boolean {
    return this.store.listAllSessions().some(
      (other) =>
        other.id !== sessionId &&
        pinsWorktree(other) &&
        ((other.worktreePath && sameWorktreePath(other.worktreePath, worktreePath)) || other.branch === branch)
    );
  }

  private async renameBranchForTitle(sessionId: string, turnId: string): Promise<void> {
    if (this.branchRenamed.has(sessionId)) return;
    const pendingTitle = [...this.titleTurns.values()].find((turn) => turn.sessionId === sessionId && turn.expectBranch && !turn.settled);
    if (pendingTitle) await pendingTitle.promise;
    if (this.branchRenamed.has(sessionId)) return;
    const session = this.store.getSession(sessionId);
    if (!session?.worktreePath || !session.branch) return;
    const { worktreePath, branch } = session;
    const temporary = TEMP_BRANCH_PATTERN.test(branch);
    const title = session.title.trim();
    if (!temporary || !title || title === "New session") return;
    const generated = this.generatedBranches.get(sessionId);
    const candidate = generated ?? branchNameForTitle(title);
    if (!candidate || candidate === branch) return;
    if (this.branchShared(sessionId, worktreePath, branch)) return;
    this.branchRenamed.add(sessionId);
    try {
      const project = this.getProject(session.projectId);
      const published = await this.git.branchPublished(project.rootPath, branch);
      const current = this.store.getSession(sessionId);
      const unchanged =
        current !== undefined &&
        current.status !== "resolved" &&
        current.status !== "archived" &&
        current.branch === branch &&
        current.worktreePath !== undefined &&
        sameWorktreePath(current.worktreePath, worktreePath);
      const shared = unchanged && this.branchShared(sessionId, worktreePath, branch);
      if (!unchanged || shared) {
        this.branchRenamed.delete(sessionId);
        return;
      }
      if (!shouldRenameSessionBranch({ temporary, hasLinks: (current.prs?.length ?? 0) > 0, published, shared })) return;
      const renamed = await this.git.renameBranch(project.rootPath, branch, candidate, { worktreePath });
      if (generated) {
        this.generatedBranches.delete(sessionId);
        this.store.updateSession(sessionId, { namedBranch: renamed });
      }
      this.updateSessionBranch(sessionId, renamed);
      this.onEvent(sessionId, { type: "session.branch.updated", turnId, sessionId, branch: renamed });
    } catch (err) {
      console.warn(`branch rename failed for session ${sessionId}: ${(err as Error).message}`);
      this.branchRenamed.delete(sessionId);
    }
  }

  rootForProject(projectId: string): string {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    return project.rootPath;
  }

  private assertNotReserved(): void {
    if (this.shutdownReserved) throw shutdownReservedError();
    if (this.driverFailure) throw new Error(this.driverFailure);
  }

  driverRestartFailure(): string | null {
    return this.driverFailure;
  }

  beginShutdownReservation(): void {
    this.shutdownReserved = true;
    this.interruptedForShutdown.clear();
  }

  clearShutdownReservation(): void {
    this.shutdownReserved = false;
  }

  isShutdownReserved(): boolean {
    return this.shutdownReserved;
  }

  sessionTitle(sessionId: string): string {
    return this.store.getSession(sessionId)?.title ?? sessionId;
  }

  listShutdownTurns(): ShutdownActiveTurn[] {
    const turns: ShutdownActiveTurn[] = this.listActiveTurns().map((turn) => ({
      ...turn,
      title: this.sessionTitle(turn.sessionId)
    }));
    const covered = new Set(turns.map((turn) => turn.sessionId));
    for (const { driver } of this.uniqueDrivers()) {
      for (const sessionId of driver.activity?.().busySessionIds ?? []) {
        if (covered.has(sessionId) || !this.store.getSession(sessionId)) continue;
        covered.add(sessionId);
        turns.push({ sessionId, turnId: `busy:${sessionId}`, title: this.sessionTitle(sessionId), startedAt: 0 });
      }
    }
    return turns;
  }

  listBackgroundWork(): BackgroundWork[] {
    return [...this.titleTurns]
      .filter(([, turn]) => !turn.settled)
      .map(([turnId, turn]) => ({ sessionId: turn.sessionId, turnId, kind: "title" as const }));
  }

  backgroundTaskCount(): number {
    return this.listBackgroundWork().length;
  }

  cancelBackgroundWork(): void {
    for (const [turnId, turn] of [...this.titleTurns]) {
      turn.settled = true;
      this.titleTurns.delete(turnId);
      clearTimeout(turn.timer);
      turn.resolve(null);
      try {
        turn.driver.interrupt(turnId);
      } catch {
      }
    }
  }

  flush(): void {
    for (const turnId of [...this.deltaBuffer.keys()]) this.flushDelta(turnId);
    try {
      this.usageLedger.flush();
    } catch (err) {
      console.warn(`usage ledger flush failed: ${(err as Error).message}`);
    }
  }

  async shutdownDrivers(timeoutMs: number): Promise<{ timedOut: DriverKind[] }> {
    const results = await Promise.all(
      this.uniqueDrivers().map(async ({ driver, kinds }) => ({ kinds, timedOut: await this.shutdownDriver(driver, timeoutMs) }))
    );
    return { timedOut: results.filter((result) => result.timedOut).flatMap((result) => result.kinds) };
  }

  private async shutdownDriver(driver: CliDriver, timeoutMs: number): Promise<boolean> {
    if (typeof driver.shutdown !== "function") {
      this.disposeDriver(driver);
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<{ timedOut: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, timeoutMs) + DRIVER_SHUTDOWN_GRACE_MS);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([driver.shutdown({ timeoutMs }), deadline]);
      return result.timedOut;
    } catch (err) {
      console.warn(`${driver.kind} shutdown failed: ${(err as Error).message}`);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  private disposeDriver(driver: CliDriver): void {
    try {
      driver.dispose?.();
    } catch (err) {
      console.warn(`${driver.kind} dispose failed: ${(err as Error).message}`);
    }
  }

  forceStopDrivers(): void {
    for (const { driver } of this.uniqueDrivers()) this.disposeDriver(driver);
  }

  reinitializeDrivers(): void {
    this.forceStopDrivers();
    try {
      this.drivers = this.buildDrivers();
    } catch (err) {
      this.driverFailure = `cw-code could not restart its CLI drivers after the cancelled restart (${(err as Error).message}). Quit and reopen cw-code.`;
      throw new Error(this.driverFailure);
    }
    this.driverFailure = null;
    this.disposed = false;
    const interrupted = [...this.interruptedForShutdown];
    this.interruptedForShutdown.clear();
    for (const sessionId of interrupted) {
      if (this.store.getSession(sessionId)) this.emitSession(sessionId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.deltaBuffer.values()) clearTimeout(pending.timer);
    this.deltaBuffer.clear();
    this.cancelBackgroundWork();
    for (const setup of this.worktreeSetups.values()) setup.controller.abort();
    this.firstPrompts.clear();
    try {
      this.usageLedger.flush();
    } catch (err) {
      console.warn(`usage ledger flush failed: ${(err as Error).message}`);
    }
    this.forceStopDrivers();
    this.store.close();
    this.settings.flush();
  }
}
