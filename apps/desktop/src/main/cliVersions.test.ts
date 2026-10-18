import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCliVersion, checkCliVersions, isBinaryUnavailableError, meetsMinimum, minimumVersionFor } from "./cliVersions.js";

describe("meetsMinimum", () => {
  it("accepts the exact minimum version", () => {
    expect(meetsMinimum("2.1.260", "2.1.260")).toBe(true);
  });

  it("accepts a newer patch than the minimum (claude 2.1.266 vs 2.1.260)", () => {
    expect(meetsMinimum("2.1.266", "2.1.260")).toBe(true);
  });

  it("accepts newer minor and major versions", () => {
    expect(meetsMinimum("2.2.0", "2.1.260")).toBe(true);
    expect(meetsMinimum("3.0.0", "2.1.260")).toBe(true);
  });

  it("compares numerically, not lexicographically", () => {
    expect(meetsMinimum("2.1.9", "2.1.10")).toBe(false);
    expect(meetsMinimum("2.1.10", "2.1.9")).toBe(true);
  });

  it("rejects an older version (opencode 1.17.14 vs 1.18.23)", () => {
    expect(meetsMinimum("1.17.14", "1.18.23")).toBe(false);
  });

  it("rejects a missing binary", () => {
    expect(meetsMinimum(null, "1.18.23")).toBe(false);
  });

  it("falls back to exact equality for non-semver output", () => {
    expect(meetsMinimum("nightly", "nightly")).toBe(true);
    expect(meetsMinimum("nightly", "1.18.23")).toBe(false);
  });
});

describe("isBinaryUnavailableError", () => {
  it("recognizes missing, inaccessible, and invalid executables", () => {
    for (const code of ["ENOENT", "EACCES", "EINVAL", "EPERM"]) {
      expect(isBinaryUnavailableError({ code })).toBe(true);
    }
  });

  it("does not classify command failures and timeouts as missing executables", () => {
    expect(isBinaryUnavailableError({ code: 1 })).toBe(false);
    expect(isBinaryUnavailableError({ code: "ETIMEDOUT" })).toBe(false);
  });
});

describe("checkCliVersions", () => {
  it("accepts an executable that responds to --version even when it is below the CLI minimum", async () => {
    const check = await checkCliVersion("claude", process.execPath);
    expect(check).toMatchObject({ binaryPath: process.execPath, configured: true, found: true, available: true, error: null });
    expect(check.actual).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports a binary missing from PATH as not found", async () => {
    const check = await checkCliVersion("codex", "cw-code-missing-harness");
    expect(check).toMatchObject({ found: false, available: false, ok: false });
  });

  it.skipIf(process.platform !== "win32")("probes a Windows .cmd shim through cmd.exe", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-version-")), "cli.cmd");
    writeFileSync(file, "@echo 1.2.3\r\n", "utf8");
    const checks = await checkCliVersions({ claudeBinary: file, opencodeBinary: file, codexBinary: file });
    expect(checks).toHaveLength(3);
    expect(checks.every((check) => check.available && check.error === null)).toBe(true);
    expect(checks.every((check) => check.actual === "1.2.3")).toBe(true);
  });
});

describe("minimumVersionFor", () => {
  it("gates opencode v1 and v2 by their own minimums", () => {
    expect(minimumVersionFor("opencode", "1.19.3")).toBe("1.18.31");
    expect(minimumVersionFor("opencode", "2.0.32")).toBe("2.0.32");
    expect(minimumVersionFor("opencode", null)).toBe("1.18.31");
  });

  it("rejects a v2 build older than the v2 minimum even though it beats the v1 minimum", () => {
    expect(meetsMinimum("2.0.20", minimumVersionFor("opencode", "2.0.20"))).toBe(false);
    expect(meetsMinimum("2.0.32", minimumVersionFor("opencode", "2.0.32"))).toBe(true);
  });

  it("keeps a single minimum for the other CLIs", () => {
    expect(minimumVersionFor("claude", "9.0.0")).toBe("2.1.260");
    expect(minimumVersionFor("codex", "0.200.0")).toBe("0.153.4");
  });
});
