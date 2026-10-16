import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const LOGIN_SHELL_KILL_GRACE_MS = 1_000;
const FALLBACK_SHELL = "/bin/bash";

const COPIED_WHEN_MISSING = new Set([
  "SSH_AUTH_SOCK",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS"
]);

const APPIMAGE_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD", "CHROME_DESKTOP"] as const;
const APPIMAGE_PATH_KEYS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"] as const;

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
  if (platform !== "linux") return sanitized;
  const appDir = env["APPDIR"]?.replace(/\/+$/, "");
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

function runLoginShell(shell: string, marker: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(shell, ["-ilc", captureCommand(marker)], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), LOGIN_SHELL_KILL_GRACE_MS);
      reject(new Error(`timed out after ${LOGIN_SHELL_TIMEOUT_MS}ms`));
    }, LOGIN_SHELL_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      if (timedOut) return;
      if (code === 0) resolve(stdout);
      else reject(new Error(`exited with code ${code ?? "unknown"}`));
    });
  });
}

async function captureLoginEnv(shell: string, platform: NodeJS.Platform): Promise<Record<string, string> | null> {
  const marker = `__CW_CODE_ENV_${randomUUID()}__`;
  try {
    const stdout = await runLoginShell(shell, marker, sanitizedChildEnv(process.env, platform));
    const parsed = parseMarkedEnv(stdout, marker);
    if (!parsed) console.warn(`[shell-env] ${shell} printed no environment markers`);
    return parsed;
  } catch (error) {
    console.warn(`[shell-env] login shell ${shell} failed: ${(error as Error).message}`);
    return null;
  }
}

export async function loadLoginShellEnvironment(platform: NodeJS.Platform): Promise<void> {
  if (platform !== "linux" && platform !== "darwin") return;
  for (const shell of loginShellCandidates(process.env)) {
    const login = await captureLoginEnv(shell, platform);
    if (!login) continue;
    const merged = mergeLoginEnv(process.env, login);
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && process.env[key] !== value) process.env[key] = value;
    }
    return;
  }
  console.warn("[shell-env] keeping the current environment; no login shell produced one");
}
