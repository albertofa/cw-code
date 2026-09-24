import { describe, expect, it, vi } from "vitest";
import {
  isManagedServerCommand,
  reapOrphanedServers,
  selectOrphanServerPids,
  type ProcessSnapshot
} from "./orphanServers.js";

function proc(pid: number, ppid: number, command: string): ProcessSnapshot {
  return { pid, ppid, command };
}

describe("isManagedServerCommand", () => {
  it("matches opencode serve servers", () => {
    expect(
      isManagedServerCommand('"C:\\nvm4w\\nodejs\\\\node_modules\\opencode-ai\\bin\\opencode.exe"    serve --port 58060 --hostname 127.0.0.1')
    ).toBe(true);
    expect(isManagedServerCommand("cmd.exe /d /c C:\\nvm4w\\nodejs\\opencode.cmd serve --port 58060 --hostname 127.0.0.1")).toBe(true);
  });

  it("matches codex app-server chains", () => {
    expect(isManagedServerCommand('"C:\\nvm4w\\nodejs\\\\node.exe"   "C:\\nvm4w\\nodejs\\\\node_modules\\@openai\\codex\\bin\\codex.js" app-server')).toBe(true);
    expect(isManagedServerCommand("codex.exe app-server")).toBe(true);
  });

  it("ignores interactive sessions, shells and unrelated processes", () => {
    expect(isManagedServerCommand("opencode --session abc123")).toBe(false);
    expect(isManagedServerCommand("powershell.exe -NoLogo")).toBe(false);
    expect(isManagedServerCommand("")).toBe(false);
  });
});

describe("selectOrphanServerPids", () => {
  it("selects managed servers whose parent is gone", () => {
    const processes = [
      proc(39656, 4752, "cw-code.exe"),
      proc(32312, 39656, "cmd.exe /d /c opencode.cmd serve --port 1 --hostname 127.0.0.1"),
      proc(38288, 32312, "opencode.exe serve --port 1 --hostname 127.0.0.1"),
      proc(41592, 13392, "opencode.exe serve --port 2 --hostname 127.0.0.1"),
      proc(2304, 11060, "opencode.exe serve --port 3 --hostname 127.0.0.1")
    ];
    expect(selectOrphanServerPids(processes)).toEqual([41592, 2304]);
  });

  it("spares servers owned by a live ancestor chain", () => {
    const processes = [
      proc(4940, 46632, "opencode.exe serve --port 9 --hostname 127.0.0.1"),
      proc(46632, 39656, "cmd.exe /d /c opencode.cmd serve --port 9 --hostname 127.0.0.1"),
      proc(39656, 4752, "cw-code.exe")
    ];
    expect(selectOrphanServerPids(processes)).toEqual([]);
  });
});

describe("reapOrphanedServers", () => {
  it("kills only orphaned managed servers", async () => {
    const killed: number[] = [];
    const reaped = await reapOrphanedServers({
      listProcesses: async () => [
        proc(100, 99991, "opencode.exe serve --port 1 --hostname 127.0.0.1"),
        proc(1, 0, "init")
      ],
      killPid: (pid) => {
        killed.push(pid);
      }
    });
    expect(reaped).toEqual([100]);
    expect(killed).toEqual([100]);
  });

  it("propagates listing failures to the caller", async () => {
    const killPid = vi.fn();
    await expect(
      reapOrphanedServers({
        listProcesses: async () => {
          throw new Error("ps failed");
        },
        killPid
      })
    ).rejects.toThrow("ps failed");
    expect(killPid).not.toHaveBeenCalled();
  });
});
