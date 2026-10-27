import type { DirectoryEntry, DirectoryListing, DirectoryRoot } from "@cw-code/contracts";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const DIRECTORY_ENTRY_CAP = 2_000;

interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface BrowseOptions {
  showHidden?: boolean;
  platform?: NodeJS.Platform;
  home?: string;
  cap?: number;
  readdir?: (path: string) => Promise<DirentLike[]>;
  stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
  exists?: (path: string) => boolean;
}

const DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function readDirents(path: string): Promise<DirentLike[]> {
  return readdir(path, { withFileTypes: true });
}

function pathModule(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function listRoots(home: string, platform: NodeJS.Platform, exists: (path: string) => boolean): DirectoryRoot[] {
  const roots: DirectoryRoot[] = [{ label: "Home", path: home }];
  if (platform !== "win32") return [...roots, { label: "/", path: "/" }];
  for (const letter of DRIVE_LETTERS) {
    const drive = `${letter}:\\`;
    if (exists(drive)) roots.push({ label: `${letter}:`, path: drive });
  }
  return roots;
}

function browseError(error: unknown, path: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new Error(`folder not found on the server: ${path}`);
  if (code === "EACCES" || code === "EPERM") return new Error(`permission denied: ${path}`);
  return error instanceof Error ? error : new Error(String(error));
}

async function isDirectoryEntry(entry: DirentLike, fullPath: string, statPath: NonNullable<BrowseOptions["stat"]>): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await statPath(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

export async function browseDirectories(path: string | null, options: BrowseOptions = {}): Promise<DirectoryListing> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;
  const cap = options.cap ?? DIRECTORY_ENTRY_CAP;
  const fs = pathModule(platform);
  const target = path === null ? home : path;
  if (!fs.isAbsolute(target)) throw new Error(`folder not found on the server: ${target}`);
  const current = fs.resolve(target);
  let dirents: DirentLike[];
  try {
    dirents = await (options.readdir ?? readDirents)(current);
  } catch (error) {
    throw browseError(error, current);
  }
  const statPath = options.stat ?? stat;
  const directories: Array<{ name: string; path: string }> = [];
  for (const entry of dirents) {
    if (!options.showHidden && entry.name.startsWith(".")) continue;
    const fullPath = fs.join(current, entry.name);
    if (await isDirectoryEntry(entry, fullPath, statPath)) directories.push({ name: entry.name, path: fullPath });
  }
  directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : 1));
  const entries: DirectoryEntry[] = directories.slice(0, cap).map((entry) => ({ ...entry, isGitRepo: exists(fs.join(entry.path, ".git")) }));
  const parent = fs.dirname(current);
  return {
    path: current,
    parent: parent === current ? null : parent,
    entries,
    truncated: directories.length > cap,
    roots: listRoots(home, platform, exists)
  };
}
