import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  AppSettings,
  ApprovalDecision,
  CliDriver,
  ComposerPrefs,
  CreateSessionOptions,
  DriverKind,
  HistoryMessage,
  ModelOption,
  Project,
  SessionCleanupResult,
  SessionMeta,
  SessionStatus,
  SettingsPatch,
  ThreadEvent,
  TurnHandle,
  WorktreePruneSummary
} from "@cw-code/contracts";
import { SessionStore } from "./SessionStore.js";
import { buildTurnEnv } from "./env.js";
import { isWorktreeOrphaned, looksLikeWorktree, pinsWorktree, sameWorktreePath } from "./worktreeCleanup.js";
import { SettingsStore } from "../settings/SettingsStore.js";
import { resolveClaudeModels } from "../settings/settingsUtils.js";
import { TracingCliDriver } from "../debug/tracingDriver.js";
import { CLAUDE_CURATED_MODELS, ClaudeCliDriver } from "../providers/claude/ClaudeCliDriver.js";
import { OpencodeDriver } from "../providers/opencode/OpencodeDriver.js";
import { CodexCliDriver } from "../providers/codex/CodexCliDriver.js";
import { GitService, safeSegment, type CreatedWorktree, type RemoveWorktreeResult } from "../fs/GitService.js";
import { resolveAttachments } from "./attachments.js";
import { AUTO_TITLE_TIMEOUT_MS, buildTitlePrompt, sanitizeGeneratedTitle } from "./autoTitle.js";
import { branchNameForTitle, TEMP_BRANCH_PATTERN } from "./branchName.js";
import { NEW_SESSION_TITLE, pickRestoreCandidate } from "./sessionRestore.js";

export interface SessionManagerOptions {
  dbPath?: string;
  settingsPath?: string;
  onEvent?: (sessionId: string, event: ThreadEvent) => void;
  onTitle?: (sessionId: string, title: string) => void;
  drivers?: Partial<Record<DriverKind, CliDriver>>;
  gitService?: GitService;
  worktreesRoot?: string;
}

interface TitleTurn {
  sessionId: string;
  placeholder: string;
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

export class SessionManager {
  private store: SessionStore;
  private settings: SettingsStore;
  private drivers: Record<DriverKind, CliDriver>;
  private activeTurns = new Map<string, string>();
  private titleTurns = new Map<string, TitleTurn>();
  private firstPrompts = new Map<string, string>();
  private pendingTurns = new Set<string>();
  private pendingResolves = new Set<string>();
  private worktreeRecovery = new Map<string, Promise<string>>();
  private branchRenamed = new Set<string>();
  private onEvent: (sessionId: string, event: ThreadEvent) => void;
  private onTitle: (sessionId: string, title: string) => void;
  private git: GitService;
  private worktreesRoot: string;
  private deltaBuffer = new Map<string, { sessionId: string; text: string; timer: NodeJS.Timeout }>();
  private turnBaseShas = new Map<string, string>();

  constructor(opts: SessionManagerOptions = {}) {
    const dbPath = opts.dbPath ?? join(app.getPath("userData"), "cw-code.db");
    this.store = new SessionStore(dbPath);
    const settingsPath = opts.settingsPath ?? join(app.getPath("userData"), "cw-settings.json");
    this.settings = new SettingsStore(settingsPath);
    this.onEvent = opts.onEvent ?? (() => {});
    this.onTitle = opts.onTitle ?? (() => {});
    this.git = opts.gitService ?? new GitService(() => this.settings.get());
    this.worktreesRoot = opts.worktreesRoot ?? join(app.getPath("userData"), "worktrees");
    const getSettings = (): AppSettings => this.settings.get();
    this.drivers = {
      claude: opts.drivers?.claude ?? new TracingCliDriver(new ClaudeCliDriver((e) => this.routeEvent(e), getSettings)),
      opencode: opts.drivers?.opencode ?? new TracingCliDriver(new OpencodeDriver((e) => this.routeEvent(e), getSettings)),
      codex: opts.drivers?.codex ?? new TracingCliDriver(new CodexCliDriver((e) => this.routeEvent(e), getSettings))
    };
  }

  private routeEvent(event: ThreadEvent): void {
    if (this.titleTurns.has(event.turnId)) {
      this.handleTitleTurnEvent(event);
      return;
    }
    if (event.type === "assistant.delta") {
      this.bufferDelta(event.turnId, this.activeTurns.get(event.turnId) ?? "", event.text);
      return;
    }
    if (event.type === "turn.done") {
      this.flushDelta(event.turnId);
      this.handleDriverEvent(event.sessionId, event);
      return;
    }
    this.flushDelta(event.turnId);
    const sessionId = this.activeTurns.get(event.turnId) ?? "";
    this.handleDriverEvent(sessionId, event);
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
    clearTimeout(turn.timer);
    const title = sanitizeGeneratedTitle(turn.text);
    if (!title) {
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

  getSettings(): AppSettings {
    return this.settings.get();
  }

  setSettings(patch: SettingsPatch): AppSettings {
    return this.settings.set(patch);
  }

  private handleDriverEvent(sessionId: string, event: ThreadEvent): void {
    if (event.type === "turn.done") {
      const backgroundTasks = event.backgroundTasks ?? 0;
      if (backgroundTasks > 0) {
        this.store.updateSession(event.sessionId, { resumeCursor: event.resumeCursor, status: "working" });
      } else {
        this.activeTurns.delete(event.turnId);
        this.store.updateSession(event.sessionId, { resumeCursor: event.resumeCursor, status: "done" });
        if (!event.isError) void this.renameBranchForTitle(event.sessionId, event.turnId);
      }
    }
    if (event.type === "turn.error") {
      this.activeTurns.delete(event.turnId);
      if (sessionId) {
        this.store.updateSession(sessionId, {
          status: "holding",
          ...(event.resumeCursor ? { resumeCursor: event.resumeCursor } : {})
        });
      }
    }
    if (event.type === "approval.request" || event.type === "question.request") {
      if (sessionId) this.store.updateSession(sessionId, { status: "input-required" });
    }
    if (event.type === "approval.resolved" || event.type === "question.resolved") {
      if (sessionId && this.activeTurns.has(event.turnId)) {
        this.store.updateSession(sessionId, { status: "working" });
      }
    }
    this.onEvent(sessionId, event);
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
    return this.store.updateProject(projectId, { githubAccount: account ?? undefined }, account === null);
  }

  async listSessions(projectId: string): Promise<SessionMeta[]> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    return this.store.listSessions(projectId);
  }

  async listDiscovered(projectId: string): Promise<SessionMeta[]> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const stored = new Set(
      this.store
        .listSessions(projectId)
        .map((s) => `${s.driver}:${s.resumeCursor}`)
        .filter((k) => !k.endsWith(":"))
    );
    const out: SessionMeta[] = [];
    for (const driver of Object.values(this.drivers)) {
      let discovered: SessionMeta[] = [];
      try {
        discovered = await driver.listSessions(project.rootPath, projectId);
      } catch (err) {
        console.warn(`discovery failed for ${driver.kind}: ${(err as Error).message}`);
        continue;
      }
      for (const d of discovered) {
        if (!d.resumeCursor || stored.has(`${d.driver}:${d.resumeCursor}`)) continue;
        stored.add(`${d.driver}:${d.resumeCursor}`);
        out.push({ ...d, id: `ext:${d.driver}:${d.resumeCursor}` });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async importSession(projectId: string, driver: DriverKind, resumeCursor: string, title: string): Promise<SessionMeta> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const existing = this.store.findByCursor(projectId, driver, resumeCursor);
    if (existing) return existing;
    const session = this.store.createSession(projectId, driver, title || resumeCursor.slice(0, 8));
    this.store.updateSession(session.id, { resumeCursor });
    const stored = this.store.getSession(session.id);
    if (!stored) throw new Error("import failed");
    return stored;
  }

  async createSession(projectId: string, driver: DriverKind, options: CreateSessionOptions = {}): Promise<SessionMeta> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const id = `sess_${randomUUID().slice(0, 8)}`;
    const mode = options.mode ?? (options.useWorktree === false ? "current" : "new");
    if (mode === "current" || !(await this.git.isRepository(project.rootPath))) {
      return this.store.createSession(projectId, driver, "New session", { id });
    }
    if (mode === "previous" && options.reuseWorktreePath) {
      const reused = await this.reusableWorktree(project, options.reuseWorktreePath);
      if (reused) {
        return this.store.createSession(projectId, driver, "New session", {
          id,
          worktreePath: reused.path,
          branch: reused.branch
        });
      }
    }
    const worktree = await this.git.createWorktree(
      project.rootPath,
      project.id,
      id,
      this.worktreesRoot,
      options.baseBranch
    );
    return this.store.createSession(projectId, driver, "New session", {
      id,
      worktreePath: worktree.path,
      branch: worktree.branch
    });
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
      return { path, branch, repositoryRoot };
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

  setSessionStatus(sessionId: string, status: SessionStatus): SessionMeta {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    this.store.updateSession(sessionId, { status });
    const updated = this.store.getSession(sessionId);
    if (!updated) throw new Error(`unknown session ${sessionId}`);
    return updated;
  }

  expireHoldingSessions(sessionIds: string[]): SessionMeta[] {
    const expired: SessionMeta[] = [];
    for (const sessionId of sessionIds) {
      const updated = this.store.expireHolding(sessionId);
      if (updated) expired.push(updated);
    }
    return expired;
  }

  async resolveSession(
    sessionId: string,
    status: SessionStatus,
    opts: { removeWorktree?: boolean; forceBranch?: boolean } = {}
  ): Promise<SessionCleanupResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const project = this.getProject(session.projectId);
    for (const owner of this.activeTurns.values()) {
      if (owner === sessionId) throw new Error("session busy (turn active)");
    }
    if (this.pendingTurns.has(sessionId)) throw new Error("session busy (turn pending)");
    if (this.pendingResolves.has(sessionId)) throw new Error("session busy (resolve pending)");
    this.pendingResolves.add(sessionId);
    try {
      const recovery = this.worktreeRecovery.get(sessionId);
      if (recovery) {
        await recovery.catch(() => undefined);
        if (this.worktreeRecovery.has(sessionId)) throw new Error("session busy (recovery in progress)");
      }
      const refreshed = this.store.getSession(sessionId);
      return await this.resolveSessionInner(refreshed ?? session, status, project, opts);
    } finally {
      this.pendingResolves.delete(sessionId);
    }
  }

  private async resolveSessionInner(
    session: SessionMeta,
    status: SessionStatus,
    project: Project,
    opts: { removeWorktree?: boolean; forceBranch?: boolean }
  ): Promise<SessionCleanupResult> {
    const sessionId = session.id;
    this.turnBaseShas.delete(sessionId);
    this.store.updateSession(sessionId, { status });
    this.drivers[session.driver].stopSession?.(sessionId);
    const worktreePath = session.worktreePath;
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
        error: (err as Error).message
      };
    }
    if (!removal.removed) {
      return {
        sessionId,
        status,
        worktreePath,
        worktreeOrphaned: true,
        worktreeRemoved: false,
        ...(removal.dirtyBlocked ? { dirtyBlocked: true } : {}),
        branchDeleted: false
      };
    }
    const branchOutcome = session.branch
      ? await this.deleteOrphanBranch(project.rootPath, session.branch, worktreePath, opts.forceBranch === true)
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
      ...(branchOutcome?.unmergedCommits ? { unmergedCommits: true } : {})
    };
  }

  private async deleteOrphanBranch(
    repoRoot: string,
    branch: string,
    removedPath: string,
    force: boolean
  ): Promise<BranchOutcome> {
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
    const summary: WorktreePruneSummary = { scanned: 0, removed: 0, skipped: 0, failed: 0, errors: [], keptDirty: [] };
    if (!existsSync(this.worktreesRoot)) return summary;
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
        await this.removeStaleDir(project?.rootPath ?? null, dirPath, summary);
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
    return summary;
  }

  private async removeStaleDir(repoRoot: string | null, dirPath: string, summary: WorktreePruneSummary): Promise<void> {
    if (!looksLikeWorktree(dirPath)) {
      summary.skipped += 1;
      return;
    }
    if (repoRoot && await this.git.worktreeDirty(dirPath)) {
      summary.keptDirty.push(dirPath);
      return;
    }
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

  getComposer(sessionId: string): ComposerPrefs {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    let model = session.model;
    if (!model && session.driver === "claude") {
      const fallback = this.settings.get().claudeDefaultModel?.trim() ?? "";
      if (fallback) model = fallback;
    }
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
    if (!session.resumeCursor) {
      const healed = await this.healMissingCursor(session, project);
      if (!healed) return [];
      return healed;
    }
    let messages: HistoryMessage[];
    try {
      messages = await this.drivers[session.driver].getHistory(await this.ensureWorktree(sessionId), session.resumeCursor);
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`history failed for ${sessionId}: ${message}`);
      throw new Error(`Could not load history for this session: ${message}. Retry to reconnect.`);
    }
    if (messages.length > 0) return messages;
    return this.verifyEmptyHistory(session, project);
  }

  private async healMissingCursor(session: SessionMeta, project: Project): Promise<HistoryMessage[] | null> {
    if (session.title.trim().toLowerCase() === NEW_SESSION_TITLE.toLowerCase()) return null;
    if (this.pendingTurns.has(session.id)) return null;
    for (const owner of this.activeTurns.values()) {
      if (owner === session.id) return null;
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
    for (const owner of this.activeTurns.values()) {
      if (owner === session.id) return [];
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

  private sessionEnvVars(session: SessionMeta, project: Project, cwd: string): Record<string, string> {
    return {
      CW_WORKTREE_PATH: cwd,
      CW_PROJECT_ROOT: project.rootPath,
      CW_SESSION_ID: session.id
    };
  }

  turnEnv(sessionId: string, cwd: string): Record<string, string> {
    const session = this.store.getSession(sessionId);
    if (!session) return buildTurnEnv(process.env, { CW_WORKTREE_PATH: cwd });
    const project = this.store.getProject(session.projectId);
    if (!project) return buildTurnEnv(process.env, { CW_WORKTREE_PATH: cwd, CW_SESSION_ID: session.id });
    return buildTurnEnv(process.env, this.sessionEnvVars(session, project, cwd));
  }

  turnBaseSha(sessionId: string): string | null {
    return this.turnBaseShas.get(sessionId) ?? null;
  }

  private async captureTurnBaseSha(sessionId: string, cwd: string, worktreePath: string | null | undefined): Promise<void> {
    if (!worktreePath) return;
    try {
      this.turnBaseShas.set(sessionId, await this.git.headSha(cwd));
    } catch (err) {
      this.turnBaseShas.delete(sessionId);
      console.warn(`turn base capture failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  async startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[] }): Promise<string> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.status === "resolved" || session.status === "archived") {
      throw new Error(`session is ${session.status}; reopen it before starting a turn`);
    }
    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error(`unknown project ${session.projectId}`);
    for (const [turnId, owner] of this.activeTurns) {
      if (owner === sessionId) throw new Error(`session busy (turn ${turnId})`);
    }
    if (this.pendingTurns.has(sessionId)) throw new Error("session busy (turn pending)");
    if (this.pendingResolves.has(sessionId)) throw new Error("session busy (resolve pending)");
    this.pendingTurns.add(sessionId);
    try {
      const cwd = await this.ensureWorktree(sessionId);
      await this.captureTurnBaseSha(sessionId, cwd, session.worktreePath);
      const firstMessage = session.title === NEW_SESSION_TITLE;
      const placeholder = prompt.slice(0, 60);
      if (firstMessage) {
        this.firstPrompts.set(sessionId, prompt);
        this.store.updateSession(sessionId, { title: placeholder });
        this.onTitle(sessionId, placeholder);
      }
      const stored = this.getComposer(sessionId);
      const prefs = { ...stored, ...(opts?.prefs ?? {}) };
      const driver = this.drivers[session.driver];
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
        env: buildTurnEnv(process.env, this.sessionEnvVars(session, project, cwd))
      });
      this.activeTurns.set(handle.turnId, sessionId);
      this.store.updateSession(sessionId, { status: "working" });
      if (firstMessage) this.maybeAutoTitle(sessionId, prompt, placeholder);
      return handle.turnId;
    } finally {
      this.pendingTurns.delete(sessionId);
    }
  }

  private maybeAutoTitle(sessionId: string, prompt: string, placeholder: string): void {
    if (!this.settings.get().autoTitleEnabled || !prompt.trim()) return;
    void this.launchTitleTurn(sessionId, prompt, placeholder);
  }

  async regenerateTitle(sessionId: string): Promise<string> {
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

  private launchTitleTurn(sessionId: string, prompt: string, placeholder: string): Promise<string | null> {
    for (const pending of this.titleTurns.values()) {
      if (pending.sessionId === sessionId && !pending.settled) return pending.promise;
    }
    const settings = this.settings.get();
    const driver = this.drivers[settings.autoTitleDriver];
    let handle: TurnHandle;
    try {
      handle = driver.startTurn({
        sessionId: `title:${sessionId}`,
        prompt: buildTitlePrompt(prompt),
        cwd: this.titleGenRoot(),
        model: settings.autoTitleModel.trim() || undefined,
        effort: settings.autoTitleEffort,
        permissionMode: "auto",
        maxTurns: 1
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
      turn.resolve(null);
      driver.interrupt(handle.turnId);
    }, AUTO_TITLE_TIMEOUT_MS);
    timer.unref?.();
    this.titleTurns.set(handle.turnId, {
      sessionId,
      placeholder,
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
    const dir = join(app.getPath("userData"), "title-gen");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async listModels(sessionId: string): Promise<ModelOption[]> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    if (session.driver === "claude") return this.listModelsFor(session.projectId, "claude");
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
    try {
      return await driverInstance.listModels(this.titleGenRoot());
    } catch (err) {
      console.warn(`model list failed for ${driver}: ${(err as Error).message}`);
      throw err;
    }
  }

  interrupt(turnId: string): void {
    const sessionId = this.activeTurns.get(turnId);
    if (!sessionId) return;
    const session = this.store.getSession(sessionId);
    if (session) this.drivers[session.driver].interrupt(turnId);
    this.activeTurns.delete(turnId);
    this.store.updateSession(sessionId, { status: "holding" });
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    for (const driver of Object.values(this.drivers)) {
      if (typeof driver.respondToApproval !== "function") continue;
      try {
        await driver.respondToApproval(requestId, decision);
      } catch (err) {
        console.warn(`approval response failed for ${driver.kind}: ${(err as Error).message}`);
      }
    }
  }

  async respondQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    for (const driver of Object.values(this.drivers)) {
      if (typeof driver.respondToQuestion !== "function") continue;
      try {
        await driver.respondToQuestion(requestId, answers);
      } catch (err) {
        console.warn(`question response failed for ${driver.kind}: ${(err as Error).message}`);
      }
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
    if (session.branch && (await this.branchExists(project.rootPath, session.branch))) {
      try {
        const attached = await this.git.attachWorktree(project.rootPath, expectedPath, session.branch);
        return attached.path;
      } catch (err) {
        console.warn(`worktree attach failed for ${sessionId}: ${(err as Error).message}`);
      }
    }
    let worktree: CreatedWorktree;
    try {
      worktree = await this.git.createWorktree(
        project.rootPath,
        project.id,
        sessionId,
        this.worktreesRoot,
        session.branch
      );
    } catch (err) {
      throw new Error(
        `could not recreate worktree for session ${sessionId} at ${expectedPath} from branch '${session.branch ?? "HEAD"}': ${(err as Error).message}`
      );
    }
    if (worktree.branch !== session.branch) this.updateSessionBranch(sessionId, worktree.branch);
    return worktree.path;
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
  }

  private async renameBranchForTitle(sessionId: string, turnId: string): Promise<void> {
    if (this.branchRenamed.has(sessionId)) return;
    const session = this.store.getSession(sessionId);
    if (!session?.worktreePath || !session.branch || !TEMP_BRANCH_PATTERN.test(session.branch)) return;
    const { worktreePath, branch } = session;
    const title = session.title.trim();
    if (!title || title === "New session") return;
    const candidate = branchNameForTitle(title);
    if (!candidate || candidate === branch) return;
    const shared = this.store.listAllSessions().some(
      (other) =>
        other.id !== sessionId &&
        pinsWorktree(other) &&
        ((other.worktreePath && sameWorktreePath(other.worktreePath, worktreePath)) || other.branch === branch)
    );
    if (shared) return;
    this.branchRenamed.add(sessionId);
    try {
      const project = this.getProject(session.projectId);
      const renamed = await this.git.renameBranch(project.rootPath, branch, candidate, { worktreePath });
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

  dispose(): void {
    for (const pending of this.deltaBuffer.values()) clearTimeout(pending.timer);
    this.deltaBuffer.clear();
    for (const turn of this.titleTurns.values()) {
      clearTimeout(turn.timer);
      turn.resolve(null);
    }
    this.titleTurns.clear();
    this.firstPrompts.clear();
    this.turnBaseShas.clear();
    for (const driver of Object.values(this.drivers)) driver.dispose?.();
    this.store.close();
  }
}
