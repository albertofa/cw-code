import type { GitFileDecoration, GitFileState } from "@cw-code/contracts";
import { ancestorsOf } from "./treeModel.js";

export type DecorationLookup = (
  path: string,
  isDir: boolean
) => { state: GitFileState; inherited: boolean } | null;

const PRIORITY: Record<GitFileState, number> = {
  conflict: 7,
  modified: 6,
  deleted: 5,
  renamed: 4,
  added: 3,
  untracked: 2,
  ignored: 1
};

function propagatesDown(state: GitFileState): boolean {
  return state === "ignored" || state === "untracked";
}

export function buildDecorationIndex(entries: GitFileDecoration[]): DecorationLookup {
  const direct = new Map<string, GitFileState>();
  const cascadingDirs = new Map<string, GitFileState>();
  const aggregate = new Map<string, GitFileState>();

  for (const entry of entries) {
    direct.set(entry.path, entry.state);
    if (entry.isDir && propagatesDown(entry.state)) cascadingDirs.set(entry.path, entry.state);
    if (entry.state === "ignored") continue;
    for (const ancestor of ancestorsOf(entry.path)) {
      const current = aggregate.get(ancestor);
      if (!current || PRIORITY[entry.state] > PRIORITY[current]) aggregate.set(ancestor, entry.state);
    }
  }

  return (path, isDir) => {
    const own = direct.get(path);
    if (own) return { state: own, inherited: false };
    if (cascadingDirs.size > 0) {
      const ancestors = ancestorsOf(path);
      for (let index = ancestors.length - 1; index >= 0; index--) {
        const state = cascadingDirs.get(ancestors[index]);
        if (state) return { state, inherited: true };
      }
    }
    if (!isDir) return null;
    const state = aggregate.get(path);
    return state ? { state, inherited: true } : null;
  };
}
