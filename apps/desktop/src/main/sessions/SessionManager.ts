import { app } from "electron";
import { join } from "node:path";
import type {
  AppSettings,
  ApprovalDecision,
  CliDriver,
  ComposerPrefs,
  DriverKind,
  HistoryMessage,
  ModelOption,
  Project,
  SessionMeta,
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

export interface SessionManagerOptions {
  dbPath?: string;
  settingsPath?: string;
  onEvent?: (sessionId: string, event: ThreadEvent) => void;
  drivers?: Partial<Record<DriverKind, CliDriver>>;
}

export class SessionManager {
  private store: SessionStore;
  private settings: SettingsStore;
  private drivers: Record<DriverKind, CliDriver>;
  private activeTurns = new Map<string, string>();
  private onEvent: (sessionId: string, event: ThreadEvent) => void;

  constructor(opts: SessionManagerOptions = {}) {
    const dbPath = opts.dbPath ?? join(app.getPath("userData"), "cw-code.db");
    this.store = new SessionStore(dbPath);
    const settingsPath = opts.settingsPath ?? join(app.getPath("userData"), "cw-settings.json");
    this.settings = new SettingsStore(settingsPath);
    this.onEvent = opts.onEvent ?? (() => {});
    const getSettings = (): AppSettings => this.settings.get();
    this.drivers = {
      claude: opts.drivers?.claude ?? new TracingCliDriver(new ClaudeCliDriver((e) => this.routeEvent(e), getSettings)),
      opencode: opts.drivers?.opencode ?? new TracingCliDriver(new OpencodeDriver((e) => this.routeEvent(e), getSettings)),
      codex: opts.drivers?.codex ?? new TracingCliDriver(new CodexCliDriver((e) => this.routeEvent(e), getSettings))
    };
  }

  private routeEvent(event: ThreadEvent): void {
    if (event.type === "turn.done") {
      this.handleDriverEvent(event.sessionId, event);
      return;
    }
    const sessionId = this.activeTurns.get(event.turnId) ?? "";
    this.handleDriverEvent(sessionId, event);
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
      this.store.updateSession(event.sessionId, { resumeCursor: event.resumeCursor });
    }
    if (event.type === "turn.error") this.activeTurns.delete(event.turnId);
    this.onEvent(sessionId, event);
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  addProject(rootPath: string): Project {
    return this.store.addProject(rootPath);
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

  async createSession(projectId: string, driver: DriverKind): Promise<SessionMeta> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    return this.store.createSession(projectId, driver, "New session");
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    this.store.updateSession(sessionId, { title });
    if (session.resumeCursor) {
      await this.drivers[session.driver].renameSession(session.resumeCursor, title);
    }
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
      return await this.drivers[session.driver].getHistory(project.rootPath, session.resumeCursor);
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
    const stored = this.getComposer(sessionId);
    const prefs = { ...stored, ...(opts?.prefs ?? {}) };
    const driver = this.drivers[session.driver];
    const handle = driver.startTurn({
      sessionId,
      prompt,
      cwd: project.rootPath,
      resumeCursor: session.resumeCursor,
      model: prefs.model,
      effort: prefs.effort,
      variant: prefs.variant,
      permissionMode: prefs.permissionMode,
      attachments: opts?.attachments ?? []
    });
    this.activeTurns.set(handle.turnId, sessionId);
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
    return this.rootForProject(session.projectId);
  }

  rootForProject(projectId: string): string {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    return project.rootPath;
  }

  dispose(): void {
    for (const driver of Object.values(this.drivers)) driver.dispose?.();
    this.store.close();
  }
}
