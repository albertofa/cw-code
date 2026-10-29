export type RevealMatch = { kind: "unique"; path: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "none" };

function normalize(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function pick(candidates: string[]): RevealMatch | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { kind: "unique", path: candidates[0] };
  return { kind: "ambiguous", candidates: [...candidates].sort((a, b) => a.length - b.length || a.localeCompare(b)) };
}

export function resolveRevealPath(requested: string, files: readonly string[]): RevealMatch {
  const path = normalize(requested);
  if (!path) return { kind: "none" };
  if (files.includes(path)) return { kind: "unique", path };
  const lower = path.toLowerCase();
  const name = baseName(lower);
  return (
    pick(files.filter((file) => file.endsWith(`/${path}`))) ??
    pick(files.filter((file) => file.toLowerCase() === lower || file.toLowerCase().endsWith(`/${lower}`))) ??
    pick(files.filter((file) => baseName(file).toLowerCase() === name)) ?? { kind: "none" }
  );
}
