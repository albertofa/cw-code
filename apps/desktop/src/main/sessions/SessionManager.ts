import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  SessionMeta,
  SessionStatus,
  SettingsPatch,
  ThreadEvent
} from "@cw-code/contracts";
import { SessionStore } from "./SessionStore.js";
import { SettingsStore } from "../settings/SettingsStore.js";
import { resolveClaudeModels } from "../settings/settingsUtils.js";
import { TracingCliDriver } from "../debug/tracingDriver.js";
import { CLAUDE_CURATED_MODELS, ClaudeCliDriver } from "../providers/claude/ClaudeCliDriver.js";
import { OpencodeDriver } from "../providers/opencode/OpencodeDriver.js";
import { CodexCliDriver } from "../providers/codex/CodexCliDriver.js";
import { GitService, type CreatedWorktree } from "../fs/GitService.js";
import { resolveAttachments } from "./attachments.js";

export interface SessionManagerOptions {
  dbPath?: string;
  settingsPath?: string;
  onEvent?: (sessionId: string, event: ThreadEvent) => void;
  drivers?: Partial<Record<DriverKind, CliDriver>>;
  gitService?: GitService;
  worktreesRoot?: string;
}

const DELTA_FLUSH_MS = 24;

export class SessionManager {
  private store: SessionStore;
  private settings: SettingsStore;
  private drivers: Record<DriverKind, CliDriver>;
  private activeTurns = new Map<string, string>();
  private onEvent: (sessionId: string, event: ThreadEvent) => void;
  private git: GitService;
  private worktreesRoot: string;
  private deltaBuffer = new Map<string, { sessionId: string; text: string; timer: NodeJS.Timeout }>();

  constructor(opts: SessionManagerOptions = {}) {
    const dbPath = opts.dbPath ?? join(app.getPath("userData"), "cw-code.db");
    this.store = new SessionStore(dbPath);
    const settingsPath = opts.settingsPath ?? join(app.getPath("userData"), "cw-settings.json");
    this.settings = new SettingsStore(settingsPath);
    this.onEvent = opts.onEvent ?? (() => {});
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

  getSettings(): AppSettings {
    return this.settings.get();
  }

  setSettings(patch: SettingsPatch): AppSettings {
    return this.settings.set(patch);
  }

  private handleDriverEvent(sessionId: string, event: ThreadEvent): void {
    if (event.type === "turn.done") {
      this.activeTurns.delete(event.turnId);
      this.store.updateSession(event.sessionId, { resumeCursor: event.resumeCursor, status: "done" });
    }
    if (event.type === "turn.error") {
      this.activeTurns.delete(event.turnId);
      if (sessionId) this.store.updateSession(sessionId, { status: "idle" });
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
    if (options.useWorktree !== false && await this.git.isRepository(project.rootPath)) {
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
    return this.store.createSession(projectId, driver, "New session", { id });
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

  getComposer(sessionId: string): ComposerPrefs {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    let model = session.model;
    if (!model && session.driver === "claude") {
      const fallback = this.settings.get().claudeDefaultModel?.trim() ?? "";
      if (fallback) model = fallback;
    }
    return {
      model,
      effort: session.effort ?? "medium",
      variant: session.variant,
      permissionMode: session.permissionMode ?? "auto"
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
    if (!session.resumeCursor) return [];
    try {
      return await this.drivers[session.driver].getHistory(await this.ensureWorktree(sessionId), session.resumeCursor);
    } catch (err) {
      console.warn(`history failed for ${sessionId}: ${(err as Error).message}`);
      return [];
    }
  }

  async startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[] }): Promise<string> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error(`unknown project ${session.projectId}`);
    for (const [turnId, owner] of this.activeTurns) {
      if (owner === sessionId) throw new Error(`session busy (turn ${turnId})`);
    }
    if (session.title === "New session") {
      this.store.updateSession(sessionId, { title: prompt.slice(0, 60) });
    }
    const cwd = await this.ensureWorktree(sessionId);
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
      attachments: resolveAttachments(project.rootPath, cwd, opts?.attachments ?? [])
    });
    this.activeTurns.set(handle.turnId, sessionId);
    this.store.updateSession(sessionId, { status: "working" });
    return handle.turnId;
  }

  async listModels(sessionId: string): Promise<ModelOption[]> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return this.listModelsFor(session.projectId, session.driver);
  }

  async listModelsFor(projectId: string, driver: DriverKind): Promise<ModelOption[]> {
    if (driver === "claude") {
      return resolveClaudeModels(this.settings.get(), CLAUDE_CURATED_MODELS);
    }
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const driverInstance = this.drivers[driver];
    if (typeof driverInstance.listModels !== "function") return [];
    try {
      return await driverInstance.listModels(project.rootPath);
    } catch (err) {
      console.warn(`model list failed: ${(err as Error).message}`);
    }
    return [];
  }

  interrupt(turnId: string): void {
    const sessionId = this.activeTurns.get(turnId);
    if (!sessionId) return;
    const session = this.store.getSession(sessionId);
    if (session) this.drivers[session.driver].interrupt(turnId);
    this.activeTurns.delete(turnId);
    this.store.updateSession(sessionId, { status: "idle" });
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
    const project = this.getProject(session.projectId);
    const expectedPath = join(this.worktreesRoot, session.projectId, sessionId);
    await this.git.pruneWorktrees(project.rootPath, this.worktreesRoot);
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

  updateSessionBranch(sessionId: string, branch: string): void {
    if (!this.store.getSession(sessionId)) throw new Error(`unknown session ${sessionId}`);
    this.store.updateSession(sessionId, { branch });
  }

  rootForProject(projectId: string): string {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    return project.rootPath;
  }

  dispose(): void {
    for (const pending of this.deltaBuffer.values()) clearTimeout(pending.timer);
    this.deltaBuffer.clear();
    for (const driver of Object.values(this.drivers)) driver.dispose?.();
    this.store.close();
  }
}
