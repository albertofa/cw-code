import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AutoFollowUpPause,
  ComposerPrefs,
  DriverKind,
  Project,
  ProjectSettings,
  ResolvedCheckout,
  SessionMeta,
  SessionPrLink,
  SessionStatus,
  SubagentLink
} from "@cw-code/contracts";
import { traceSessionStatus, type SessionStatusReason } from "../debug/sessionStatusTrace.js";
import { isValidPrLink, upsertLink } from "../github/prLinks.js";
import { expandProjectRoot } from "../skills/skillPaths.js";
import { sanitizeProjectSettings } from "./projectSettings.js";
import { writeFileAtomic } from "../storage/atomicFile.js";
import { backupBeforeRepair } from "../storage/backups.js";
import { isMetadataDocument, type MetadataDocument, type MetadataMigration, type MetadataSchema } from "../storage/metadataDocument.js";
import { LastGoodRefresher, loadVersionedJson } from "../storage/versionedJson.js";

export type AutoFollowUpMeta = NonNullable<SessionMeta["autoFollowUp"]>;
export type SessionStatusSnapshot = Pick<SessionMeta, "status" | "idleSince" | "updatedAt">;

const AUTO_FOLLOW_UP_PAUSES: ReadonlySet<AutoFollowUpPause> = new Set(["user", "interrupted", "error"]);

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
      changed = true;
      traceSessionStatus({
        sessionId: session.id,
        driver: session.driver,
        from: null,
        to: "idle",
        reason: "app-restart-idle"
      });
    } else if (session.status === "working" || session.status === "input-required") {
      session.status = "holding";
      if (session.subagent) {
        session.subagent = {
          ...session.subagent,
          result: { turnId: session.lastTurnSnapshot?.turnId ?? `restart:${session.updatedAt}`, outcome: "interrupted", text: null, at: Date.now() },
          delivered: false
        };
      }
      changed = true;
      traceSessionStatus({
        sessionId: session.id,
        driver: session.driver,
        from: previous,
        to: "holding",
        reason: "app-restart-holding"
      });
    }
    if (session.idleSince !== undefined && !Number.isFinite(session.idleSince)) {
      delete session.idleSince;
      changed = true;
    }
    if (session.autoResolved !== undefined && typeof session.autoResolved !== "boolean") {
      delete session.autoResolved;
      changed = true;
    }
    if (session.resolvedCheckout !== undefined && !isResolvedCheckout(session.resolvedCheckout)) {
      delete session.resolvedCheckout;
      changed = true;
    }
    if (session.autoFollowUp !== undefined && !isAutoFollowUpMeta(session.autoFollowUp)) {
      delete session.autoFollowUp;
      changed = true;
    }
    if (session.status === "idle" && session.idleSince === undefined && Number.isFinite(session.updatedAt)) {
      session.idleSince = session.updatedAt;
      changed = true;
    }
  }
  return changed;
}

function isResolvedCheckout(value: unknown): value is ResolvedCheckout {
  if (!value || typeof value !== "object") return false;
  const checkout = value as Partial<{ kind: string; path: unknown }>;
  if (checkout.kind === "root") return true;
  return checkout.kind === "worktree" && typeof checkout.path === "string" && checkout.path.length > 0;
}

function isAutoFollowUpMeta(value: unknown): value is AutoFollowUpMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<Record<keyof AutoFollowUpMeta, unknown>>;
  if (typeof meta.turns !== "number" || !Number.isInteger(meta.turns) || meta.turns < 0) return false;
  return meta.paused === undefined || AUTO_FOLLOW_UP_PAUSES.has(meta.paused as AutoFollowUpPause);
}

function normalizedAutoFollowUp(meta: AutoFollowUpMeta | undefined): AutoFollowUpMeta | undefined {
  if (!meta || (meta.turns === 0 && meta.paused === undefined)) return undefined;
  return meta.paused === undefined ? { turns: meta.turns } : { paused: meta.paused, turns: meta.turns };
}

function copyProject(project: Project): Project {
  return {
    ...project,
    ...(project.githubAccount ? { githubAccount: { ...project.githubAccount } } : {}),
    ...(project.settings ? { settings: { ...project.settings } } : {})
  };
}

function withoutTransientFields(session: SessionMeta): SessionMeta {
  if (!("createNotice" in session)) return session;
  const persisted = { ...session };
  delete persisted.createNotice;
  return persisted;
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
    | "namedBranch"
    | "baseRef"
    | "prs"
    | "prUnlinked"
    | "issues"
    | "runs"
    | "autoResolved"
    | "resolvedCheckout"
    | "lastTurnSnapshot"
    | "subagent"
  >
>;

export class SessionStore {
  private filePath: string;
  private data: StoreShape = { projects: [], sessions: [] };
  private extras: MetadataDocument = {};
  private lastGood: LastGoodRefresher;
  /** Increments on every persisted write so callers can cache derived views. */
  revision = 0;

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
    this.revision += 1;
    writeFileAtomic(
      this.filePath,
      JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, projects: this.data.projects, sessions: this.data.sessions.map(withoutTransientFields), ...this.extras })
    );
    this.lastGood.afterPersist();
  }

  addProject(rootPath: string): Project {
    const normalized = normalizeRoot(expandProjectRoot(rootPath));
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
    return copyProject(project);
  }

  updateProjectSettings(id: string, settings: ProjectSettings): Project {
    const project = this.getProject(id);
    if (!project) throw new Error(`unknown project ${id}`);
    const sanitized = sanitizeProjectSettings(settings);
    if (Object.keys(sanitized).length === 0) delete project.settings;
    else project.settings = sanitized;
    this.persist();
    return copyProject(project);
  }

  createSession(
    projectId: string,
    driver: DriverKind,
    title: string,
    workspace: { id?: string; worktreePath?: string; branch?: string; baseRef?: string; resumeCursor?: string; subagent?: SubagentLink } = {}
  ): SessionMeta {
    const now = Date.now();
    const session: SessionMeta = {
      id: workspace.id ?? `sess_${randomUUID().slice(0, 8)}`,
      projectId,
      driver,
      title,
      status: "idle",
      resumeCursor: workspace.resumeCursor ?? "",
      createdAt: now,
      updatedAt: now,
      idleSince: now,
      ...(workspace.worktreePath ? { worktreePath: normalizeRoot(workspace.worktreePath) } : {}),
      ...(workspace.branch ? { branch: workspace.branch } : {}),
      ...(workspace.baseRef ? { baseRef: workspace.baseRef } : {}),
      ...(workspace.subagent ? { subagent: workspace.subagent } : {})
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
    if (patch.namedBranch !== undefined) current.namedBranch = patch.namedBranch;
    else if ("namedBranch" in patch) delete current.namedBranch;
    if (patch.baseRef !== undefined) current.baseRef = patch.baseRef;
    else if ("baseRef" in patch) delete current.baseRef;
    if (patch.prs !== undefined) {
      if (patch.prs.length === 0) delete current.prs;
      else current.prs = patch.prs;
    } else if ("prs" in patch) delete current.prs;
    if (patch.issues !== undefined) {
      if (patch.issues.length === 0) delete current.issues;
      else current.issues = patch.issues;
    } else if ("issues" in patch) delete current.issues;
    if (patch.runs !== undefined) {
      if (patch.runs.length === 0) delete current.runs;
      else current.runs = patch.runs;
    } else if ("runs" in patch) delete current.runs;
    if (patch.prUnlinked !== undefined) current.prUnlinked = patch.prUnlinked;
    else if ("prUnlinked" in patch) delete current.prUnlinked;
    if (patch.autoResolved !== undefined) current.autoResolved = patch.autoResolved;
    else if ("autoResolved" in patch) delete current.autoResolved;
    if (patch.resolvedCheckout !== undefined) current.resolvedCheckout = patch.resolvedCheckout;
    else if ("resolvedCheckout" in patch) delete current.resolvedCheckout;
    if (patch.lastTurnSnapshot !== undefined) current.lastTurnSnapshot = patch.lastTurnSnapshot;
    else if ("lastTurnSnapshot" in patch) delete current.lastTurnSnapshot;
    if (patch.subagent !== undefined) current.subagent = patch.subagent;
    const now = Date.now();
    current.updatedAt = now;
    if (patch.status !== undefined && patch.status !== previousStatus) {
      if (patch.status === "idle") current.idleSince = now;
      else if (previousStatus === "idle") delete current.idleSince;
      if (patch.status !== "resolved" && patch.status !== "archived") {
        delete current.autoResolved;
        delete current.resolvedCheckout;
      }
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

  revertStatus(id: string, previous: SessionStatusSnapshot, reason: SessionStatusReason): void {
    const current = this.getSession(id);
    if (!current) return;
    const from = current.status;
    current.status = previous.status;
    current.updatedAt = previous.updatedAt;
    if (previous.idleSince === undefined) delete current.idleSince;
    else current.idleSince = previous.idleSince;
    if (from !== previous.status) traceSessionStatus({ sessionId: id, driver: current.driver, from, to: previous.status, reason });
    this.persist();
  }

  replacePrLinksQuietly(id: string, prs: SessionPrLink[]): void {
    const current = this.getSession(id);
    if (!current) return;
    if (prs.length === 0) delete current.prs;
    else current.prs = prs;
    this.persist();
  }

  updateAutoFollowUp(id: string, update: (current: AutoFollowUpMeta | undefined) => AutoFollowUpMeta | undefined): boolean {
    const current = this.getSession(id);
    if (!current) return false;
    const next = normalizedAutoFollowUp(update(current.autoFollowUp));
    if (next?.turns === current.autoFollowUp?.turns && next?.paused === current.autoFollowUp?.paused) return false;
    if (next === undefined) delete current.autoFollowUp;
    else current.autoFollowUp = next;
    this.persist();
    return true;
  }

  expireHolding(id: string): SessionMeta | null {
    const session = this.getSession(id);
    if (!session || session.status !== "holding") return null;
    session.status = "idle";
    session.idleSince = Date.now();
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
