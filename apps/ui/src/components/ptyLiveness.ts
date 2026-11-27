/**
 * Terminals this renderer has seen running, so closing one can warn before it ends an interactive
 * CLI. Each entry holds the terminal's token once its open resolved (null while it spawns), so an
 * exit from an earlier terminal under the same id never clears a newer one.
 */
const live = new Map<string, string | null>();

const keyOf = (sessionId: string, kind: string): string => `${sessionId}:${kind}`;

export function markPtyLive(sessionId: string, kind: string, alive: boolean, token: string | null = null): void {
  if (alive) live.set(keyOf(sessionId, kind), token);
  else live.delete(keyOf(sessionId, kind));
}

export function isPtyLive(sessionId: string, kind: string): boolean {
  return live.has(keyOf(sessionId, kind));
}

/**
 * Clears a terminal when it exits, even while no tab shows it (another tab is active in its panel
 * or the panel is collapsed), so closing its tab later does not ask about a process that is gone.
 */
export function startPtyLivenessTracking(): () => void {
  return window.cw.onPtyExit(({ ptyId, token }) => {
    const known = live.get(ptyId);
    if (known === undefined) return;
    if (known === null || known === token) live.delete(ptyId);
  });
}
