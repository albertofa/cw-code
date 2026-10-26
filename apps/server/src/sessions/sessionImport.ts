import { basename, sep } from "node:path";
import type { DriverKind, ImportableSession, NativeSession, Project, SessionMeta } from "@cw-code/contracts";
import { parseGitHubRemote, type WorktreeProject } from "../fs/GitService.js";
import { comparableRoot } from "./worktreeCleanup.js";

export function nativeSessionKey(driver: DriverKind, resumeCursor: string): string {
  return `${driver}:${resumeCursor}`;
}

export function claimedSessionKeys(sessions: SessionMeta[]): Set<string> {
  return new Set(sessions.filter((s) => s.resumeCursor).map((s) => nativeSessionKey(s.driver, s.resumeCursor)));
}

export function projectForCwd(projects: Project[], cwd: string): Project | undefined {
  const key = comparableRoot(cwd);
  return projects.find((project) => comparableRoot(project.rootPath) === key);
}

function insideAny(path: string, roots: string[]): boolean {
  const key = comparableRoot(path);
  return roots.some((root) => {
    const rootKey = comparableRoot(root);
    return key === rootKey || key.startsWith(`${rootKey}${sep}`);
  });
}

/** A cw-code session whose harness cursor is not stored yet: a turn is running, or one ran without reporting a cursor. */
export interface PendingClaim {
  driver: DriverKind;
  root: string;
  since: number;
}

const PENDING_CLAIM_SLACK_MS = 60_000;

export interface ImportContext {
  claimed: Set<string>;
  pending: PendingClaim[];
  /** Folders cw-code owns (worktrees, internal title turns); sessions there were started by cw-code. */
  appRoots: string[];
}

function pendingClaimOf(session: NativeSession, pending: PendingClaim[]): boolean {
  const key = comparableRoot(session.cwd);
  return pending.some(
    (claim) => claim.driver === session.driver && comparableRoot(claim.root) === key && session.createdAt >= claim.since - PENDING_CLAIM_SLACK_MS
  );
}

/** Native sessions the importer may offer: not managed by cw-code and not started by it, newest first. */
export function importableSessions(native: NativeSession[], ctx: ImportContext): NativeSession[] {
  const seen = new Set<string>();
  const out: NativeSession[] = [];
  for (const session of native) {
    const key = nativeSessionKey(session.driver, session.resumeCursor);
    if (seen.has(key) || ctx.claimed.has(key) || session.createdByCwCode || !session.cwd) continue;
    if (insideAny(session.cwd, ctx.appRoots) || pendingClaimOf(session, ctx.pending)) continue;
    seen.add(key);
    out.push(session);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Annotate sessions with the project they would join, using the main checkout behind a linked worktree. */
export function withProjects(
  sessions: NativeSession[],
  projects: Project[],
  worktrees: Map<string, WorktreeProject>
): ImportableSession[] {
  return sessions.map((session) => {
    const projectRoot = worktrees.get(comparableRoot(session.cwd))?.projectRoot ?? session.cwd;
    const project = projectForCwd(projects, projectRoot);
    const repository = session.gitRemote ? parseGitHubRemote(session.gitRemote)?.slug : undefined;
    return {
      ...session,
      projectRoot,
      projectName: project?.name ?? (basename(projectRoot) || projectRoot),
      ...(project ? { projectId: project.id } : {}),
      ...(repository ? { repository } : {})
    };
  });
}

export function withRepositories(sessions: ImportableSession[], remotes: Map<string, string | null>): ImportableSession[] {
  return sessions.map((session) => {
    if (session.repository) return session;
    const repository = remotes.get(comparableRoot(session.cwd));
    return repository ? { ...session, repository } : session;
  });
}
