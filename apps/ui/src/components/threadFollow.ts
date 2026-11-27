/**
 * Whether a scroll event on a thread that follows the end came from its content changing rather
 * than from the user moving the view. Content growing below a still viewport leaves the offset in
 * place (or moves it down with scroll anchoring); content shrinking clamps the offset down by at
 * most the amount it shrank. Any upward move beyond that is the user scrolling away.
 */
export function isContentDrift(topDelta: number, heightDelta: number): boolean {
  if (heightDelta === 0) return false;
  const shrink = Math.max(0, -heightDelta);
  return topDelta >= -(shrink + 1);
}
