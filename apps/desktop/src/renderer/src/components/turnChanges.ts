import type { TurnFileChange, TurnSnapshot } from "../cw.js";

export interface ThreadTurnRef {
  turnId: string;
  running: boolean;
  promptedAt?: number;
}

export function snapshotTurnMatches(turn: ThreadTurnRef | undefined, snapshot: TurnSnapshot | undefined): boolean {
  if (!turn || !snapshot || turn.running) return false;
  if (turn.turnId === snapshot.turnId) return true;
  if (turn.promptedAt === undefined || snapshot.endedAt === undefined) return false;
  return turn.promptedAt >= snapshot.capturedAt && turn.promptedAt <= snapshot.endedAt;
}

export function snapshotKey(snapshot: TurnSnapshot | undefined): string {
  if (!snapshot) return "";
  return [
    snapshot.turnId,
    snapshot.sha ?? "",
    snapshot.error ?? "",
    snapshot.endSha ?? "",
    snapshot.endError ?? "",
    snapshot.endedAt ?? "",
    snapshot.undoneAt ?? ""
  ].join("|");
}

export function splitRepoPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  return index >= 0 ? { dir: path.slice(0, index + 1), name: path.slice(index + 1) } : { dir: "", name: path };
}

export function turnTotals(files: TurnFileChange[]): { added: number; deleted: number } {
  return files.reduce(
    (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
    { added: 0, deleted: 0 }
  );
}
