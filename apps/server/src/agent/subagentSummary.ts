import type { SessionMeta, SubagentSummary } from "@cw-code/contracts";

export function subagentSummary(child: SessionMeta, pendingRequests: number): SubagentSummary {
  return {
    id: child.id,
    driver: child.driver,
    title: child.title,
    status: child.status,
    ...(child.model ? { model: child.model } : {}),
    isolation: child.subagent?.isolation ?? "shared",
    ...(child.subagent?.result ? { result: child.subagent.result } : {}),
    pendingRequests,
    createdAt: child.createdAt,
    updatedAt: child.updatedAt
  };
}
