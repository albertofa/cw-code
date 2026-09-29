import type { AttentionState } from "@cw-code/contracts";

export const MAX_BADGE_DATA_URL_LENGTH = 64 * 1024;
export const MAX_ATTENTION_COUNT = 9999;

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export function shouldFlash(prevCount: number | null, nextCount: number, focused: boolean): boolean {
  return prevCount !== null && nextCount > prevCount && !focused;
}

export function attentionDescription(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 session needs you" : `${count} sessions need you`;
}

export function parseAttentionState(value: unknown): AttentionState | null {
  if (typeof value !== "object" || value === null) return null;
  const { count, badgeDataUrl } = value as { count?: unknown; badgeDataUrl?: unknown };
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_ATTENTION_COUNT) return null;
  if (badgeDataUrl === null) return { count, badgeDataUrl };
  if (typeof badgeDataUrl !== "string") return null;
  if (!badgeDataUrl.startsWith(PNG_DATA_URL_PREFIX) || badgeDataUrl.length > MAX_BADGE_DATA_URL_LENGTH) return null;
  return { count, badgeDataUrl: count === 0 ? null : badgeDataUrl };
}
