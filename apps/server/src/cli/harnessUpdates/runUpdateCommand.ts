import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "../../processTree.js";
import { currentEnv, resolveBinary } from "../../pty/resolve.js";
import { spawnCli } from "../spawnCli.js";

const TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_LIMIT = 10_000;
const PROGRESS_MAX = 200;
const PROGRESS_INTERVAL_MS = 1000;
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export interface UpdateCommand {
  file: string;
  args: string[];
}

export interface UpdateRunResult {
  code: number | null;
  output: string;
  error: string | null;
}

export type UpdateRunner = (command: UpdateCommand, onProgress: (line: string) => void) => Promise<UpdateRunResult>;

export function lastOutputLine(text: string): string | null {
  const lines = text.replace(ANSI_RE, "").split(/\r?\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line.slice(0, PROGRESS_MAX);
  }
  return null;
}

export function runUpdateCommand(command: UpdateCommand, onProgress: (line: string) => void): Promise<UpdateRunResult> {
  const file = resolveBinary(command.file, currentEnv());
  if (!file) return Promise.resolve({ code: null, output: "", error: `${command.file} was not found on PATH.` });
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let lastEmit = 0;
    let pendingLine: string | null = null;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let child: ChildProcess | undefined;

    const emit = (): void => {
      progressTimer = null;
      if (pendingLine === null) return;
      lastEmit = Date.now();
      const line = pendingLine;
      pendingLine = null;
      onProgress(line);
    };
    const finish = (result: UpdateRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (progressTimer) clearTimeout(progressTimer);
      resolve(result);
    };
    const append = (chunk: Buffer | string): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
      const line = lastOutputLine(output);
      if (line === null || settled) return;
      pendingLine = line;
      const wait = lastEmit + PROGRESS_INTERVAL_MS - Date.now();
      if (wait <= 0) emit();
      else progressTimer ??= setTimeout(emit, wait);
    };
    const timeout = setTimeout(() => {
      killProcessTree(child);
      finish({ code: null, output, error: "Update timed out." });
    }, TIMEOUT_MS);
    timeout.unref?.();

    try {
      child = spawnCli(file, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ code: null, output, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => finish({ code: null, output, error: error.message }));
    child.on("close", (code, signal) =>
      finish({ code, output, error: code === null ? `Update command was stopped by ${signal ?? "a signal"}.` : null })
    );
  });
}
