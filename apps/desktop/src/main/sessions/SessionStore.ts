import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComposerPrefs, DriverKind, Project, SessionMeta } from "@cw-code/contracts";
import { isValidPrLink, upsertLink } from "../github/prLinks.js";
import { expandHome } from "../skills/skillPaths.js";
import { writeFileAtomic } from "../storage/atomicFile.js";
import {
  isMetadataDocument,
  loadVersionedJson,
  type MetadataDocument,
  type MetadataMigration,
  type MetadataSchema
} from "../storage/versionedJson.js";

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
  validate: validateSessionDocument
};

export const SESSION_MIGRATIONS: Record<number, MetadataMigration> = { 0: migrateSessionsFromV0 };

function resetRuntimeStatuses(sessions: SessionMeta[]): boolean {
  let changed = false;
  for (const session of sessions) {
    if (!session.status) {
      session.status = "idle";
      changed = true;
    } else if (session.status === "working" || session.status === "input-required") {
      session.status = "holding";
      changed = true;
    }
  }
  return changed;
}

export class SessionStore {
  private filePath: string;
  private data: StoreShape = { projects: [], sessions: [] };
  private extras: MetadataDocument = {};

  constructor(dbPath: string) {
    this.filePath = sessionStoreFile(dbPath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const loaded = loadVersionedJson({ filePath: this.filePath, ...SESSION_METADATA, migrations: SESSION_MIGRATIONS });
    if (loaded.status === "ok") {
      const extras = { ...loaded.data };
      this.data = { projects: extras.projects as Project[], sessions: extras.sessions as SessionMeta[] };
      delete extras.schemaVersion;
      delete extras.projects;
      delete extras.sessions;
      this.extras = extras;
    }
    if (resetRuntimeStatuses(this.data.sessions)) this.persist();
  }

  private persist(): void {
    writeFileAtomic(
      this.filePath,
      JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, projects: this.data.projects, sessions: this.data.sessions, ...this.extras })
    );
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
      name: normalized.split(/[/\\]/).filter(Boolean).pop() ?? normalized
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

  findByCursor(projectId: string, driver: DriverKind, resumeCursor: string): SessionMeta | undefined {
    return this.data.sessions.find(
      (s) => s.projectId === projectId && s.driver === driver && s.resumeCursor === resumeCursor
    );
  }

  updateSession(
    id: string,
    patch: Partial<
      Pick<SessionMeta, "title" | "status" | "resumeCursor" | "model" | "effort" | "variant" | "permissionMode" | "worktreePath" | "branch" | "prs" | "prUnlinked">
    >
  ): void {
    const current = this.getSession(id);
    if (!current) return;
    if (patch.title !== undefined) current.title = patch.title;
    if (patch.status !== undefined) current.status = patch.status;
    if (patch.resumeCursor !== undefined) current.resumeCursor = patch.resumeCursor;
    if (patch.model !== undefined) current.model = patch.model;
    if (patch.effort !== undefined) current.effort = patch.effort;
    if (patch.variant !== undefined) current.variant = patch.variant;
    if (patch.permissionMode !== undefined) current.permissionMode = patch.permissionMode;
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
    current.updatedAt = Date.now();
    this.persist();
  }

  expireHolding(id: string): SessionMeta | null {
    const session = this.getSession(id);
    if (!session || session.status !== "holding") return null;
    session.status = "idle";
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

  close(): void {}
}
