import type { SessionMeta, WorktreeCandidate } from "@cw-code/contracts";

/**
 * Worktrees the "Previous worktree" picker may offer: only checkouts cw-code created.
 * Imported sessions can point at another tool's worktree, which cw-code never reuses.
 */
export function worktreeCandidates(sessions: SessionMeta[], owned: (path: string) => boolean): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = [];
  const seenPaths = new Set<string>();
  const eligible = sessions
    .filter((s): s is SessionMeta & { worktreePath: string } => isOwnedWorktree(s, owned))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of eligible) {
    if (seenPaths.has(s.worktreePath)) continue;
    seenPaths.add(s.worktreePath);
    candidates.push({ sessionId: s.id, title: s.title, branch: s.branch, worktreePath: s.worktreePath });
  }
  return candidates;
}

function isOwnedWorktree(session: SessionMeta, owned: (path: string) => boolean): session is SessionMeta & { worktreePath: string } {
  const path = session.worktreePath;
  return path !== undefined && path !== "" && session.status !== "archived" && owned(path);
}
