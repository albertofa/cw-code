import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCrashLog, initCrashLog } from "./crashLog.js";
import { rotationPath } from "./logRotation.js";

function initTmp(maxBytes?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-crash-"));
  return initCrashLog(dir, maxBytes === undefined ? undefined : { maxBytes });
}

function readEntries(filePath: string): string[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(" ") + 1));
}

describe("rotationPath", () => {
  it("inserts .1 before the extension", () => {
    expect(rotationPath(join("logs", "crash.log"))).toBe(join("logs", "crash.1.log"));
    expect(rotationPath(join("logs", "harness-trace.jsonl"))).toBe(join("logs", "harness-trace.1.jsonl"));
    expect(rotationPath(join("logs", "trace"))).toBe(join("logs", "trace.1"));
  });
});

describe("appendCrashLog", () => {
  it("collapses consecutive identical entries into a repeat summary", () => {
    const filePath = initTmp();
    appendCrashLog("renderer error: boom");
    appendCrashLog("renderer error: boom");
    appendCrashLog("renderer error: boom");
    appendCrashLog("window unresponsive");
    appendCrashLog("renderer error: boom");
    expect(readEntries(filePath)).toEqual([
      "renderer error: boom",
      "previous entry repeated 2 more times",
      "window unresponsive",
      "renderer error: boom"
    ]);
  });

  it("rotates to a .1 file once the log exceeds maxBytes", () => {
    const filePath = initTmp(64);
    writeFileSync(filePath, "x".repeat(100), "utf8");
    appendCrashLog("after rotation");
    expect(readFileSync(rotationPath(filePath), "utf8")).toBe("x".repeat(100));
    expect(readEntries(filePath)).toEqual(["after rotation"]);
  });

  it("keeps appending while under maxBytes", () => {
    const filePath = initTmp(1024);
    appendCrashLog("one");
    appendCrashLog("two");
    expect(existsSync(rotationPath(filePath))).toBe(false);
    expect(readEntries(filePath)).toEqual(["one", "two"]);
  });
});
