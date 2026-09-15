export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return total === 1 ? "1 second" : `${total} seconds`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${total % 60}s`;
}

export function durationFromMessages(messages: Array<{ timestamp?: number }>): number | undefined {
  if (messages.length === 0) return undefined;
  const first = messages[0].timestamp;
  const last = messages[messages.length - 1].timestamp;
  if (typeof first !== "number" || typeof last !== "number") return undefined;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
  const diff = last - first;
  return diff >= 0 ? diff : undefined;
}
