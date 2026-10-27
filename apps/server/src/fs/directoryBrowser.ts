import type { DirectoryEntry, DirectoryListing, DirectoryRoot } from "@cw-code/contracts";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const DIRECTORY_ENTRY_CAP = 2_000;
const DRIVE_PROBE_TIMEOUT_MS = 1_500;
const DRIVE_CACHE_TTL_MS = 10_000;
const GIT_CHECK_CONCURRENCY = 32;

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
  exists?: (path: string) => Promise<boolean>;
  driveProbeTimeoutMs?: number;
  driveCache?: DriveRootsCache;
}

export class DriveRootsCache {
  private value: DirectoryRoot[] | null = null;
  private storedAt = 0;

  constructor(
    private readonly ttlMs = DRIVE_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  get(): DirectoryRoot[] | null {
    return this.value !== null && this.now() - this.storedAt < this.ttlMs ? this.value : null;
  }

  set(roots: DirectoryRoot[]): void {
    this.value = roots;
    this.storedAt = this.now();
  }
}

const sharedDriveCache = new DriveRootsCache();

const DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function readDirents(path: string): Promise<DirentLike[]> {
  return readdir(path, { withFileTypes: true });
}

function pathModule(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function withTimeout(probe: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([probe, timeout]).finally(() => clearTimeout(timer));
}

async function mapWithLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function listDrives(exists: (path: string) => Promise<boolean>, timeoutMs: number): Promise<DirectoryRoot[]> {
  const drives = [...DRIVE_LETTERS].map((letter) => ({ label: `${letter}:`, path: `${letter}:\\` }));
  const present = await Promise.all(drives.map((drive) => withTimeout(exists(drive.path).catch(() => false), timeoutMs)));
  return drives.filter((_, index) => present[index]);
}

async function listRoots(home: string, platform: NodeJS.Platform, options: BrowseOptions, exists: (path: string) => Promise<boolean>): Promise<DirectoryRoot[]> {
  const homeRoot: DirectoryRoot = { label: "Home", path: home };
  if (platform !== "win32") return [homeRoot, { label: "/", path: "/" }];
  const cache = options.driveCache ?? (options.exists ? undefined : sharedDriveCache);
  let drives = cache?.get() ?? null;
  if (drives === null) {
    drives = await listDrives(exists, options.driveProbeTimeoutMs ?? DRIVE_PROBE_TIMEOUT_MS);
    cache?.set(drives);
  }
  return [homeRoot, ...drives];
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
  const exists = options.exists ?? pathExists;
  const cap = options.cap ?? DIRECTORY_ENTRY_CAP;
  const fs = pathModule(platform);
  const target = path === null || path === "" ? home : path;
  if (!fs.isAbsolute(target)) throw new Error(`path must be absolute: ${target}`);
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
  const entries: DirectoryEntry[] = await mapWithLimit(directories.slice(0, cap), GIT_CHECK_CONCURRENCY, async (entry) => ({
    ...entry,
    isGitRepo: await exists(fs.join(entry.path, ".git")).catch(() => false)
  }));
  const parent = fs.dirname(current);
  return {
    path: current,
    parent: parent === current ? null : parent,
    entries,
    truncated: directories.length > cap,
    roots: await listRoots(home, platform, options, exists)
  };
}
