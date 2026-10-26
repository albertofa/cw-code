import type { SessionMeta, WorktreeCandidate } from "@cw-code/contracts";

export function worktreeCandidates(sessions: SessionMeta[]): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = [];
  const seenPaths = new Set<string>();
  const eligible = sessions
    .filter((s): s is SessionMeta & { worktreePath: string } => Boolean(s.worktreePath) && s.status !== "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of eligible) {
    if (seenPaths.has(s.worktreePath)) continue;
    seenPaths.add(s.worktreePath);
    candidates.push({ sessionId: s.id, title: s.title, branch: s.branch, worktreePath: s.worktreePath });
  }
  return candidates;
}
