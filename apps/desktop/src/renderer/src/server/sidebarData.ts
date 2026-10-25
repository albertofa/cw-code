import type { Project, SessionRow } from "@cw-code/contracts";
import type { Session } from "../cw.js";

const ROW_PREFIX = "row/";
const PROJECT_PREFIX = "project/";

export function rowKey(sessionId: string): `row/${string}` {
  return `${ROW_PREFIX}${sessionId}`;
}

export function worktreesKey(projectId: string): `worktrees/${string}` {
  return `worktrees/${projectId}`;
}

function entriesWithPrefix<T>(data: Record<string, unknown>, prefix: string): T[] {
  const entries: T[] = [];
  for (const [key, value] of Object.entries(data)) if (key.startsWith(prefix)) entries.push(value as T);
  return entries;
}

export function sidebarRows(data: Record<string, unknown>): SessionRow[] {
  return entriesWithPrefix<SessionRow>(data, ROW_PREFIX);
}

export function sidebarProjects(data: Record<string, unknown>): Project[] {
  return entriesWithPrefix<Project>(data, PROJECT_PREFIX).sort((a, b) => a.name.localeCompare(b.name));
}

export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function findSession(sessionsByProject: Record<string, Session[]>, sessionId: string): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    const found = list.find((item) => item.id === sessionId);
    if (found) return found;
  }
  return undefined;
}

function reuseSession(before: Session | undefined, next: Session): Session {
  if (!before || before === next) return next;
  return JSON.stringify(before) === JSON.stringify(next) ? before : next;
}

export function sessionsByProjectOf(
  projects: readonly Project[],
  rows: readonly SessionRow[],
  previous: Record<string, Session[]>
): Record<string, Session[]> {
  const known = new Map<string, Session>();
  for (const list of Object.values(previous)) for (const session of list) known.set(session.id, session);
  const grouped: Record<string, Session[]> = {};
  for (const project of projects) grouped[project.id] = [];
  for (const row of rows) (grouped[row.session.projectId] ??= []).push(reuseSession(known.get(row.session.id), row.session));
  const next: Record<string, Session[]> = {};
  let changed = Object.keys(previous).length !== Object.keys(grouped).length;
  for (const [projectId, sessions] of Object.entries(grouped)) {
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    const before = previous[projectId];
    if (before && sameItems(before, sessions)) {
      next[projectId] = before;
      continue;
    }
    next[projectId] = sessions;
    changed = true;
  }
  return changed ? next : previous;
}
