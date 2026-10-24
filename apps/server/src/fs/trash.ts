import { execFile } from "node:child_process";

export interface TrashCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

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

function runCommand(command: TrashCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { windowsHide: true, env: { ...process.env, ...command.env } }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      if (isMissingExecutable(error)) {
        reject(error);
        return;
      }
      const detail = String(stderr).trim() || error.message;
      reject(new Error(`${command.file} could not move the item to the trash: ${detail}`));
    });
  });
}

export async function moveToTrash(
  target: string,
  run: (command: TrashCommand) => Promise<void> = runCommand,
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
