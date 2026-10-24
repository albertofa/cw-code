import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { allowRestart, parseServerLine, serverCommand, splitLines } from "./serverProcess.js";

const READY = { url: "ws://127.0.0.1:51234/ws", port: 51234, pid: 4242, protocol: 1, version: "0.0.1-alpha.21" };

describe("parseServerLine", () => {
  it("reads the ready and already-running announcements", () => {
    expect(parseServerLine(`CW_SERVER_READY ${JSON.stringify(READY)}`)).toEqual({ kind: "ready", ready: READY });
    expect(parseServerLine(`CW_SERVER_RUNNING ${JSON.stringify(READY)}`)).toEqual({ kind: "running", ready: READY });
  });

  it("ignores ordinary output and malformed announcements", () => {
    expect(parseServerLine("harness trace: /tmp/trace.log")).toBeNull();
    expect(parseServerLine("CW_SERVER_READY {not json")).toBeNull();
    expect(parseServerLine(`CW_SERVER_READY ${JSON.stringify({ ...READY, port: "51234" })}`)).toBeNull();
    expect(parseServerLine(`CW_SERVER_READY ${JSON.stringify({ url: READY.url })}`)).toBeNull();
    expect(parseServerLine(` CW_SERVER_READY ${JSON.stringify(READY)}`)).toBeNull();
  });
});

describe("splitLines", () => {
  it("returns complete lines, strips carriage returns and keeps the partial tail", () => {
    const first = splitLines("", "one\r\ntw");
    expect(first).toEqual({ lines: ["one"], rest: "tw" });
    expect(splitLines(first.rest, "o\nthree\n")).toEqual({ lines: ["two", "three"], rest: "" });
  });
});

describe("allowRestart", () => {
  it("allows up to three restarts within the window", () => {
    let history: number[] = [];
    for (const at of [1_000, 2_000, 3_000]) {
      const next = allowRestart(history, at);
      expect(next).not.toBeNull();
      history = next ?? [];
    }
    expect(allowRestart(history, 4_000)).toBeNull();
  });

  it("forgets restarts older than the window", () => {
    expect(allowRestart([1_000, 2_000, 3_000], 61_500)).toEqual([2_000, 3_000, 61_500]);
  });
});

describe("serverCommand", () => {
  const args = ["--port", "0"];

  it("runs the bundled server binary with the packaged node-pty in packaged builds", () => {
    const resources = resolve("/opt/cw-code/resources");
    const command = serverCommand({ isPackaged: true, resourcesPath: resources, appPath: "", legacyUserData: "" }, "linux", { PATH: "/usr/bin" }, args);
    expect(command).toEqual({
      file: join(resources, "server", "cw-code-server"),
      args,
      env: { PATH: "/usr/bin", CW_NODE_PTY: join(resources, "server", "node_modules", "node-pty", "lib", "index.js") }
    });
    expect(serverCommand({ isPackaged: true, resourcesPath: resources, appPath: "", legacyUserData: "" }, "win32", {}, args).file).toBe(
      join(resources, "server", "cw-code-server.exe")
    );
  });

  it("runs the server sources with bun in development", () => {
    const appPath = resolve("/repo/apps/desktop");
    const launch = { isPackaged: false, resourcesPath: "", appPath, legacyUserData: "" };
    expect(serverCommand(launch, "win32", {}, args)).toEqual({ file: "bun.exe", args: [resolve("/repo/apps/server/src/index.ts"), ...args], env: {} });
    expect(serverCommand(launch, "linux", {}, args).file).toBe("bun");
    expect(serverCommand(launch, "linux", { CW_BUN: "/custom/bun", CW_SERVER_ENTRY: "/custom/entry.ts" }, args)).toMatchObject({
      file: "/custom/bun",
      args: ["/custom/entry.ts", ...args]
    });
  });
});
