import { posix, win32 } from "node:path";
import type { CliBinary } from "@cw-code/contracts";

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
