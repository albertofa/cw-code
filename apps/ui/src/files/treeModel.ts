import type { DirEntry } from "@cw-code/contracts";

export interface TreeRow {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
  loading: boolean;
  error: string | null;
}

export function flattenTree(
  childrenByDir: Record<string, DirEntry[]>,
  expanded: ReadonlySet<string>,
  loading: ReadonlySet<string>,
  errors: Record<string, string>
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of childrenByDir[dir] ?? []) {
      const isExpanded = entry.isDir && expanded.has(entry.path);
      rows.push({
        path: entry.path,
        name: entry.name,
        isDir: entry.isDir,
        depth,
        expanded: isExpanded,
        loading: isExpanded && loading.has(entry.path),
        error: isExpanded ? (errors[entry.path] ?? null) : null
      });
      if (isExpanded) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

export function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let index = path.indexOf("/");
  while (index >= 0) {
    ancestors.push(path.slice(0, index));
    index = path.indexOf("/", index + 1);
  }
  return ancestors;
}

export function rebasePath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return null;
}
