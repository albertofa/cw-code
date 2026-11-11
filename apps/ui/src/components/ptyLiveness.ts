/** Terminals this renderer has seen running, so closing one can warn before it ends an interactive CLI. */
const live = new Set<string>();

const keyOf = (sessionId: string, kind: string): string => `${sessionId}:${kind}`;

export function markPtyLive(sessionId: string, kind: string, alive: boolean): void {
  if (alive) live.add(keyOf(sessionId, kind));
  else live.delete(keyOf(sessionId, kind));
}

export function isPtyLive(sessionId: string, kind: string): boolean {
  return live.has(keyOf(sessionId, kind));
}
