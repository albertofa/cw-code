import { execFile } from "node:child_process";
import { killProcessTreeByPid } from "./processTree.js";

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  command: string;
}

export function isManagedServerCommand(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower.includes("opencode") && lower.includes(" serve")) return true;
  if (lower.includes("codex") && lower.includes("app-server")) return true;
  return false;
}

export function selectOrphanServerPids(processes: ProcessSnapshot[]): number[] {
  const live = new Set(processes.map((p) => p.pid));
  const out: number[] = [];
  for (const proc of processes) {
    if (live.has(proc.ppid)) continue;
    if (!isManagedServerCommand(proc.command)) continue;
    out.push(proc.pid);
  }
  return out;
}

function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
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
    out.push({ pid, ppid: Number(row.ParentProcessId) || 0, command: row.CommandLine ?? "" });
  }
  return out;
}

async function listProcessesPosix(): Promise<ProcessSnapshot[]> {
  const stdout = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], 20000);
  const out: ProcessSnapshot[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
  }
  return out;
}

export interface ReapDeps {
  listProcesses?: () => Promise<ProcessSnapshot[]>;
  killPid?: (pid: number) => void;
}

export async function reapOrphanedServers(deps: ReapDeps = {}): Promise<number[]> {
  const list = deps.listProcesses ?? (process.platform === "win32" ? listProcessesWindows : listProcessesPosix);
  const kill = deps.killPid ?? killProcessTreeByPid;
  const processes = await list();
  const orphans = selectOrphanServerPids(processes);
  for (const pid of orphans) {
    try {
      kill(pid);
    } catch {
    }
  }
  return orphans;
}
