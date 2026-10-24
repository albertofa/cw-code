import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const LOGIN_SHELL_KILL_GRACE_MS = 1_000;
const FALLBACK_SHELL = "/bin/bash";
const STDERR_TAIL_CHARS = 500;
const STDERR_BUFFER_CHARS = 4_000;
const STDOUT_BUFFER_CHARS = 1_000_000;

const COPIED_WHEN_MISSING = new Set([
  "SSH_AUTH_SOCK",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((name) => [name, name.toLowerCase()])
]);

const APPIMAGE_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD", "CHROME_DESKTOP"] as const;
const APPIMAGE_PATH_KEYS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"] as const;
const CW_INTERNAL_ENV_KEYS = ["CW_NODE_PTY", "CW_LAUNCHED_FROM_TERMINAL"] as const;

const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function startMarker(marker: string): string {
  return `${marker}_START`;
}

function endMarker(marker: string): string {
  return `${marker}_END`;
}

export function parseMarkedEnv(stdout: string, marker: string): Record<string, string> | null {
  const start = stdout.indexOf(startMarker(marker));
  if (start === -1) return null;
  const bodyStart = start + startMarker(marker).length;
  const end = stdout.indexOf(endMarker(marker), bodyStart);
  if (end === -1) return null;
  const parsed: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of stdout.slice(bodyStart, end).replace(/\r/g, "").split("\n")) {
    if (ENV_LINE.test(line)) {
      const separator = line.indexOf("=");
      currentKey = line.slice(0, separator);
      parsed[currentKey] = line.slice(separator + 1);
    } else if (currentKey !== null) {
      parsed[currentKey] += `\n${line}`;
    }
  }
  for (const key of Object.keys(parsed)) parsed[key] = parsed[key].replace(/\n+$/, "");
  return parsed;
}

function mergePath(login: string | undefined, current: string | undefined): string | undefined {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const value of [login, current]) {
    for (const entry of (value ?? "").split(":")) {
      if (entry.length === 0 || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
  }
  return entries.length > 0 ? entries.join(":") : undefined;
}

function shouldCopyWhenMissing(key: string): boolean {
  return COPIED_WHEN_MISSING.has(key) || key.startsWith("XDG_");
}

export function mergeLoginEnv(current: NodeJS.ProcessEnv, login: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...current };
  const path = mergePath(login["PATH"], current["PATH"]);
  if (path !== undefined) merged["PATH"] = path;
  for (const [key, value] of Object.entries(login)) {
    if (value.length === 0 || !shouldCopyWhenMissing(key)) continue;
    if (merged[key] === undefined || merged[key] === "") merged[key] = value;
  }
  return merged;
}

function isUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

export function sanitizedChildEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const key of CW_INTERNAL_ENV_KEYS) delete sanitized[key];
  if (platform !== "linux") return sanitized;
  const appDir = env["APPIMAGE"] ? env["APPDIR"]?.replace(/\/+$/, "") : undefined;
  for (const key of APPIMAGE_ENV_KEYS) delete sanitized[key];
  if (!appDir) return sanitized;
  for (const key of APPIMAGE_PATH_KEYS) {
    const value = sanitized[key];
    if (value === undefined) continue;
    const kept = value.split(":").filter((segment) => segment.length > 0 && !isUnderAppDir(segment, appDir));
    if (kept.length > 0) sanitized[key] = kept.join(":");
    else delete sanitized[key];
  }
  return sanitized;
}

function loginShellCandidates(env: NodeJS.ProcessEnv): string[] {
  let accountShell: string | undefined;
  try {
    accountShell = userInfo().shell ?? undefined;
  } catch {
    accountShell = undefined;
  }
  const candidates = [env["SHELL"], accountShell, FALLBACK_SHELL].filter(
    (shell): shell is string => typeof shell === "string" && shell.trim().length > 0
  );
  return [...new Set(candidates)];
}

function captureCommand(marker: string): string {
  return `printf '%s\\n' '${startMarker(marker)}'; env; printf '%s\\n' '${endMarker(marker)}'`;
}

interface LoginShellRun {
  stdout: string;
  stderrTail: string;
  exitCode: number | null;
  timedOut: boolean;
}

type CaptureOutcome =
  | { kind: "captured"; env: Record<string, string> }
  | { kind: "unavailable"; warning: string }
  | { kind: "failed"; warning: string };

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
    }
  }
}

function runLoginShell(shell: string, marker: string, env: NodeJS.ProcessEnv): Promise<LoginShellRun> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(shell, ["-ilc", captureCommand(marker)], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let settled = false;
    const finish = (exitCode: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve({ stdout, stderrTail: stderr.trim().slice(-STDERR_TAIL_CHARS), exitCode, timedOut });
    };
    const timeoutTimer = setTimeout(() => {
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), LOGIN_SHELL_KILL_GRACE_MS).unref();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null, true);
    }, LOGIN_SHELL_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(0, STDOUT_BUFFER_CHARS);
      const start = stdout.indexOf(startMarker(marker));
      if (start !== -1 && stdout.includes(endMarker(marker), start)) {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, false);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_BUFFER_CHARS);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      reject(error);
    });
    child.once("close", (code) => finish(code, false));
  });
}

function describeFailure(shell: string, run: LoginShellRun): string {
  const reason = run.timedOut
    ? `timed out after ${LOGIN_SHELL_TIMEOUT_MS}ms`
    : run.exitCode === 0
      ? "printed no environment markers"
      : `exited with code ${run.exitCode ?? "unknown"} without environment markers`;
  return run.stderrTail ? `login shell ${shell} ${reason}: ${run.stderrTail}` : `login shell ${shell} ${reason}`;
}

async function captureLoginEnv(shell: string, platform: NodeJS.Platform): Promise<CaptureOutcome> {
  const marker = `__CW_CODE_ENV_${randomUUID()}__`;
  let run: LoginShellRun;
  try {
    run = await runLoginShell(shell, marker, sanitizedChildEnv(process.env, platform));
  } catch (error) {
    return { kind: "unavailable", warning: `login shell ${shell} could not start: ${(error as Error).message}` };
  }
  const env = parseMarkedEnv(run.stdout, marker);
  return env ? { kind: "captured", env } : { kind: "failed", warning: describeFailure(shell, run) };
}

function isLaunchedFromTerminal(): boolean {
  return process.stdout.isTTY === true || process.stdin.isTTY === true || process.env.CW_LAUNCHED_FROM_TERMINAL === "1";
}

export async function loadLoginShellEnvironment(platform: NodeJS.Platform): Promise<string[]> {
  if (platform !== "linux" && platform !== "darwin") return [];
  if (isLaunchedFromTerminal()) return [];
  const warnings: string[] = [];
  for (const shell of loginShellCandidates(process.env)) {
    const outcome = await captureLoginEnv(shell, platform);
    if (outcome.kind === "captured") {
      const merged = mergeLoginEnv(process.env, outcome.env);
      for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined && process.env[key] !== value) process.env[key] = value;
      }
      return warnings;
    }
    warnings.push(outcome.warning);
    if (outcome.kind === "failed") break;
  }
  return warnings;
}
