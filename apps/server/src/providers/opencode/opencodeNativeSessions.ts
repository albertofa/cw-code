import type { NativeSession } from "@cw-code/contracts";

interface RawOpencodeSession {
  id?: unknown;
  directory?: unknown;
  title?: unknown;
  parentID?: unknown;
  time?: { created?: unknown; updated?: unknown; archived?: unknown };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function time(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function mapOpencodeNativeSessions(raw: unknown): NativeSession[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeSession[] = [];
  for (const item of raw as RawOpencodeSession[]) {
    if (!item || typeof item !== "object") continue;
    const id = text(item.id);
    const cwd = text(item.directory);
    if (!id || !cwd || text(item.parentID) || item.time?.archived) continue;
    const createdAt = time(item.time?.created);
    out.push({
      driver: "opencode",
      resumeCursor: id,
      title: text(item.title) || id.slice(0, 8),
      cwd,
      createdAt,
      updatedAt: time(item.time?.updated) || createdAt
    });
  }
  return out;
}

export function opencodeProjectWorktrees(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const worktrees = new Set<string>();
  for (const item of raw as Array<{ worktree?: unknown }>) {
    const worktree = text(item?.worktree);
    if (worktree && worktree !== "/") worktrees.add(worktree);
  }
  return [...worktrees];
}
