import { execFileSync, type ChildProcess } from "node:child_process";

export const KILL_ESCALATION_MS = 3000;

export const detachProcessGroup = process.platform !== "win32";

function signal(target: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

function terminatePosix(pid: number): void {
  const target = signal(-pid, "SIGTERM") ? -pid : signal(pid, "SIGTERM") ? pid : null;
  if (target === null) return;
  const timer = setTimeout(() => {
    if (signal(target, 0)) signal(target, "SIGKILL");
  }, KILL_ESCALATION_MS);
  timer.unref();
}

export function killProcessTreeByPid(pid: number | undefined): void {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      signal(pid, "SIGTERM");
    }
    return;
  }
  terminatePosix(pid);
}

export function hasExited(proc: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

export function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      proc.removeListener("exit", onExit);
      proc.removeListener("close", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(hasExited(proc)), Math.max(0, timeoutMs));
    timer.unref?.();
    proc.once("exit", onExit);
    proc.once("close", onExit);
  });
}

export function killProcessTree(proc: ChildProcess | undefined): void {
  if (!proc || proc.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
    }
    try {
      proc.kill("SIGTERM");
    } catch {
    }
    return;
  }
  terminatePosix(proc.pid);
}
