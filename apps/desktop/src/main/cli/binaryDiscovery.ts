import { posix, win32 } from "node:path";
import type { CliBinary } from "@cw-code/contracts";

export interface CandidatePathsOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  env: Record<string, string | undefined>;
}

const KNOWN_BINARIES: ReadonlySet<string> = new Set(["claude", "opencode", "codex", "git", "gh"]);

const POSIX_SYSTEM_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];

const WIN32_EXECUTABLE_FORMS = [".exe", ".cmd", ".ps1"];

function isKnownBinary(binary: string): binary is CliBinary {
  return KNOWN_BINARIES.has(binary);
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  return raw !== undefined && raw.length > 0 ? raw : undefined;
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
  const userProfile = envValue(opts.env, "USERPROFILE") ?? home;
  const appData = envValue(opts.env, "APPDATA") ?? (home ? win32.join(home, "AppData", "Roaming") : undefined);
  const localAppData =
    envValue(opts.env, "LOCALAPPDATA") ?? (home ? win32.join(home, "AppData", "Local") : undefined);
  const programData = envValue(opts.env, "PROGRAMDATA") ?? "C:\\ProgramData";
  const programFiles = envValue(opts.env, "PROGRAMFILES") ?? "C:\\Program Files";
  const programFilesX86 =
    envValue(opts.env, "ProgramFiles(x86)") ?? envValue(opts.env, "PROGRAMFILES(X86)");

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
