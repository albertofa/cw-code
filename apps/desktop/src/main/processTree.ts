import { execFileSync, type ChildProcess } from "node:child_process";

export function killProcessTree(proc: ChildProcess | undefined): void {
  if (!proc || proc.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      proc.kill();
    }
    return;
  }
  proc.kill();
}
