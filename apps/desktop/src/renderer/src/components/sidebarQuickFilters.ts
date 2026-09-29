import type { SessionStatus } from "../cw.js";

export type QuickFilter = "all" | "running" | "pr" | "updated";

export const QUICK_FILTERS: readonly Exclude<QuickFilter, "all">[] = ["running", "pr", "updated"];

export interface QuickFilterFacts {
  status: SessionStatus;
  linkCount: number;
  prUpdated: boolean;
}

export function matchesQuickFilter(filter: QuickFilter, facts: QuickFilterFacts): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return facts.status === "working";
    case "pr":
      return facts.linkCount > 0;
    case "updated":
      return facts.prUpdated;
  }
}

export function quickFilterCounts(items: QuickFilterFacts[]): Record<Exclude<QuickFilter, "all">, number> {
  const counts = { running: 0, pr: 0, updated: 0 };
  for (const item of items) {
    if (item.status === "archived" || item.status === "resolved") continue;
    for (const filter of QUICK_FILTERS) if (matchesQuickFilter(filter, item)) counts[filter] += 1;
  }
  return counts;
}

export function toggleQuickFilter(current: QuickFilter, picked: Exclude<QuickFilter, "all">): QuickFilter {
  return current === picked ? "all" : picked;
}

export interface SessionSearchFields {
  title: string;
  project: string;
  branch: string | undefined;
}

export function matchesSessionQuery(query: string, fields: SessionSearchFields): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [fields.title, fields.project, fields.branch ?? ""].some((value) => value.toLowerCase().includes(needle));
}
