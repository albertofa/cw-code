import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getHarnessTracePath,
  initHarnessTrace,
  previewText,
  resetHarnessTraceForTests,
  sanitizeArgs,
  traceHarnessCall,
  truncateError
} from "./harnessTrace.js";

beforeEach(() => {
  resetHarnessTraceForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetHarnessTraceForTests();
});

function initTmp(maxBytes?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-trace-"));
  const filePath = join(dir, "harness-trace.jsonl");
  initHarnessTrace(maxBytes === undefined ? { filePath } : { filePath, maxBytes });
  expect(getHarnessTracePath()).toBe(filePath);
  return filePath;
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("previewText", () => {
  it("returns the full text with its length when short", () => {
    expect(previewText("hello")).toEqual({ preview: "hello", length: 5 });
  });

  it("truncates to 500 chars but keeps the full length", () => {
    const text = "x".repeat(600);
    const out = previewText(text);
    expect(out.preview.length).toBe(500);
    expect(out.length).toBe(600);
  });
});

describe("truncateError", () => {
  it("passes short errors through", () => {
    expect(truncateError("boom")).toBe("boom");
  });

  it("truncates long errors with a length suffix", () => {
    const out = truncateError("e".repeat(2500));
    expect(out.length).toBeLessThan(2500);
    expect(out).toContain("[len=2500]");
  });
});

describe("sanitizeArgs", () => {
  it("truncates a single long arg", () => {
    const long = "p".repeat(600);
    const [out] = sanitizeArgs([long]);
    expect(out.length).toBeLessThan(600);
    expect(out).toContain("[len=600]");
  });

  it("redacts basic auth headers and password assignments", () => {
    expect(sanitizeArgs(["Basic b3BlbmNvZGU6c2VjcmV0"])).toEqual(["Basic [redacted]"]);
    expect(sanitizeArgs(["OPENCODE_SERVER_PASSWORD=hunter2"])).toEqual([
      "OPENCODE_SERVER_PASSWORD=[redacted]"
    ]);
  });
});

describe("traceHarnessCall", () => {
  it("appends valid JSONL with seq and ts", () => {
    const filePath = initTmp();
    traceHarnessCall({ harness: "claude", operation: "claude.startTurn", turnId: "t1", ok: true });
    traceHarnessCall({ harness: "claude", operation: "claude.startTurn", turnId: "t2", ok: false });
    const lines = readLines(filePath);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ seq: 0, harness: "claude", turnId: "t1", ok: true });
    expect(lines[1]).toMatchObject({ seq: 1, turnId: "t2", ok: false });
    expect(typeof lines[0]["ts"]).toBe("string");
  });

  it("rotates to a .1 file when over maxBytes", () => {
    const filePath = initTmp(10);
    traceHarnessCall({ harness: "system", operation: "cli.checkVersions", ok: true });
    traceHarnessCall({ harness: "system", operation: "cli.checkVersions", ok: true });
    const rotated = filePath.replace(/\.jsonl$/, ".1.jsonl");
    expect(readLines(rotated).length).toBe(1);
    expect(readLines(filePath).length).toBe(1);
  });

  it("never throws when the file cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-trace-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a dir", "utf8");
    initHarnessTrace({ filePath: join(blocker, "harness-trace.jsonl") });
    expect(() => traceHarnessCall({ harness: "system", operation: "pty.open", ok: false })).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
  });
});
