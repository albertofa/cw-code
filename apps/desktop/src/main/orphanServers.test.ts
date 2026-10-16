import { describe, expect, it, vi } from "vitest";
import {
  isManagedServerCommand,
  OWNER_PID_ENV,
  parseOwnerPid,
  reapOrphanedServers,
  selectOrphanServerPids,
  type ProcessSnapshot
} from "./orphanServers.js";

function proc(pid: number, ppid: number, command: string, ownerPid: number | null = null): ProcessSnapshot {
  return { pid, ppid, command, ownerPid };
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
    expect(selectOrphanServerPids(processes, "win32")).toEqual([41592, 2304]);
  });

  it("spares servers owned by a live ancestor chain", () => {
    const processes = [
      proc(4940, 46632, "opencode.exe serve --port 9 --hostname 127.0.0.1"),
      proc(46632, 39656, "cmd.exe /d /c opencode.cmd serve --port 9 --hostname 127.0.0.1"),
      proc(39656, 4752, "cw-code.exe")
    ];
    expect(selectOrphanServerPids(processes, "win32")).toEqual([]);
  });
});

describe("selectOrphanServerPids on linux", () => {
  const OWNER = 5000;
  const server = "/usr/bin/opencode serve --port 1 --hostname 127.0.0.1";

  it("selects servers reparented to init", () => {
    expect(selectOrphanServerPids([proc(100, 1, server, OWNER), proc(1, 0, "init")], "linux")).toEqual([100]);
  });

  it("selects servers reparented to a subreaper", () => {
    const processes = [proc(100, 700, server, OWNER), proc(700, 1, "systemd --user"), proc(1, 0, "init")];
    expect(selectOrphanServerPids(processes, "linux")).toEqual([100]);
  });

  it("spares servers still parented by the owner", () => {
    expect(selectOrphanServerPids([proc(100, OWNER, server, OWNER), proc(OWNER, 1, "cw-code")], "linux")).toEqual([]);
  });

  it("spares servers reached through a wrapper still owned by the owner", () => {
    const processes = [
      proc(101, 100, "/opt/codex/codex app-server", OWNER),
      proc(100, OWNER, "node /usr/lib/codex.js app-server", OWNER),
      proc(OWNER, 1, "cw-code")
    ];
    expect(selectOrphanServerPids(processes, "linux")).toEqual([]);
  });

  it("spares servers without an owner marker", () => {
    expect(selectOrphanServerPids([proc(100, 1, server, null)], "linux")).toEqual([]);
    expect(selectOrphanServerPids([proc(100, 1, server, null)], "darwin")).toEqual([]);
  });

  it("spares non-server commands even when they carry the marker", () => {
    expect(selectOrphanServerPids([proc(100, 1, "bash -lc echo", OWNER)], "linux")).toEqual([]);
  });
});

describe("parseOwnerPid", () => {
  it("reads the owner pid from a NUL-separated environ", () => {
    expect(parseOwnerPid(`PATH=/usr/bin\0${OWNER_PID_ENV}=4242\0HOME=/root\0`)).toBe(4242);
  });

  it("returns null when the marker is absent or malformed", () => {
    expect(parseOwnerPid("PATH=/usr/bin\0HOME=/root\0")).toBeNull();
    expect(parseOwnerPid(`${OWNER_PID_ENV}=abc\0`)).toBeNull();
    expect(parseOwnerPid(`${OWNER_PID_ENV}=0\0`)).toBeNull();
    expect(parseOwnerPid("")).toBeNull();
  });
});

describe("reapOrphanedServers", () => {
  it("kills only orphaned managed servers", async () => {
    const killed: number[] = [];
    const reaped = await reapOrphanedServers({
      platform: "win32",
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
