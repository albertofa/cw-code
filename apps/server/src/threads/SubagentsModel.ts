import type { SessionMeta } from "@cw-code/contracts";
import { subagentSummary } from "../agent/subagentSummary.js";
import type { ThreadExtras } from "./ThreadService.js";

export interface SubagentsModelDeps {
  children(parentId: string): SessionMeta[];
  parentOf(sessionId: string): string | null;
  pendingRequests(sessionId: string): number;
  refresh(parentId: string): void;
}

export class SubagentsModel {
  constructor(private readonly deps: SubagentsModelDeps) {}

  extras(sessionId: string): ThreadExtras {
    return { subagents: this.deps.children(sessionId).map((child) => subagentSummary(child, this.deps.pendingRequests(child.id))) };
  }

  changed(sessionId: string): void {
    const parentId = this.deps.parentOf(sessionId);
    if (parentId !== null) this.deps.refresh(parentId);
  }
}
