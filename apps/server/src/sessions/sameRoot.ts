import type { Project, SessionMeta, TurnSnapshot } from "@cw-code/contracts";

const PROMPT_CLOCK_TOLERANCE_MS = 1000;

export interface ThreadTurnRef {
  turnId: string;
  running: boolean;
  promptedAt?: number;
}

export function snapshotTurnMatches(turn: ThreadTurnRef | undefined, snapshot: TurnSnapshot | undefined): boolean {
  if (!turn || !snapshot || turn.running) return false;
  if (turn.turnId === snapshot.turnId) return true;
  if (turn.promptedAt === undefined || snapshot.endedAt === undefined) return false;
  return turn.promptedAt >= snapshot.capturedAt - PROMPT_CLOCK_TOLERANCE_MS && turn.promptedAt <= snapshot.endedAt;
}

function rootKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

export function sameRootSessionIds(
  sessionsByProject: Record<string, SessionMeta[]>,
  projects: Project[],
  sessionId: string
): string[] {
  const rootOf = (session: SessionMeta) => session.worktreePath ?? projects.find((project) => project.id === session.projectId)?.rootPath;
  const sessions = Object.values(sessionsByProject).flat();
  const current = sessions.find((session) => session.id === sessionId);
  const root = current ? rootOf(current) : undefined;
  if (!root) return [sessionId];
  const key = rootKey(root);
  return sessions
    .filter((session) => {
      if (session.id === sessionId) return true;
      const other = rootOf(session);
      return other !== undefined && rootKey(other) === key;
    })
    .map((session) => session.id);
}
