import type { BabysitState, PrChip } from "./pullRequests.js";
import type { Project, SessionMeta } from "./session.js";

export type AttentionKind = "approval" | "question" | "update";

export interface Attention {
  kind: AttentionKind;
  line: string;
}

export type NeedsYouSlot = AttentionKind | "done" | "running";

export interface SessionRow {
  session: SessionMeta;
  busy: boolean;
  branch: string | null;
  attention: Attention | null;
  babysit: BabysitState | null;
  prBadge: { chip: PrChip; title: string; linkCount: number } | null;
  pendingQuestionIds: string[];
  latestUnseenPrUpdateAt: number | null;
  prMuted: boolean;
}

export interface SidebarLayout {
  needsYou: Array<{ sessionId: string; slot: NeedsYouSlot }>;
  workingSet: string[];
  main: string[];
  resolved: string[];
  quickCounts: { pr: number };
}

export interface SidebarDefaults {
  restoreSessionId: string | null;
  restoreProjectId: string | null;
  projectsByRecency: string[];
}

export interface WorktreeCandidate {
  sessionId: string;
  title: string;
  branch?: string;
  worktreePath: string;
}

export type SidebarTopicData = { layout: SidebarLayout; defaults: SidebarDefaults }
  & { [key: `project/${string}`]: Project }
  & { [key: `row/${string}`]: SessionRow }
  & { [key: `worktrees/${string}`]: WorktreeCandidate[] };

export type SidebarSection = "main" | "resolved";

export interface SidebarReorderRequest {
  sessionId: string;
  from: SidebarSection;
  to: SidebarSection;
  targetId: string | null;
  before: boolean;
}

export interface SidebarOrderPrefs {
  main: string[];
  resolved: string[];
  pinned: string[];
}
