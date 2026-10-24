import { describe, expect, it } from "bun:test";
import { moveToTrash, trashCommands, type TrashCommand } from "./trash.js";

const TARGET = "/work/repo/it's $(rm -rf) `x`.txt";

function missing(file: string): Error {
  return Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
}

describe("trashCommands", () => {
  it("passes the Windows path only through the environment", () => {
    const commands = trashCommands("win32", TARGET);
    expect(commands).toHaveLength(1);
    const [command] = commands;
    expect(command!.file).toBe("powershell.exe");
    expect(command!.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(command!.env).toEqual({ CW_TRASH_TARGET: TARGET });
    expect(command!.args.join(" ")).not.toContain(TARGET);
    const script = command!.args[3]!;
    expect(script).toContain("$env:CW_TRASH_TARGET");
    expect(script).toContain("Add-Type -AssemblyName Microsoft.VisualBasic");
    expect(script).toContain("Test-Path -LiteralPath $p -PathType Container");
    expect(script).toContain("::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')");
    expect(script).toContain("::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')");
  });

  it("uses gio then trash-put on Linux with the path as an argument", () => {
    expect(trashCommands("linux", TARGET)).toEqual([
      { file: "gio", args: ["trash", TARGET] },
      { file: "trash-put", args: [TARGET] }
    ]);
    expect(trashCommands("freebsd", TARGET).map((command) => command.file)).toEqual(["gio", "trash-put"]);
  });

  it("asks Finder on macOS with the path as the script argument", () => {
    expect(trashCommands("darwin", TARGET)).toEqual([
      {
        file: "osascript",
        args: ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", TARGET]
      }
    ]);
  });
});

describe("moveToTrash", () => {
  it("falls through to the next command when an executable is missing", async () => {
    const ran: string[] = [];
    await moveToTrash(
      TARGET,
      async (command: TrashCommand) => {
        ran.push(command.file);
        if (command.file === "gio") throw missing("gio");
      },
      "linux"
    );
    expect(ran).toEqual(["gio", "trash-put"]);
  });

  it("stops at the first command that succeeds", async () => {
    const ran: string[] = [];
    await moveToTrash(TARGET, async (command) => void ran.push(command.file), "linux");
    expect(ran).toEqual(["gio"]);
  });

  it("rethrows a failing command without trying the fallback", async () => {
    const ran: string[] = [];
    const failure = moveToTrash(
      TARGET,
      async (command) => {
        ran.push(command.file);
        throw new Error("gio could not move the item to the trash: Operation not supported");
      },
      "linux"
    );
    await expect(failure).rejects.toThrow("Operation not supported");
    expect(ran).toEqual(["gio"]);
  });

  it("reports an unsupported system when no command is installed", async () => {
    const failure = moveToTrash(TARGET, async (command) => Promise.reject(missing(command.file)), "linux");
    await expect(failure).rejects.toThrow("moving files to the trash is not supported on this system (install gio or trash-cli)");
  });
});
