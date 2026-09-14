import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComposerPrefs, DriverKind, Project, SessionMeta } from "@cw-code/contracts";

interface StoreShape {
  projects: Project[];
  sessions: SessionMeta[];
}

export function normalizeRoot(rootPath: string): string {
  const stripped = rootPath.replace(/[\\/]+$/, "");
  return stripped || rootPath;
}

export class SessionStore {
  private filePath: string;
  private data: StoreShape;

  constructor(dbPath: string) {
    this.filePath = dbPath.endsWith(".db") ? `${dbPath}.json` : join(dbPath, "cw-code.json");
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.data = { projects: [], sessions: [] };
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreShape;
        if (Array.isArray(parsed.projects) && Array.isArray(parsed.sessions)) this.data = parsed;
      } catch {
        this.data = { projects: [], sessions: [] };
      }
    }
    let migrated = false;
    for (const project of this.data.projects) {
      const normalized = normalizeRoot(project.rootPath);
      if (normalized !== project.rootPath) {
        project.rootPath = normalized;
        migrated = true;
      }
      if (project.githubAccount) {
        const host = typeof project.githubAccount.host === "string" ? project.githubAccount.host.trim().toLowerCase() : "";
        const login = typeof project.githubAccount.login === "string" ? project.githubAccount.login.trim() : "";
        if (!host || !login) {
          delete project.githubAccount;
          migrated = true;
        } else if (host !== project.githubAccount.host || login !== project.githubAccount.login) {
          project.githubAccount = { host, login };
          migrated = true;
        }
      }
    }
    for (const session of this.data.sessions) {
      if (!session.status) {
        session.status = "idle";
        migrated = true;
      }
      if (!session.worktreePath) continue;
      const normalized = normalizeRoot(session.worktreePath);
      if (normalized !== session.worktreePath) {
        session.worktreePath = normalized;
        migrated = true;
      }
    }
    if (migrated) this.persist();
  }

  private persist(): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    renameSync(tmp, this.filePath);
  }

  addProject(rootPath: string): Project {
    const normalized = normalizeRoot(rootPath);
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
    patch: Partial<Pick<SessionMeta, "title" | "status" | "resumeCursor" | "model" | "effort" | "variant" | "permissionMode" | "worktreePath" | "branch">>
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
    current.updatedAt = Date.now();
    this.persist();
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
