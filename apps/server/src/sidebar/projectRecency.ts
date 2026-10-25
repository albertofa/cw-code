import type { Project, SessionMeta } from "@cw-code/contracts";

function lastActivity(sessions: SessionMeta[] | undefined): number {
  let latest = 0;
  for (const s of sessions ?? []) {
    if (s.updatedAt > latest) latest = s.updatedAt;
  }
  return latest;
}

export function projectsByRecentActivity(projects: Project[], sessionsByProject: Record<string, SessionMeta[]>): Project[] {
  return projects
    .map((project, index) => ({ project, index, at: lastActivity(sessionsByProject[project.id]) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.project);
}

export function defaultNewSessionProjectId(
  projects: Project[],
  sessionsByProject: Record<string, SessionMeta[]>,
  activeSessionId: string | null
): string | null {
  const known = new Set(projects.map((p) => p.id));
  if (activeSessionId) {
    const owner = Object.entries(sessionsByProject).find(([, list]) => list.some((s) => s.id === activeSessionId))?.[0];
    if (owner && known.has(owner)) return owner;
  }
  return projectsByRecentActivity(projects, sessionsByProject)[0]?.id ?? null;
}
