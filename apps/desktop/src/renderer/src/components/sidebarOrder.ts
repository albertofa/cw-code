export function mergeAwayIds(prev: string[], next: string[], away: Set<string>): string[] {
  const nextIndex = new Map(next.map((id, index) => [id, index]));
  const merged: string[] = [];
  let cursor = 0;
  for (const id of prev) {
    if (away.has(id)) {
      merged.push(id);
      continue;
    }
    const at = nextIndex.get(id);
    if (at === undefined) continue;
    while (cursor <= at) merged.push(next[cursor++]);
  }
  while (cursor < next.length) merged.push(next[cursor++]);
  return merged;
}
