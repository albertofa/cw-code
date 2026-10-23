import { spawn } from "node:child_process";
import { detachProcessGroup, killProcessTree } from "../processTree.js";

export type WorktreeScriptKind = "setup" | "destroy";

export const WORKTREE_SCRIPT_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL_CHARS = 4_000;
const FAILURE_TAIL_LINES = 12;

export interface WorktreeScriptRequest {
  script: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WorktreeScriptResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

export function scriptCommand(script: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (platform === "win32") {
    const body = `$ProgressPreference = 'SilentlyContinue'\n${script}`;
    return {
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(body, "utf16le").toString("base64")]
    };
  }
  return { file: env.SHELL?.trim() || "/bin/sh", args: ["-c", script] };
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_CHARS ? next.slice(next.length - OUTPUT_TAIL_CHARS) : next;
}

export function runWorktreeScript(request: WorktreeScriptRequest): Promise<WorktreeScriptResult> {
  const startedAt = Date.now();
  const { file, args } = scriptCommand(request.script);
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (result: Omit<WorktreeScriptResult, "durationMs" | "output" | "timedOut" | "aborted">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, timedOut, aborted, durationMs: Date.now() - startedAt, output: output.trim() });
    };
    const child = spawn(file, args, {
      cwd: request.cwd,
      env: request.env,
      windowsHide: true,
      detached: detachProcessGroup,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, request.timeoutMs ?? WORKTREE_SCRIPT_TIMEOUT_MS);
    timer.unref?.();
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output = appendTail(output, chunk)));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (output = appendTail(output, chunk)));
    child.once("error", (err) => finish({ ok: false, exitCode: null, error: err.message }));
    child.once("close", (code) => finish({ ok: code === 0 && !timedOut && !aborted, exitCode: code }));
  });
}

export function scriptLabel(kind: WorktreeScriptKind): string {
  return kind === "setup" ? "Setup script" : "Destroy script";
}

function seconds(ms: number): string {
  return ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`;
}

export function describeScriptResult(kind: WorktreeScriptKind, result: WorktreeScriptResult): string {
  const label = scriptLabel(kind);
  if (result.ok) return `${label} finished in ${seconds(result.durationMs)}.`;
  const reason = result.aborted
    ? "was stopped"
    : result.timedOut
      ? `timed out after ${seconds(result.durationMs)}`
      : result.error
        ? `could not start: ${result.error}`
        : `failed with exit code ${result.exitCode ?? "unknown"}`;
  const tail = result.output.replace(/\r/g, "").split("\n").slice(-FAILURE_TAIL_LINES).join("\n").trim();
  return tail ? `${label} ${reason}:\n${tail}` : `${label} ${reason}.`;
}
