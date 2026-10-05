import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComposerPrefs, DriverKind, Project, SessionMeta, SessionStatus } from "@cw-code/contracts";
import { traceSessionStatus, type SessionStatusReason } from "../debug/sessionStatusTrace.js";
import { isValidPrLink, upsertLink } from "../github/prLinks.js";
import { expandHome } from "../skills/skillPaths.js";
import { writeFileAtomic } from "../storage/atomicFile.js";
import { backupBeforeRepair } from "../storage/backups.js";
import { isMetadataDocument, type MetadataDocument, type MetadataMigration, type MetadataSchema } from "../storage/metadataDocument.js";
import { LastGoodRefresher, loadVersionedJson } from "../storage/versionedJson.js";

interface StoreShape {
  projects: Project[];
  sessions: SessionMeta[];
}

export const SESSION_SCHEMA_VERSION = 1;

export function sessionStoreFile(dbPath: string): string {
  return dbPath.endsWith(".db") ? `${dbPath}.json` : join(dbPath, "cw-code.json");
}

export function normalizeRoot(rootPath: string): string {
  const stripped = rootPath.replace(/[\\/]+$/, "");
  return stripped || rootPath;
}

function projectNameFromRoot(rootPath: string): string {
  return rootPath.split(/[/\\]/).filter(Boolean).pop() ?? rootPath;
}

function validateSessionDocument(raw: unknown): string | null {
  if (!isMetadataDocument(raw)) return "expected a JSON object";
  if (!Array.isArray(raw.projects)) return "projects must be an array";
  if (!Array.isArray(raw.sessions)) return "sessions must be an array";
  for (const [index, project] of raw.projects.entries()) {
    if (!isMetadataDocument(project) || typeof project.id !== "string" || typeof project.rootPath !== "string") {
      return `projects[${index}] must be an object with string id and rootPath`;
    }
  }
  for (const [index, session] of raw.sessions.entries()) {
    if (!isMetadataDocument(session) || typeof session.id !== "string" || typeof session.projectId !== "string") {
      return `sessions[${index}] must be an object with string id and projectId`;
    }
    if (session.worktreePath !== undefined && session.worktreePath !== null && typeof session.worktreePath !== "string") {
      return `sessions[${index}].worktreePath must be a string`;
    }
  }
  return null;
}

type LegacySessionMeta = SessionMeta & { pr?: unknown };

function migrateLegacyPrLink(session: LegacySessionMeta): void {
  if (!("pr" in session)) return;
  const legacy = session.pr;
  delete session.pr;
  if (isValidPrLink(legacy)) session.prs = upsertLink(session.prs, legacy);
  else if (legacy !== undefined && legacy !== null) console.warn(`dropping malformed legacy pull request link on session ${session.id}`);
}

function normalizeGitHubAccount(project: Project): void {
  if (!project.githubAccount) return;
  const host = typeof project.githubAccount.host === "string" ? project.githubAccount.host.trim().toLowerCase() : "";
  const login = typeof project.githubAccount.login === "string" ? project.githubAccount.login.trim() : "";
  if (!host || !login) delete project.githubAccount;
  else if (host !== project.githubAccount.host || login !== project.githubAccount.login) project.githubAccount = { host, login };
}

function migrateSessionsFromV0(raw: MetadataDocument): MetadataDocument {
  const document = raw as unknown as StoreShape;
  for (const project of document.projects) {
    project.rootPath = normalizeRoot(project.rootPath);
    normalizeGitHubAccount(project);
  }
  for (const session of document.sessions) {
    migrateLegacyPrLink(session);
    if (session.worktreePath) session.worktreePath = normalizeRoot(session.worktreePath);
  }
  return raw;
}

export const SESSION_METADATA: MetadataSchema = {
  kind: "sessions",
  currentVersion: SESSION_SCHEMA_VERSION,
  validate: validateSessionDocument,
  empty: () => ({ schemaVersion: SESSION_SCHEMA_VERSION, projects: [], sessions: [] })
};

export const SESSION_MIGRATIONS: Record<number, MetadataMigration> = { 0: migrateSessionsFromV0 };

function repairProjectNames(projects: Project[]): string[] {
  const repaired: string[] = [];
  for (const [index, project] of projects.entries()) {
    if (typeof project.name === "string") continue;
    project.name = projectNameFromRoot(project.rootPath);
    repaired.push(`projects[${index}].name`);
  }
  return repaired;
}

function resetRuntimeStatuses(sessions: SessionMeta[]): boolean {
  let changed = false;
  for (const session of sessions) {
    const previous = session.status;
    if (!session.status) {
      session.status = "idle";
    } else if (session.status === "working" || session.status === "input-required") {
      session.status = "holding";
    } else {
      continue;
    }
    changed = true;
    traceSessionStatus({
      sessionId: session.id,
      driver: session.driver,
      from: previous ?? null,
      to: session.status,
      reason: previous ? "app-restart-holding" : "app-restart-idle"
    });
  }
  return changed;
}

type SessionPatch = Partial<
  Pick<
    SessionMeta,
    | "title"
    | "status"
    | "resumeCursor"
    | "model"
    | "effort"
    | "variant"
    | "permissionMode"
    | "effectivePermissionMode"
    | "worktreePath"
    | "branch"
    | "prs"
    | "prUnlinked"
    | "lastTurnSnapshot"
  >
>;

export class SessionStore {
  private filePath: string;
  private data: StoreShape = { projects: [], sessions: [] };
  private extras: MetadataDocument = {};
  private lastGood: LastGoodRefresher;

  constructor(dbPath: string) {
    this.filePath = sessionStoreFile(dbPath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const loaded = loadVersionedJson({ filePath: this.filePath, ...SESSION_METADATA, migrations: SESSION_MIGRATIONS });
    this.lastGood = new LastGoodRefresher(this.filePath);
    if (loaded.status === "ok") {
      const extras = { ...loaded.data };
      this.data = { projects: extras.projects as Project[], sessions: extras.sessions as SessionMeta[] };
      delete extras.schemaVersion;
      delete extras.projects;
      delete extras.sessions;
      this.extras = extras;
    }
    const repaired = repairProjectNames(this.data.projects);
    if (repaired.length > 0) backupBeforeRepair(this.filePath, SESSION_METADATA, repaired);
    if (resetRuntimeStatuses(this.data.sessions) || repaired.length > 0) this.persist();
  }

  private persist(): void {
    writeFileAtomic(
      this.filePath,
      JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, projects: this.data.projects, sessions: this.data.sessions, ...this.extras })
    );
    this.lastGood.afterPersist();
  }

  addProject(rootPath: string): Project {
    const trimmed = rootPath.trim();
    const expanded = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? expandHome(trimmed)
      : trimmed;
    const normalized = normalizeRoot(expanded);
    const existing = this.data.projects.find((p) => p.rootPath === normalized);
    if (existing) return existing;
    const project: Project = {
      id: `proj_${randomUUID().slice(0, 8)}`,
      rootPath: normalized,
      name: projectNameFromRoot(normalized)
    };
    this.data.projects.push(project);
    this.persist();
    return project;
  }

  listProjects(): Project[] {
    return [...this.data.projects].sort((a, b) => a.name.localeCompare(b.name));
  }

  getProject(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id);
  }

  updateProject(id: string, patch: Partial<Pick<Project, "githubAccount">>, clearGitHubAccount = false): Project {
    const project = this.getProject(id);
    if (!project) throw new Error(`unknown project ${id}`);
    if (clearGitHubAccount) delete project.githubAccount;
    else if (patch.githubAccount !== undefined) project.githubAccount = {
      host: patch.githubAccount.host.trim().toLowerCase(),
      login: patch.githubAccount.login.trim()
    };
    this.persist();
    return { ...project, ...(project.githubAccount ? { githubAccount: { ...project.githubAccount } } : {}) };
  }

  createSession(
    projectId: string,
    driver: DriverKind,
    title: string,
    workspace: { id?: string; worktreePath?: string; branch?: string } = {}
  ): SessionMeta {
    const now = Date.now();
    const session: SessionMeta = {
      id: workspace.id ?? `sess_${randomUUID().slice(0, 8)}`,
      projectId,
      driver,
      title,
      status: "idle",
      resumeCursor: "",
      createdAt: now,
      updatedAt: now,
      ...(workspace.worktreePath ? { worktreePath: normalizeRoot(workspace.worktreePath) } : {}),
      ...(workspace.branch ? { branch: workspace.branch } : {})
    };
    this.data.sessions.push(session);
    traceSessionStatus({
      sessionId: session.id,
      driver: session.driver,
      from: null,
      to: "idle",
      reason: "session-created"
    });
    this.persist();
    return session;
  }

  listSessions(projectId: string): SessionMeta[] {
    return this.data.sessions
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listAllSessions(): SessionMeta[] {
    return [...this.data.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSession(id: string): SessionMeta | undefined {
    return this.data.sessions.find((s) => s.id === id);
  }

  updateSession(id: string, patch: SessionPatch & { status: SessionStatus }, reason: SessionStatusReason): void;
  updateSession(id: string, patch: SessionPatch, reason?: undefined): void;
  updateSession(id: string, patch: SessionPatch, reason?: SessionStatusReason): void {
    const current = this.getSession(id);
    if (!current) return;
    const previousStatus = current.status;
    if (patch.title !== undefined) current.title = patch.title;
    if (patch.status !== undefined) current.status = patch.status;
    if (patch.resumeCursor !== undefined) current.resumeCursor = patch.resumeCursor;
    if (patch.model !== undefined) current.model = patch.model;
    if (patch.effort !== undefined) current.effort = patch.effort;
    if (patch.variant !== undefined) current.variant = patch.variant;
    if (patch.permissionMode !== undefined) current.permissionMode = patch.permissionMode;
    if (patch.effectivePermissionMode !== undefined) current.effectivePermissionMode = patch.effectivePermissionMode;
    else if ("effectivePermissionMode" in patch) delete current.effectivePermissionMode;
    if (patch.worktreePath !== undefined) current.worktreePath = normalizeRoot(patch.worktreePath);
    else if ("worktreePath" in patch) delete current.worktreePath;
    if (patch.branch !== undefined) current.branch = patch.branch;
    else if ("branch" in patch) delete current.branch;
    if (patch.prs !== undefined) {
      if (patch.prs.length === 0) delete current.prs;
      else current.prs = patch.prs;
    } else if ("prs" in patch) delete current.prs;
    if (patch.prUnlinked !== undefined) current.prUnlinked = patch.prUnlinked;
    else if ("prUnlinked" in patch) delete current.prUnlinked;
    if (patch.lastTurnSnapshot !== undefined) current.lastTurnSnapshot = patch.lastTurnSnapshot;
    else if ("lastTurnSnapshot" in patch) delete current.lastTurnSnapshot;
    current.updatedAt = Date.now();
    if (patch.status !== undefined && patch.status !== previousStatus) {
      traceSessionStatus({
        sessionId: id,
        driver: current.driver,
        from: previousStatus ?? null,
        to: patch.status,
        reason: reason ?? "unknown"
      });
    }
    this.persist();
  }

  expireHolding(id: string): SessionMeta | null {
    const session = this.getSession(id);
    if (!session || session.status !== "holding") return null;
    session.status = "idle";
    traceSessionStatus({
      sessionId: id,
      driver: session.driver,
      from: "holding",
      to: "idle",
      reason: "holding-expired"
    });
    this.persist();
    return { ...session };
  }

  updateComposer(id: string, prefs: ComposerPrefs): void {
    this.updateSession(id, {
      model: prefs.model,
      effort: prefs.effort,
      variant: prefs.variant,
      permissionMode: prefs.permissionMode
    });
  }

  close(): void {
    this.lastGood.flush();
  }
}
