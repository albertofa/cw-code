export interface RestoreCandidate {
  resumeCursor: string;
  title: string;
  updatedAt: number;
  claimed: boolean;
}

export const NEW_SESSION_TITLE = "New session";

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

export function pickRestoreCandidate(
  ownTitle: string,
  candidates: RestoreCandidate[]
): string | null {
  const unclaimed = candidates.filter((c) => !c.claimed && c.resumeCursor);
  if (unclaimed.length === 0) return null;
  const byRecent = [...unclaimed].sort((a, b) => b.updatedAt - a.updatedAt);
  const want = normalizeTitle(ownTitle);
  if (want) {
    const titled = byRecent.filter((c) => normalizeTitle(c.title) === want);
    if (titled.length > 0) return titled[0].resumeCursor;
  }
  if (normalizeTitle(ownTitle) === normalizeTitle(NEW_SESSION_TITLE)) return null;
  return byRecent[0].resumeCursor;
}
