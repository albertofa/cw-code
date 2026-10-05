export function durationFromMessages(messages: Array<{ timestamp?: number }>): number | undefined {
  if (messages.length < 2) return undefined;
  const first = messages[0].timestamp;
  const last = messages[messages.length - 1].timestamp;
  if (typeof first !== "number" || typeof last !== "number") return undefined;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
  const diff = last - first;
  return diff >= 0 ? diff : undefined;
}
