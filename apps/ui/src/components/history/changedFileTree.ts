export type ChangedTreeRow =
  | { kind: "dir"; path: string; name: string; depth: number }
  | { kind: "file"; path: string; name: string; depth: number };

interface DirNode {
  dirs: Map<string, DirNode>;
  files: string[];
}

function emptyDir(): DirNode {
  return { dirs: new Map(), files: [] };
}

function insert(root: DirNode, path: string): void {
  const parts = path.split("/").filter((part) => part.length > 0);
  let node = root;
  for (const part of parts.slice(0, -1)) {
    let next = node.dirs.get(part);
    if (!next) {
      next = emptyDir();
      node.dirs.set(part, next);
    }
    node = next;
  }
  node.files.push(path);
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function changedFileTree(paths: readonly string[]): ChangedTreeRow[] {
  const root = emptyDir();
  for (const path of paths) insert(root, path);
  const rows: ChangedTreeRow[] = [];
  const walk = (node: DirNode, prefix: string, depth: number): void => {
    for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
      let label = name;
      let path = prefix ? `${prefix}/${name}` : name;
      let child = node.dirs.get(name) ?? emptyDir();
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [onlyName, only] = [...child.dirs][0] ?? [];
        if (onlyName === undefined || only === undefined) break;
        label = `${label}/${onlyName}`;
        path = `${path}/${onlyName}`;
        child = only;
      }
      rows.push({ kind: "dir", path, name: label, depth });
      walk(child, path, depth + 1);
    }
    for (const file of [...node.files].sort((a, b) => baseName(a).localeCompare(baseName(b)))) {
      rows.push({ kind: "file", path: file, name: baseName(file), depth });
    }
  };
  walk(root, "", 0);
  return rows;
}
