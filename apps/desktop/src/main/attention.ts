import type { AppTopicData } from "@cw-code/contracts";

export interface AttentionTopicState {
  status: "subscribing" | "ready" | "error";
  data: Partial<AppTopicData>;
}

export function shouldFlash(prevCount: number | null, nextCount: number, focused: boolean): boolean {
  return prevCount !== null && nextCount > prevCount && !focused;
}

export function attentionDescription(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 session needs you" : `${count} sessions need you`;
}

export function attentionCountOf(state: AttentionTopicState | undefined): number | null {
  if (state?.status !== "ready") return null;
  const count = state.data.attention?.count;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}
