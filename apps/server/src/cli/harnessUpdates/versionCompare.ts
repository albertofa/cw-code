const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

export function compareVersions(a: string, b: string): number {
  const left = a.match(SEMVER_RE);
  const right = b.match(SEMVER_RE);
  if (!left || !right) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isBehind(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}
