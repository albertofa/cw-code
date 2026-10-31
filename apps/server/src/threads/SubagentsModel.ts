import type { SessionMeta } from "@cw-code/contracts";
import { subagentSummary } from "../agent/subagentSummary.js";
import type { ThreadExtras } from "./ThreadService.js";

export interface SubagentsModelDeps {
  children(parentId: string): SessionMeta[];
  parentOf(sessionId: string): string | null;
  pendingRequests(sessionId: string): number;
  turnStartedAt(sessionId: string): number | undefined;
  waitSince(parentId: string): number | null;
  refresh(parentId: string): void;
}

export class SubagentsModel {
  constructor(private readonly deps: SubagentsModelDeps) {}

  extras(sessionId: string): ThreadExtras {
    const since = this.deps.waitSince(sessionId);
    return {
      subagents: this.deps.children(sessionId).map((child) => subagentSummary(child, this.deps.pendingRequests(child.id), this.deps.turnStartedAt(child.id))),
      subagentWait: since === null ? null : { since }
    };
  }

  changed(sessionId: string): void {
    const parentId = this.deps.parentOf(sessionId);
    if (parentId !== null) this.deps.refresh(parentId);
  }

  waitChanged(parentId: string): void {
    this.deps.refresh(parentId);
  }
}
