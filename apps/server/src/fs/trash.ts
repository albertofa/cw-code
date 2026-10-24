import { execFile } from "node:child_process";

export interface TrashCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

const TRASH_TIMEOUT_MS = 60_000;
const WINDOWS_TARGET_ENV = "CW_TRASH_TARGET";

const WINDOWS_TRASH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$p = $env:${WINDOWS_TARGET_ENV}`,
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
  "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }"
].join("\n");

const UNSUPPORTED_MESSAGE = "moving files to the trash is not supported on this system (install gio or trash-cli)";

export function trashCommands(platform: NodeJS.Platform, target: string): TrashCommand[] {
  if (platform === "win32") {
    return [
      {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TRASH_SCRIPT],
        env: { [WINDOWS_TARGET_ENV]: target }
      }
    ];
  }
  if (platform === "darwin") {
    return [
      {
        file: "osascript",
        args: ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", target]
      }
    ];
  }
  return [
    { file: "gio", args: ["trash", target] },
    { file: "trash-put", args: [target] }
  ];
}

function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function trashFailureMessage(target: string, stderr: string, fallback: string): string {
  const full = stderr.trim() || fallback;
  const summary = full.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? full;
  return `could not move ${target} to the trash: ${summary}${full === summary ? "" : `\n${full}`}`;
}

function runCommand(command: TrashCommand, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const options = { windowsHide: true, timeout: TRASH_TIMEOUT_MS, killSignal: "SIGKILL" as const, env: { ...process.env, ...command.env } };
    execFile(command.file, command.args, options, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      if (isMissingExecutable(error)) {
        reject(error);
        return;
      }
      reject(new Error(trashFailureMessage(target, String(stderr), error.message)));
    });
  });
}

export async function moveToTrash(
  target: string,
  run: (command: TrashCommand) => Promise<void> = (command) => runCommand(command, target),
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  for (const command of trashCommands(platform, target)) {
    try {
      await run(command);
      return;
    } catch (error) {
      if (!isMissingExecutable(error)) throw error;
    }
  }
  throw new Error(UNSUPPORTED_MESSAGE);
}
