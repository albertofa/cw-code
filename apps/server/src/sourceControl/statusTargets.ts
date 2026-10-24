export interface StatusCandidate {
  id: string;
  projectId: string;
  baseRef?: string;
  rootKey: string | null;
  active: boolean;
}

export interface StatusGroup {
  projectId: string;
  baseRef?: string;
  sessionIds: string[];
}

export function statusGroupsForRoot(candidates: StatusCandidate[], rootKey: string, requested: ReadonlySet<string>): StatusGroup[] {
  const groups = new Map<string, StatusGroup>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    const onRoot = candidate.active && candidate.rootKey === rootKey;
    if (!onRoot && !requested.has(candidate.id)) continue;
    seen.add(candidate.id);
    const baseRef = candidate.baseRef?.trim() || undefined;
    const key = `${candidate.projectId}\u0000${baseRef ?? ""}`;
    const group = groups.get(key) ?? { projectId: candidate.projectId, ...(baseRef ? { baseRef } : {}), sessionIds: [] };
    group.sessionIds.push(candidate.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}
