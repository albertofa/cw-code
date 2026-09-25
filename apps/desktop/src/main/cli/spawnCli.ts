import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
  type StdioPipe
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface CliSpawnTarget {
  file: string;
  args: string[];
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function cliSpawnTarget(
  binary: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): CliSpawnTarget {
  if (platform === "win32") {
    const lower = binary.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      return { file: "cmd.exe", args: ["/d", "/c", binary, ...args] };
    }
    if (lower.endsWith(".ps1")) {
      const command = [`& ${quotePowerShell(binary)}`, ...args.map(quotePowerShell)].join(" ");
      return {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command]
      };
    }
  }
  return { file: binary, args };
}

export function spawnCli(
  binary: string,
  args: string[],
  opts: SpawnOptions & { stdio: [StdioPipe, StdioPipe, StdioPipe] }
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCli(binary: string, args: string[], opts?: SpawnOptions): ChildProcess;
export function spawnCli(binary: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const target = cliSpawnTarget(binary, args);
  return spawn(target.file, target.args, opts);
}

export function execCliFile(
  binary: string,
  args: string[],
  opts: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  const target = cliSpawnTarget(binary, args);
  return new Promise((resolve, reject) => {
    try {
      execFile(target.file, target.args, opts, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    } catch (error) {
      reject(error);
    }
  });
}
