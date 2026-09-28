import type { SessionStatus } from "@cw-code/contracts";

export const WORKING_SET_STATUSES: readonly SessionStatus[] = ["input-required", "working", "done", "holding"];

export function isWorkingSetStatus(status: SessionStatus): boolean {
  return WORKING_SET_STATUSES.includes(status);
}
