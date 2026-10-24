import type { GitDiffMode } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { GitService } from "../fs/GitService.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs, parseString } from "./shared.js";

async function sessionDiffBase(sessions: SessionManager, git: GitService, sessionId: string): Promise<string | undefined> {
  const { root, baseRef } = await sessions.sessionStatusContext(sessionId);
  if (!baseRef) return undefined;
  try {
    const branches = await git.branches(root);
    return branches.some((branch) => branch.name === baseRef) ? baseRef : undefined;
  } catch (error) {
    console.warn(`[source-control] could not list branches for ${root}: ${(error as Error).message}`);
    return undefined;
  }
}

export function registerGitHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  handle(router, "git.status", async (raw) => {
    const { sourceControl } = services();
    const sessionId = parseString(parseArgs(raw, "git.status").sessionId, "sessionId");
    await sourceControl.refresh(sessionId, { forcePullRequest: false });
    const status = sourceControl.status(sessionId);
    if (!status) throw new Error(sourceControl.failure(sessionId) ?? `git status is not available for session ${sessionId}`);
    return status;
  });
  handle<{ sessionId: string }>(router, "git.branches", (args) => {
    const { sessions, git } = services();
    return sessions.ensureWorktree(args.sessionId).then((root) => git.branches(root));
  });
  handle<{ projectId: string }>(router, "git.projectBranches", (args) => {
    const { sessions, git } = services();
    return git.branches(sessions.rootForProject(args.projectId));
  });
  handle<{ sessionId: string; branch: string }>(router, "git.switchBranch", async (args) => {
    const { sessions, sourceControl } = services();
    const result = await sessions.switchBranch(args.sessionId, args.branch);
    void sourceControl.refresh(args.sessionId, { forcePullRequest: true });
    return result;
  });
  handle<{ sessionId: string; mode: GitDiffMode; baseRef?: string }>(router, "git.diff", async (args) => {
    const { sessions, git } = services();
    const root = await sessions.ensureWorktree(args.sessionId);
    if (args.mode === "branch" && !args.baseRef) return git.diff(root, "branch", await sessionDiffBase(sessions, git, args.sessionId));
    if (args.mode !== "turn") return git.diff(root, args.mode, args.baseRef);
    const range = await sessions.turnDiffRange(args.sessionId);
    return git.diff(root, "turn", range.base, range.head);
  });
  handle<{ sessionId: string }>(router, "git.turnChanges", (args) => services().sessions.turnChanges(args.sessionId));
  handle<{ sessionId: string; turnId: string; expectedEndSha: string }>(router, "git.undoTurn", async (args) => {
    if (typeof args.turnId !== "string" || !args.turnId) throw new Error("invalid turnId");
    if (typeof args.expectedEndSha !== "string" || !args.expectedEndSha) throw new Error("invalid expectedEndSha");
    const { sessions, sourceControl } = services();
    const result = await sessions.undoTurn(args.sessionId, args.turnId, args.expectedEndSha);
    void sourceControl.refresh(args.sessionId, { forcePullRequest: true });
    return result;
  });
  handle<{ projectId?: string }>(router, "git.health", (args) => {
    const { sessions, git } = services();
    if (!args.projectId) return git.health();
    const project = sessions.getProject(args.projectId);
    return git.health(project.rootPath, project);
  });
  handle<{ projectId: string; account: { host: string; login: string } | null }>(router, "git.setProjectAccount", (args) => {
    const { sessions, sourceControl } = services();
    const project = sessions.setProjectGitHubAccount(args.projectId, args.account);
    for (const session of sessions.listAllSessions()) {
      if (session.projectId === project.id && session.status !== "resolved" && session.status !== "archived") {
        void sourceControl.refresh(session.id, { forcePullRequest: true });
      }
    }
    return project;
  });
  handle<{ projectId: string; name: string; email: string }>(router, "git.setIdentity", (args) => {
    const { sessions, git } = services();
    return git.setRepositoryIdentity(sessions.rootForProject(args.projectId), args.name, args.email);
  });
}
