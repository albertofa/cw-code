import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { killProcessTreeByPid } from "./processTree.js";
import { sanitizedChildEnv } from "./shellEnvironment.js";

export const OWNER_PID_ENV = "CW_CODE_OWNER_PID";

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  command: string;
  ownerPid: number | null;
}

export function withOwnerPid(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [OWNER_PID_ENV]: String(process.pid) };
}

export function parseOwnerPid(environ: string): number | null {
  const prefix = `${OWNER_PID_ENV}=`;
  for (const entry of environ.split("\0")) {
    if (!entry.startsWith(prefix)) continue;
    const value = entry.slice(prefix.length);
    if (!/^\d+$/.test(value)) return null;
    const pid = Number(value);
    return pid > 0 ? pid : null;
  }
  return null;
}

export function isManagedServerCommand(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower.includes("opencode") && lower.includes(" serve")) return true;
  if (lower.includes("codex") && lower.includes("app-server")) return true;
  return false;
}

function descendsFrom(proc: ProcessSnapshot, ancestorPid: number, byPid: Map<number, ProcessSnapshot>): boolean {
  const seen = new Set<number>();
  let current: ProcessSnapshot | undefined = proc;
  while (current && !seen.has(current.pid)) {
    if (current.ppid === ancestorPid) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

export function selectOrphanServerPids(processes: ProcessSnapshot[], platform: NodeJS.Platform): number[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const out: number[] = [];
  for (const proc of processes) {
    if (!isManagedServerCommand(proc.command)) continue;
    if (platform === "win32") {
      if (!byPid.has(proc.ppid)) out.push(proc.pid);
      continue;
    }
    if (proc.ownerPid === null) continue;
    if (!descendsFrom(proc, proc.ownerPid, byPid)) out.push(proc.pid);
  }
  return out;
}

function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: sanitizedChildEnv(process.env, process.platform) }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

async function listProcessesWindows(): Promise<ProcessSnapshot[]> {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const stdout = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 20000);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as
    | { ProcessId?: number; ParentProcessId?: number; CommandLine?: string | null }
    | Array<{ ProcessId?: number; ParentProcessId?: number; CommandLine?: string | null }>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcessSnapshot[] = [];
  for (const row of rows) {
    const pid = Number(row.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push({ pid, ppid: Number(row.ParentProcessId) || 0, command: row.CommandLine ?? "", ownerPid: null });
  }
  return out;
}

async function readOwnerPid(pid: number): Promise<number | null> {
  try {
    return parseOwnerPid(await readFile(`/proc/${pid}/environ`, "latin1"));
  } catch {
    return null;
  }
}

async function listProcessesPosix(platform: NodeJS.Platform): Promise<ProcessSnapshot[]> {
  const stdout = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], 20000);
  const out: ProcessSnapshot[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[3] ?? "";
    const ownerPid = platform === "linux" && isManagedServerCommand(command) ? await readOwnerPid(pid) : null;
    out.push({ pid, ppid: Number(match[2]), command, ownerPid });
  }
  return out;
}

export interface ReapDeps {
  listProcesses?: () => Promise<ProcessSnapshot[]>;
  killPid?: (pid: number) => void;
  platform?: NodeJS.Platform;
}

export async function reapOrphanedServers(deps: ReapDeps = {}): Promise<number[]> {
  const platform = deps.platform ?? process.platform;
  const list = deps.listProcesses ?? (platform === "win32" ? listProcessesWindows : () => listProcessesPosix(platform));
  const kill = deps.killPid ?? killProcessTreeByPid;
  const processes = await list();
  const orphans = selectOrphanServerPids(processes, platform);
  for (const pid of orphans) {
    try {
      kill(pid);
    } catch {
    }
  }
  return orphans;
}
