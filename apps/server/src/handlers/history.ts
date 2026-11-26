import type { HistoryLog } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { parseAvatarAuthors } from "../history/HistoryAvatars.js";
import { comparableGitPath, isFullSha, parseHistoryLimit } from "../history/historyParsers.js";
import type { Router } from "../transport/Router.js";
import { handle, knownSessionId, parseArgs } from "./shared.js";

interface HistoryTarget {
  sessionId: string | null;
  root: string;
  worktree: string | null;
  owner: string | null;
  isMain: boolean;
}

type ScopeArgs = { sessionId: string } | { projectId: string };

function parseScope(args: Record<string, unknown>): ScopeArgs {
  const has = (value: unknown): boolean => typeof value === "string" && value.length > 0;
  if (has(args.sessionId) === has(args.projectId)) throw new Error("pass either sessionId or projectId");
  return has(args.sessionId) ? { sessionId: args.sessionId as string } : { projectId: args.projectId as string };
}

export function registerHistoryHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();

  const ownerOf = (path: string): string | null => services().sessions.checkoutOwner(path);

  const baseRoot = async (scope: ScopeArgs): Promise<string> => {
    const { sessions } = services();
    if ("projectId" in scope) return sessions.getProject(scope.projectId).rootPath;
    return (await sessions.sessionStatusContext(knownSessionId(sessions, scope.sessionId))).root;
  };

  const targetOf = async (args: Record<string, unknown>, withWorktree: boolean): Promise<HistoryTarget> => {
    const { sessions, history } = services();
    const scope = parseScope(args);
    const sessionId = "sessionId" in scope ? knownSessionId(sessions, scope.sessionId) : null;
    const root = await baseRoot(scope);
    const worktree = withWorktree ? args.worktree : undefined;
    if (worktree === undefined || worktree === null) {
      if (sessionId !== null) return { sessionId, root, worktree: null, owner: null, isMain: false };
      const wanted = comparableGitPath(root);
      const match = (await history.worktrees(root)).find((entry) => comparableGitPath(entry.path) === wanted);
      return { sessionId, root, worktree: root, owner: ownerOf(root), isMain: match ? match.isMain : true };
    }
    if (typeof worktree !== "string" || worktree.length === 0) throw new Error("worktree must be a path");
    const wanted = comparableGitPath(worktree);
    const match = (await history.worktrees(root)).find((entry) => comparableGitPath(entry.path) === wanted);
    if (!match) throw new Error(`${worktree} is not a worktree of this repository`);
    return { sessionId, root: match.path, worktree: match.path, owner: ownerOf(match.path), isMain: match.isMain };
  };

  const onUnowned = async <T>(target: HistoryTarget, run: () => Promise<T>, refuseDirtyMain = true): Promise<T> => {
    const { sessions, git } = services();
    return sessions.withUnownedCheckout(target.root, async () => {
      if (refuseDirtyMain && target.isMain && (await git.isWorkingTreeDirty(target.root))) {
        throw new Error("The main checkout has uncommitted changes — commit or stash them before switching branches or pulling");
      }
      return run();
    });
  };

  const routeAction = async (
    args: Record<string, unknown>,
    run: (root: string) => Promise<void>,
    refuseDirtyMain: boolean
  ): Promise<void> => {
    const target = await targetOf(args, true);
    const { sessions } = services();
    if (target.sessionId !== null && target.worktree === null) await sessions.runCheckoutAction(target.sessionId, run);
    else if (target.owner) await sessions.runCheckoutAction(target.owner, run);
    else await onUnowned(target, () => run(target.root), refuseDirtyMain);
  };

  const withOwners = (log: Omit<HistoryLog, "github">, github: HistoryLog["github"]): HistoryLog => ({
    ...log,
    github,
    worktrees: log.worktrees.map((entry) => ({ ...entry, sessionId: ownerOf(entry.path) }))
  });

  handle(router, "history.log", async (raw) => {
    const args = parseArgs(raw, "history.log");
    const limit = parseHistoryLimit(args.limit);
    const target = await targetOf(args, true);
    const { history } = services();
    const [log, wipCount, remote] = await Promise.all([
      history.log(target.root, limit),
      target.worktree === null ? Promise.resolve(null) : history.wipCount(target.root),
      services().git.githubRemote(target.root)
    ]);
    const github = remote && remote.host === "github.com" ? { owner: remote.owner, repo: remote.repository } : null;
    return { ...withOwners(log, github), wipCount };
  });
  handle(router, "history.commit", async (raw) => {
    const args = parseArgs(raw, "history.commit");
    if (!isFullSha(args.sha)) throw new Error("sha must be a full 40-character commit id");
    const target = await targetOf(args, false);
    return services().history.commit(target.root, args.sha);
  });
  handle(router, "history.avatars", async (raw) => {
    const args = parseArgs(raw, "history.avatars");
    const authors = parseAvatarAuthors(args.authors);
    const target = await targetOf(args, false);
    return services().historyAvatars.resolve(target.root, authors);
  });
  handle(router, "history.commitPulls", async (raw) => {
    const args = parseArgs(raw, "history.commitPulls");
    if (!isFullSha(args.sha)) throw new Error("sha must be a full 40-character commit id");
    const target = await targetOf(args, false);
    return services().commitPulls.resolve(target.root, args.sha);
  });
  handle(router, "history.pull", async (raw) => {
    const args = parseArgs(raw, "history.pull");
    const target = await targetOf(args, true);
    const { sessions, git } = services();
    if (target.sessionId !== null && target.worktree === null) await sessions.pullBranch(target.sessionId);
    else if (target.owner) await sessions.pullBranch(target.owner);
    else await onUnowned(target, () => git.pullFastForward(target.root));
  });
  handle(router, "history.checkout", async (raw) => {
    const args = parseArgs(raw, "history.checkout");
    const branch = args.branch;
    if (typeof branch !== "string" || branch.length === 0) throw new Error("branch must be a name");
    const target = await targetOf(args, true);
    const { sessions, git } = services();
    if (target.sessionId !== null && target.worktree === null) await sessions.switchBranch(target.sessionId, branch);
    else if (target.owner) await sessions.switchBranch(target.owner, branch);
    else await onUnowned(target, () => git.checkoutBranch(target.root, branch));
  });
  handle(router, "history.fetch", async (raw) => {
    const args = parseArgs(raw, "history.fetch");
    const { git } = services();
    await routeAction(args, (root) => git.fetchAll(root), false);
  });
  handle(router, "history.push", async (raw) => {
    const args = parseArgs(raw, "history.push");
    const { git } = services();
    await routeAction(args, (root) => git.push(root), false);
  });
  handle(router, "history.stash", async (raw) => {
    const args = parseArgs(raw, "history.stash");
    const message = args.message;
    if (message !== undefined && message !== null && typeof message !== "string") throw new Error("message must be text");
    const { git } = services();
    await routeAction(args, (root) => git.stashPush(root, message ?? undefined), false);
  });
  handle(router, "history.stashPop", async (raw) => {
    const args = parseArgs(raw, "history.stashPop");
    const { git } = services();
    await routeAction(args, (root) => git.stashPop(root), true);
  });
  handle(router, "history.branch", async (raw) => {
    const args = parseArgs(raw, "history.branch");
    const { name, sha, checkout } = args;
    if (typeof name !== "string" || name.length === 0) throw new Error("name must be a branch name");
    if (!isFullSha(sha)) throw new Error("sha must be a full 40-character commit id");
    if (typeof checkout !== "boolean") throw new Error("checkout must be true or false");
    const { git } = services();
    await routeAction(args, (root) => git.createBranch(root, name, sha, checkout), checkout);
  });
}
