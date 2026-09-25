import type { SessionStatus } from "../cw.js";

export type QuickFilter = "all" | "running" | "input" | "pr" | "updated";

export const QUICK_FILTERS: readonly Exclude<QuickFilter, "all">[] = ["running", "input", "pr", "updated"];

export interface QuickFilterFacts {
  status: SessionStatus;
  linkCount: number;
  unseen: boolean;
}

export function matchesQuickFilter(filter: QuickFilter, facts: QuickFilterFacts): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return facts.status === "working";
    case "input":
      return facts.status === "input-required";
    case "pr":
      return facts.linkCount > 0;
    case "updated":
      return facts.unseen;
  }
}

export function quickFilterCounts(items: QuickFilterFacts[]): Record<Exclude<QuickFilter, "all">, number> {
  const counts = { running: 0, input: 0, pr: 0, updated: 0 };
  for (const item of items) {
    if (item.status === "archived") continue;
    for (const filter of QUICK_FILTERS) if (matchesQuickFilter(filter, item)) counts[filter] += 1;
  }
  return counts;
}

export function toggleQuickFilter(current: QuickFilter, picked: Exclude<QuickFilter, "all">): QuickFilter {
  return current === picked ? "all" : picked;
}
