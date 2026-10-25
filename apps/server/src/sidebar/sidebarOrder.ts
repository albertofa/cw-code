import type { SessionMeta, SidebarOrderPrefs, SidebarReorderRequest, SidebarSection } from "@cw-code/contracts";

export interface SidebarSectionIds {
  main: string[];
  resolved: string[];
}

export interface SidebarReorderResult {
  order: SidebarOrderPrefs;
  statusChange: "idle" | "resolved" | null;
}

export function mergeAwayIds(prev: string[], next: string[], away: Set<string>): string[] {
  const nextIndex = new Map(next.map((id, index) => [id, index]));
  const merged: string[] = [];
  let cursor = 0;
  for (const id of prev) {
    if (away.has(id)) {
      merged.push(id);
      continue;
    }
    const at = nextIndex.get(id);
    if (at === undefined) continue;
    while (cursor <= at) merged.push(next[cursor++]!);
  }
  while (cursor < next.length) merged.push(next[cursor++]!);
  return merged;
}

function orderByStored(current: SessionMeta[], ids: string[]): SessionMeta[] {
  const index = new Map(ids.map((id, i) => [id, i]));
  const known = current
    .filter((s) => index.has(s.id))
    .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  const unknown = current.filter((s) => !index.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  return [...known, ...unknown];
}

const byRecency = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt;

export function sidebarSections(
  sessions: SessionMeta[],
  order: SidebarOrderPrefs | null,
  awayIds: Set<string>
): { main: SessionMeta[]; resolved: SessionMeta[] } {
  const storedMain = (order?.main ?? []).filter((id) => !awayIds.has(id));
  const storedResolved = (order?.resolved ?? []).filter((id) => !awayIds.has(id));
  const pinned = new Set((order?.pinned ?? []).filter((id) => !awayIds.has(id)));
  const storedMainSet = new Set(storedMain);
  const storedResolvedSet = new Set(storedResolved);
  const effectiveSection = (s: SessionMeta): SidebarSection | null => {
    if (s.status === "archived") return null;
    if (pinned.has(s.id)) {
      const inMain = storedMainSet.has(s.id);
      const inResolved = storedResolvedSet.has(s.id);
      if (inMain !== inResolved) return inMain ? "main" : "resolved";
    }
    if (s.status === "resolved") return "resolved";
    return "main";
  };
  const main = sessions.filter((s) => !awayIds.has(s.id) && effectiveSection(s) === "main");
  const resolved = sessions.filter((s) => !awayIds.has(s.id) && effectiveSection(s) === "resolved");
  return {
    main: [...main].sort(byRecency),
    resolved: order ? orderByStored(resolved, storedResolved) : [...resolved].sort(byRecency)
  };
}

function insertRelativeTo(ids: string[], id: string, targetId: string | null, before: boolean): string[] {
  const index = targetId === null ? -1 : ids.indexOf(targetId);
  if (index === -1) return [...ids, id];
  const at = before ? index : index + 1;
  return [...ids.slice(0, at), id, ...ids.slice(at)];
}

export function reorderSidebar(
  order: SidebarOrderPrefs | null,
  sections: SidebarSectionIds,
  away: Set<string>,
  req: SidebarReorderRequest
): SidebarReorderResult {
  const known = sections.main.includes(req.sessionId) || sections.resolved.includes(req.sessionId);
  const droppedOnSelf = req.targetId === req.sessionId && req.from === req.to;
  if (!known || droppedOnSelf) {
    return { order: order ?? { main: sections.main, resolved: sections.resolved, pinned: [] }, statusChange: null };
  }

  const withoutMoving = (ids: string[]) => ids.filter((id) => id !== req.sessionId);
  const place = (section: SidebarSection, ids: string[]) =>
    req.to === section ? insertRelativeTo(withoutMoving(ids), req.sessionId, req.targetId, req.before) : withoutMoving(ids);
  const nextMain = place("main", sections.main);
  const nextResolved = place("resolved", sections.resolved);
  const cross = req.from !== req.to;
  const pinned = cross ? Array.from(new Set([...(order?.pinned ?? []), req.sessionId])) : [];
  const statusChange = !cross ? null : req.to === "resolved" ? "resolved" : "idle";
  return {
    order: {
      main: mergeAwayIds(order?.main ?? nextMain, nextMain, away),
      resolved: mergeAwayIds(order?.resolved ?? nextResolved, nextResolved, away),
      pinned
    },
    statusChange
  };
}
