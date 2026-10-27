import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotationPath } from "./logRotation.js";
import { initServerLog, serverLogPath } from "./serverLog.js";

const consoleBackup = { log: console.log, warn: console.warn, error: console.error };
let dir: string;
let dispose: () => void = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-server-log-"));
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  dispose();
  console.log = consoleBackup.log;
  console.warn = consoleBackup.warn;
  console.error = consoleBackup.error;
  rmSync(dir, { recursive: true, force: true });
});

describe("initServerLog", () => {
  it("tees console output to server.log with level and formatting", () => {
    dispose = initServerLog(dir);
    console.log("started %s", "ok");
    console.warn("careful", { a: 1 });
    console.error("boom");
    const lines = readFileSync(serverLogPath(dir), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\S+ \[log\] started ok$/);
    expect(lines[1]).toMatch(/\[warn\] careful \{ a: 1 \}$/);
    expect(lines[2]).toMatch(/\[error\] boom$/);
  });

  it("rotates the file when it grows past the limit", () => {
    dispose = initServerLog(dir, { maxBytes: 100 });
    for (let i = 0; i < 10; i += 1) console.log(`line ${i} ${"x".repeat(30)}`);
    expect(existsSync(rotationPath(serverLogPath(dir)))).toBe(true);
    expect(readFileSync(serverLogPath(dir), "utf8")).toContain("line 9");
  });

  it("stops logging after the returned disposer runs", () => {
    initServerLog(dir)();
    console.log("after");
    expect(existsSync(serverLogPath(dir))).toBe(false);
  });
});
