import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionMeta } from "@cw-code/contracts";

export function sameWorktreePath(a: string, b: string): boolean {
  const left = resolve(a).replace(/[\\/]+$/, "");
  const right = resolve(b).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function looksLikeWorktree(dirPath: string): boolean {
  try {
    return statSync(join(dirPath, ".git")).isFile();
  } catch {
    return false;
  }
}

export function pinsWorktree(session: Pick<SessionMeta, "status">): boolean {
  return session.status !== "resolved" && session.status !== "archived";
}

export function isWorktreeOrphaned(
  sessions: Array<Pick<SessionMeta, "id" | "worktreePath" | "status">>,
  worktreePath: string,
  excludeSessionId: string
): boolean {
  if (!worktreePath) return false;
  return !sessions.some(
    (s) => s.id !== excludeSessionId && pinsWorktree(s) && s.worktreePath && sameWorktreePath(s.worktreePath, worktreePath)
  );
}

export function findStaleWorktreeDirs(
  sessions: Array<Pick<SessionMeta, "id" | "worktreePath" | "status">>,
  dirPaths: string[]
): string[] {
  return dirPaths.filter((dir) => !sessions.some((s) => pinsWorktree(s) && s.worktreePath && sameWorktreePath(s.worktreePath, dir)));
}
