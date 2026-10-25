import type { WorktreeCandidate } from "@cw-code/contracts";
import type { Session } from "../cw.js";

export type { WorktreeCandidate };

export function worktreeCandidates(sessions: Session[]): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = [];
  const seenPaths = new Set<string>();
  const eligible = sessions
    .filter((s): s is Session & { worktreePath: string } => Boolean(s.worktreePath) && s.status !== "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of eligible) {
    if (seenPaths.has(s.worktreePath)) continue;
    seenPaths.add(s.worktreePath);
    candidates.push({ sessionId: s.id, title: s.title, branch: s.branch, worktreePath: s.worktreePath });
  }
  return candidates;
}
