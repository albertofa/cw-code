import type { SessionMeta } from "@cw-code/contracts";

export function sameWorktreePath(a: string, b: string): boolean {
  const left = a.replace(/[\\/]+$/, "");
  const right = b.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isWorktreeOrphaned(
  sessions: Array<Pick<SessionMeta, "id" | "worktreePath">>,
  worktreePath: string,
  excludeSessionId: string
): boolean {
  if (!worktreePath) return false;
  return !sessions.some(
    (s) => s.id !== excludeSessionId && s.worktreePath && sameWorktreePath(s.worktreePath, worktreePath)
  );
}

export function findStaleWorktreeDirs(
  sessions: Array<Pick<SessionMeta, "worktreePath">>,
  dirPaths: string[]
): string[] {
  return dirPaths.filter((dir) => !sessions.some((s) => s.worktreePath && sameWorktreePath(s.worktreePath, dir)));
}
