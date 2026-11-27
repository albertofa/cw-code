import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, win32 } from "node:path";
import type { DriverKind, HarnessInstallMethod } from "@cw-code/contracts";
import { currentEnv, resolveBinary } from "../../pty/resolve.js";

export interface InstallPlanInput {
  binary: DriverKind;
  execPath: string;
  realPath: string;
  platform: NodeJS.Platform;
  homeDir: string;
  env: Record<string, string | undefined>;
  packageName: string;
  exists(path: string): boolean;
  /**
   * Set when pacman owns the binary: the owning package, whether a sync repository provides it (an AUR or
   * locally built package is not) and the resolved `pkexec`, or null when there is none to elevate with.
   */
  pacman?: { packageName: string; inRepo: boolean; pkexec: string | null } | null;
}

export interface InstallPlan {
  method: HarnessInstallMethod;
  command: { file: string; args: string[]; timeoutMs?: number } | null;
  display: string | null;
  lockKey: string | null;
}

const WINGET_IDS: Record<DriverKind, string> = {
  claude: "Anthropic.ClaudeCode",
  codex: "OpenAI.Codex",
  opencode: "SST.opencode"
};

/** Long enough for the password prompt plus the transaction: the default timeout would stop pacman while it installs. */
const PACMAN_UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

const BREW_RE = /\/(cellar|caskroom)\/([^/]+)\//i;

function ownUpdater(binary: DriverKind): string {
  return binary === "opencode" ? "opencode upgrade" : `${binary} update`;
}

function quote(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

function displayOf(file: string, args: string[]): string {
  return [file, ...args].map(quote).join(" ");
}

function runnable(method: HarnessInstallMethod, file: string, args: string[], lockKey: string): InstallPlan {
  return { method, command: { file, args }, display: displayOf(file, args), lockKey };
}

function manual(method: HarnessInstallMethod, display: string | null): InstallPlan {
  return { method, command: null, display, lockKey: null };
}

export function resolveInstallPlan(input: InstallPlanInput): InstallPlan {
  const { binary, execPath, realPath, platform, packageName } = input;
  const win = platform === "win32";
  const norm = (value: string): string => {
    const slashed = value.replace(/\\/g, "/");
    return win ? slashed.toLowerCase() : slashed;
  };
  const exec = norm(execPath);
  const real = norm(realPath);
  const candidates = real === exec ? [real] : [exec, real];
  const anyPath = (test: (path: string) => boolean): boolean => candidates.some(test);
  const contains = (needle: string): boolean => anyPath((path) => path.includes(needle));
  const home = norm(input.homeDir).replace(/\/+$/, "");
  const under = (path: string, dir: string): boolean => path.startsWith(`${dir.replace(/\/+$/, "")}/`);

  if (contains("/winget/links/") || contains("/winget/packages/")) {
    return manual("winget", `winget upgrade ${WINGET_IDS[binary]}`);
  }

  if (contains("/mise/installs/") || contains("/mise/shims/")) {
    return manual("mise", "mise upgrade");
  }

  if (input.pacman) {
    const { packageName: systemPackage, inRepo, pkexec } = input.pacman;
    if (!inRepo) return manual("pacman", null);
    if (!pkexec) return manual("pacman", `sudo pacman -Syu --needed ${systemPackage}`);
    const plan = runnable("pacman", pkexec, ["pacman", "-Sy", "--needed", "--noconfirm", systemPackage], "pacman");
    return { ...plan, command: { file: pkexec, args: plan.command?.args ?? [], timeoutMs: PACMAN_UPDATE_TIMEOUT_MS } };
  }

  const npmPrefix = findNpmPrefix(input);
  const claudeViaNpm = binary === "claude" && npmPrefix !== null;
  if (!claudeViaNpm && isNative(binary, candidates, home)) {
    const args = binary === "opencode" ? ["upgrade"] : ["update"];
    return runnable("native", execPath, args, `${binary}-native`);
  }

  if (contains("/.bun/bin/") || contains("/.bun/install/global/")) {
    return runnable("bun", "bun", ["add", "-g", `${packageName}@latest`], "bun-global");
  }

  const pnpmDirs = [
    input.env["PNPM_HOME"],
    input.env["LOCALAPPDATA"] ? `${input.env["LOCALAPPDATA"]}/pnpm` : undefined,
    win ? `${home}/AppData/Local/pnpm` : undefined,
    `${home}/.local/share/pnpm`,
    `${home}/Library/pnpm`
  ]
    .filter((dir): dir is string => Boolean(dir))
    .map(norm);
  if (pnpmDirs.some((dir) => anyPath((path) => under(path, dir)))) {
    return runnable("pnpm", "pnpm", ["add", "-g", `${packageName}@latest`], "pnpm-global");
  }

  if (npmPrefix) {
    const lockPrefix = win ? npmPrefix.toLowerCase() : npmPrefix;
    return runnable("npm", "npm", ["install", "-g", "--prefix", npmPrefix, `${packageName}@latest`], `npm-global:${lockPrefix}`);
  }

  const brew = real.match(BREW_RE) ?? exec.match(BREW_RE);
  if (brew) {
    const [, kind, name] = brew;
    const args = kind?.toLowerCase() === "caskroom" ? ["upgrade", "--cask", name ?? ""] : ["upgrade", name ?? ""];
    return runnable("homebrew", "brew", args, "homebrew");
  }

  if (contains("/node_modules/")) {
    return manual("unknown", `npm install -g ${packageName}@latest`);
  }

  return manual("unknown", ownUpdater(binary));
}

function isNative(binary: DriverKind, candidates: string[], home: string): boolean {
  if (binary === "claude") {
    return candidates.some(
      (path) =>
        path === `${home}/.local/bin/claude` ||
        path === `${home}/.local/bin/claude.exe` ||
        path.startsWith(`${home}/.local/share/claude/`)
    );
  }
  if (binary === "opencode") return candidates.some((path) => path.startsWith(`${home}/.opencode/bin/`));
  return candidates.some((path) => path.includes("/packages/standalone/"));
}

function findNpmPrefix(input: InstallPlanInput): string | null {
  const { realPath, packageName } = input;
  const win = input.platform === "win32";
  const normalizedPackage = win ? packageName.toLowerCase() : packageName;
  const slashed = realPath.replace(/\\/g, "/");
  const haystack = win ? slashed.toLowerCase() : slashed;
  const marker = `/lib/node_modules/${normalizedPackage}/`;
  const index = haystack.indexOf(marker);
  if (index > 0) return realPath.slice(0, index);
  if (!win) return null;
  const dir = win32.dirname(input.execPath);
  const manifest = win32.join(dir, "node_modules", input.packageName, "package.json");
  return input.exists(manifest) ? dir : null;
}

function manualFallback(binary: DriverKind): InstallPlan {
  return manual("unknown", ownUpdater(binary));
}

export async function planFor(binary: DriverKind, binaryPath: string, packageName: string): Promise<InstallPlan> {
  const execPath = resolveBinary(binaryPath, currentEnv());
  if (!execPath) return manualFallback(binary);
  const realPath = await realpath(execPath).catch(() => execPath);
  const input: InstallPlanInput = {
    binary,
    execPath,
    realPath,
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
    packageName,
    exists: existsSync,
    pacman: await pacmanOwner(realPath)
  };
  const plan = resolveInstallPlan(input);
  const target = installDir(plan, input);
  if (target === null || (await writable(target))) return plan;
  return manual(plan.method, plan.display);
}

const PACMAN_QUERY_TIMEOUT_MS = 3000;
const PACMAN_NAME_RE = /^[a-z0-9@._+-]+$/i;

async function pacmanOwner(realPath: string): Promise<InstallPlanInput["pacman"]> {
  if (process.platform !== "linux") return null;
  const home = homedir().replace(/\/+$/, "");
  if (realPath.startsWith(`${home}/`)) return null;
  const env = currentEnv();
  const pacman = resolveBinary("pacman", env);
  if (!pacman) return null;
  const query = (args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(pacman, args, { timeout: PACMAN_QUERY_TIMEOUT_MS }, (error, stdout) => resolve(error ? null : stdout));
    });
  const packageName = (await query(["-Qqo", realPath]))?.trim().split(/\s+/)[0] ?? "";
  if (!PACMAN_NAME_RE.test(packageName)) return null;
  const inRepo = (await query(["-Si", packageName])) !== null;
  return { packageName, inRepo, pkexec: resolveBinary("pkexec", env) };
}

function installDir(plan: InstallPlan, input: InstallPlanInput): string | null {
  if (!plan.command) return null;
  if (plan.method === "npm") return findNpmPrefix(input);
  if (plan.method === "pnpm" || plan.method === "bun") return dirname(input.realPath);
  return null;
}

async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
