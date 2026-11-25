import type { HistoryLog } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { parseAvatarAuthors } from "../history/HistoryAvatars.js";
import { comparableGitPath, isFullSha, parseHistoryLimit } from "../history/historyParsers.js";
import type { Router } from "../transport/Router.js";
import { handle, knownSessionId, parseArgs } from "./shared.js";

interface HistoryTarget {
  sessionId: string;
  root: string;
  worktree: string | null;
  owner: string | null;
}

export function registerHistoryHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();

  const ownerOf = (path: string): string | null => {
    const wanted = comparableGitPath(path);
    const owner = services()
      .sessions.listAllSessions()
      .find((session) => session.status !== "archived" && session.worktreePath && comparableGitPath(session.worktreePath) === wanted);
    return owner?.id ?? null;
  };

  const targetOf = async (sessionId: unknown, worktree: unknown): Promise<HistoryTarget> => {
    const { sessions, history } = services();
    const id = knownSessionId(sessions, sessionId);
    const root = (await sessions.sessionStatusContext(id)).root;
    if (worktree === undefined || worktree === null) return { sessionId: id, root, worktree: null, owner: null };
    if (typeof worktree !== "string" || worktree.length === 0) throw new Error("worktree must be a path");
    const wanted = comparableGitPath(worktree);
    const match = (await history.worktrees(root)).find((entry) => comparableGitPath(entry.path) === wanted);
    if (!match) throw new Error(`${worktree} is not a worktree of this repository`);
    return { sessionId: id, root: match.path, worktree: match.path, owner: ownerOf(match.path) };
  };

  const withOwners = (log: HistoryLog): HistoryLog => ({
    ...log,
    worktrees: log.worktrees.map((entry) => ({ ...entry, sessionId: ownerOf(entry.path) }))
  });

  handle(router, "history.log", async (raw) => {
    const args = parseArgs(raw, "history.log");
    const limit = parseHistoryLimit(args.limit);
    const target = await targetOf(args.sessionId, args.worktree);
    const { history } = services();
    const [log, wipCount] = await Promise.all([
      history.log(target.root, limit),
      target.worktree === null ? Promise.resolve(null) : history.wipCount(target.root)
    ]);
    return { ...withOwners(log), wipCount };
  });
  handle(router, "history.commit", async (raw) => {
    const args = parseArgs(raw, "history.commit");
    if (!isFullSha(args.sha)) throw new Error("sha must be a full 40-character commit id");
    const target = await targetOf(args.sessionId, undefined);
    return services().history.commit(target.root, args.sha);
  });
  handle(router, "history.avatars", async (raw) => {
    const args = parseArgs(raw, "history.avatars");
    const authors = parseAvatarAuthors(args.authors);
    const target = await targetOf(args.sessionId, undefined);
    return services().historyAvatars.resolve(target.root, authors);
  });
  handle(router, "history.pull", async (raw) => {
    const args = parseArgs(raw, "history.pull");
    const target = await targetOf(args.sessionId, args.worktree);
    const { sessions, git } = services();
    if (target.worktree === null) await sessions.pullBranch(target.sessionId);
    else if (target.owner) await sessions.pullBranch(target.owner);
    else await git.pullFastForward(target.root);
  });
  handle(router, "history.checkout", async (raw) => {
    const args = parseArgs(raw, "history.checkout");
    if (typeof args.branch !== "string" || args.branch.length === 0) throw new Error("branch must be a name");
    const target = await targetOf(args.sessionId, args.worktree);
    const { sessions, git } = services();
    if (target.worktree === null) await sessions.switchBranch(target.sessionId, args.branch);
    else if (target.owner) await sessions.switchBranch(target.owner, args.branch);
    else await git.checkoutBranch(target.root, args.branch);
  });
}
