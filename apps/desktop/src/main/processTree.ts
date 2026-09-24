import { execFileSync, type ChildProcess } from "node:child_process";

export function killProcessTreeByPid(pid: number | undefined): void {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
    }
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
  }
}

export function killProcessTree(proc: ChildProcess | undefined): void {
  if (!proc || proc.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
    }
  }
  try {
    proc.kill("SIGTERM");
  } catch {
  }
}
