import type { Project, Session } from "../cw.js";

function lastActivity(sessions: Session[] | undefined): number {
  let latest = 0;
  for (const s of sessions ?? []) {
    if (s.updatedAt > latest) latest = s.updatedAt;
  }
  return latest;
}

export function projectsByRecentActivity(projects: Project[], sessionsByProject: Record<string, Session[]>): Project[] {
  return projects
    .map((project, index) => ({ project, index, at: lastActivity(sessionsByProject[project.id]) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.project);
}

export function defaultNewSessionProjectId(
  projects: Project[],
  sessionsByProject: Record<string, Session[]>,
  activeSessionId: string | null,
  projectFilter: string | "all"
): string | null {
  const known = new Set(projects.map((p) => p.id));
  if (activeSessionId) {
    const owner = Object.entries(sessionsByProject).find(([, list]) => list.some((s) => s.id === activeSessionId))?.[0];
    if (owner && known.has(owner)) return owner;
  }
  const filtered = concreteFilterId(projects, projectFilter);
  if (filtered) return filtered;
  return projectsByRecentActivity(projects, sessionsByProject)[0]?.id ?? null;
}

export function concreteFilterId(projects: Project[], projectFilter: string | "all"): string | null {
  return projectFilter !== "all" && projects.some((p) => p.id === projectFilter) ? projectFilter : null;
}

export function discoveryProjectId(projectFilter: string | "all", activeProjectId: string | null): string | null {
  return projectFilter !== "all" ? projectFilter : activeProjectId;
}

export function discoveredOwnerId(discoveredByProject: Record<string, Session[]>, session: Session): string {
  return Object.entries(discoveredByProject).find(([, list]) => list.some((d) => d.id === session.id))?.[0] ?? session.projectId;
}
