import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { normalize, posix, win32, dirname, basename, sep } from "node:path";
import type {
  BinarySource,
  CliBinary,
  CliDiscoverResult,
  CliDiscoveredCandidate,
} from "@cw-code/contracts";
import { checkCliVersion, isBinaryUnavailableError, MINIMUM_VERSIONS } from "../cliVersions.js";
import { execCliFile } from "./spawnCli.js";
import { currentEnv, resolveBinary, type ResolveEnv } from "../pty/resolve.js";
import { normalizeBinaryPath } from "../settings/settingsUtils.js";

export interface CandidatePathsOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  env: Record<string, string | undefined>;
}

const KNOWN_BINARIES: ReadonlySet<CliBinary> = new Set(["claude", "opencode", "codex", "git", "gh"]);

const POSIX_SYSTEM_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];

const WIN32_EXECUTABLE_FORMS = [".exe", ".cmd", ".ps1"];

function isKnownBinary(binary: string): binary is CliBinary {
  return (KNOWN_BINARIES as ReadonlySet<string>).has(binary);
}

function getEnv(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined && raw.length > 0) return raw;
  }
  const folded = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.length > 0 && !folded.has(key.toLowerCase())) {
      folded.set(key.toLowerCase(), value);
    }
  }
  for (const name of names) {
    const hit = folded.get(name.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function pushCandidate(
  list: string[],
  seen: Set<string>,
  normalizePath: (p: string) => string,
  caseInsensitive: boolean,
  value: string
): void {
  const normalized = value.includes("/") || value.includes("\\") ? normalizePath(value) : value;
  const key = caseInsensitive ? normalized.toLowerCase() : normalized;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(normalized);
}

function posixCandidates(binary: CliBinary, opts: CandidatePathsOptions): string[] {
  const list: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => pushCandidate(list, seen, posix.normalize, false, value);
  push(binary);
  for (const dir of POSIX_SYSTEM_DIRS) push(posix.join(dir, binary));
  if (opts.homeDir) {
    push(posix.join(opts.homeDir, ".local/bin", binary));
    push(posix.join(opts.homeDir, "bin", binary));
    push(posix.join(opts.homeDir, ".npm-global/bin", binary));
    if (binary === "opencode") push(posix.join(opts.homeDir, ".opencode/bin", binary));
    if (binary === "claude") push(posix.join(opts.homeDir, ".claude/local", binary));
  }
  return list;
}

function win32Candidates(binary: CliBinary, opts: CandidatePathsOptions): string[] {
  const list: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => pushCandidate(list, seen, win32.normalize, true, value);
  const forms = binary === "git" || binary === "gh" ? [".exe"] : WIN32_EXECUTABLE_FORMS;
  const pushForms = (dir: string): void => {
    for (const ext of forms) push(win32.join(dir, `${binary}${ext}`));
  };

  push(binary);
  for (const ext of forms) push(`${binary}${ext}`);

  const home = opts.homeDir;
  const userProfile = getEnv(opts.env, ["USERPROFILE"]) ?? home;
  const appData = getEnv(opts.env, ["APPDATA"]) ?? (home ? win32.join(home, "AppData", "Roaming") : undefined);
  const localAppData =
    getEnv(opts.env, ["LOCALAPPDATA"]) ?? (home ? win32.join(home, "AppData", "Local") : undefined);
  const programData = getEnv(opts.env, ["PROGRAMDATA", "ProgramData"]) ?? "C:\\ProgramData";
  const programFiles = getEnv(opts.env, ["PROGRAMFILES", "ProgramFiles"]) ?? "C:\\Program Files";
  const programFilesX86 = getEnv(opts.env, ["ProgramFiles(x86)", "PROGRAMFILES(X86)"]);

  if (appData) pushForms(win32.join(appData, "npm"));
  if (localAppData) pushForms(win32.join(localAppData, "Microsoft", "WinGet", "Links"));
  if (localAppData) pushForms(win32.join(localAppData, "pnpm"));
  const nvmSymlink = getEnv(opts.env, ["NVM_SYMLINK"]);
  const nvmHome = getEnv(opts.env, ["NVM_HOME"]);
  if (nvmSymlink) pushForms(nvmSymlink);
  if (nvmHome) pushForms(win32.join(nvmHome, "nodejs"));
  if (binary === "opencode" && userProfile) pushForms(win32.join(userProfile, ".opencode", "bin"));
  if (binary === "claude" && userProfile) pushForms(win32.join(userProfile, ".claude", "local"));
  if (userProfile) pushForms(win32.join(userProfile, "scoop", "shims"));
  pushForms(win32.join(programData, "chocolatey", "bin"));

  if (binary === "git") {
    push(win32.join(programFiles, "Git", "bin", "git.exe"));
    push(win32.join(programFiles, "Git", "cmd", "git.exe"));
    if (programFilesX86) {
      push(win32.join(programFilesX86, "Git", "bin", "git.exe"));
      push(win32.join(programFilesX86, "Git", "cmd", "git.exe"));
    }
  }
  if (binary === "gh") {
    push(win32.join(programFiles, "GitHub CLI", "gh.exe"));
    if (programFilesX86) push(win32.join(programFilesX86, "GitHub CLI", "gh.exe"));
  }
  return list;
}

export function candidatePaths(binary: CliBinary, opts: CandidatePathsOptions): string[] {
  if (!isKnownBinary(binary)) return [binary];
  return opts.platform === "win32" ? win32Candidates(binary, opts) : posixCandidates(binary, opts);
}

const ALL_BINARIES: CliBinary[] = ["claude", "opencode", "codex", "git", "gh"];

type ProbedVersion = Pick<CliDiscoveredCandidate, "version" | "available" | "error" | "ok" | "minimum">;

function minimumFor(binary: CliBinary): string | null {
  return binary === "claude" || binary === "opencode" || binary === "codex"
    ? MINIMUM_VERSIONS[binary]
    : null;
}

function runVersion(execPath: string): Promise<string> {
  return execCliFile(execPath, ["--version"], { timeout: 15000 }).then(({ stdout }) => stdout);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | number | null | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: string | number | null }).code;
  }
  return undefined;
}

function parseScmVersion(binary: CliBinary, stdout: string): string | null {
  const firstLine = stdout.replace(/\r/g, "").split("\n")[0]?.trim() ?? "";
  if (!firstLine) return null;
  if (binary === "gh") return firstLine.match(/(\d+\.\d+\.\d+)/)?.[1] ?? firstLine;
  return firstLine;
}

async function probeScmVersion(binary: CliBinary, execPath: string): Promise<ProbedVersion> {
  try {
    const version = parseScmVersion(binary, await runVersion(execPath));
    return { version, available: true, error: null, ok: version !== null, minimum: null };
  } catch (error) {
    return {
      version: null,
      available: !isBinaryUnavailableError({ code: errorCode(error) }),
      error: errorMessage(error),
      ok: false,
      minimum: null
    };
  }
}

async function probeVersion(binary: CliBinary, execPath: string): Promise<ProbedVersion> {
  if (binary === "claude" || binary === "opencode" || binary === "codex") {
    const check = await checkCliVersion(binary, execPath);
    return { version: check.actual, available: check.available, error: check.error, ok: check.ok, minimum: check.minimum };
  }
  return probeScmVersion(binary, execPath);
}

function safeHomeDir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

function tryResolveBinary(name: string, env: ResolveEnv): string | null {
  try {
    return resolveBinary(name, env);
  } catch {
    return null;
  }
}

function tryExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function bareSource(binary: CliBinary, normalized: string, platform: NodeJS.Platform): BinarySource {
  const candidates = candidatePaths(binary, { platform, homeDir: safeHomeDir(), env: process.env });
  const key = platform === "win32" ? normalized.toLowerCase() : normalized;
  const match = candidates.some((candidate) =>
    platform === "win32" ? candidate.toLowerCase() === key : candidate === key
  );
  return match ? "path" : "common";
}

export async function verifyBinaryPath(
  binary: CliBinary,
  rawPath: string,
  env: ResolveEnv = currentEnv()
): Promise<CliDiscoveredCandidate> {
  const normalized = normalizeBinaryPath(rawPath);
  if (!normalized) {
    return {
      binary,
      path: rawPath,
      source: "configured",
      version: null,
      available: false,
      error: "Empty binary path.",
      ok: false,
      minimum: minimumFor(binary)
    };
  }
  if (/[\\/]/.test(rawPath.trim())) {
    const probed = await probeVersion(binary, normalized);
    return { binary, path: normalized, source: "configured", ...probed };
  }
  const resolved = tryResolveBinary(normalized, env);
  const execPath = resolved ?? normalized;
  const probed = await probeVersion(binary, execPath);
  return { binary, path: execPath, source: bareSource(binary, normalized, env.platform), ...probed };
}

const SHIM_PREFERENCE = [".exe", ".cmd", ".bat", ".ps1"];

function shimRank(execPath: string): number {
  const lower = execPath.toLowerCase();
  const rank = SHIM_PREFERENCE.findIndex((ext) => lower.endsWith(ext));
  return rank === -1 ? SHIM_PREFERENCE.length : rank;
}

function shimStem(execPath: string, platform: NodeJS.Platform): string {
  const normalized = normalize(execPath);
  const stem = `${dirname(normalized)}${sep}${basename(normalized).replace(/\.[a-zA-Z0-9]+$/, "")}`;
  return platform === "win32" ? stem.toLowerCase() : stem;
}

export function dedupeShimCandidates<T extends { path: string }>(items: T[], platform: NodeJS.Platform): T[] {
  if (platform !== "win32") return [...items];
  const best = new Map<string, T>();
  for (const item of items) {
    const key = shimStem(item.path, platform);
    const prev = best.get(key);
    if (!prev || shimRank(item.path) < shimRank(prev.path)) best.set(key, item);
  }
  return [...best.values()];
}

async function discoverOne(binary: CliBinary): Promise<CliDiscoveredCandidate[]> {
  const env = currentEnv();
  const platform = process.platform;
  const keyOf = (value: string): string => (platform === "win32" ? value.toLowerCase() : value);
  const gathered: Array<{ path: string; source: BinarySource }> = [];
  const seen = new Set<string>();
  const resolved = tryResolveBinary(binary, env);
  if (resolved) {
    const normalized = normalize(resolved);
    gathered.push({ path: normalized, source: "path" });
    seen.add(keyOf(normalized));
  }
  for (const candidate of candidatePaths(binary, {
    platform,
    homeDir: safeHomeDir(),
    env: process.env
  })) {
    if (!/[\\/]/.test(candidate)) continue;
    const normalized = normalize(candidate);
    if (seen.has(keyOf(normalized))) continue;
    seen.add(keyOf(normalized));
    if (!tryExists(candidate)) continue;
    gathered.push({ path: normalized, source: "common" });
  }
  const verified = await Promise.all(
    dedupeShimCandidates(gathered, platform).map(async ({ path, source }): Promise<CliDiscoveredCandidate> => {
      try {
        return { binary, path, source, ...(await probeVersion(binary, path)) };
      } catch (error) {
        return { binary, path, source, version: null, available: false, error: errorMessage(error), ok: false, minimum: minimumFor(binary) };
      }
    })
  );
  verified.sort((a, b) => Number(b.ok) - Number(a.ok) || a.path.length - b.path.length);
  return verified;
}

export async function discoverBinaries(binaries?: CliBinary[]): Promise<CliDiscoverResult> {
  const targets = [...new Set(binaries ?? ALL_BINARIES)];
  const entries = await Promise.all(
    targets.map(async (binary): Promise<[CliBinary, CliDiscoveredCandidate[]]> => {
      try {
        return [binary, await discoverOne(binary)];
      } catch (error) {
        console.warn(`binary discovery failed for ${binary}: ${errorMessage(error)}`);
        return [binary, []];
      }
    })
  );
  const result = {} as Record<CliBinary, CliDiscoveredCandidate[]>;
  for (const [binary, candidates] of entries) result[binary] = candidates;
  for (const binary of ALL_BINARIES) result[binary] ??= [];
  return result;
}
