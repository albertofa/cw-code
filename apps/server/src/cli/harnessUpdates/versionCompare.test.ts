import { describe, expect, it } from "bun:test";
import { compareVersions, isBehind } from "./versionCompare.js";

describe("compareVersions", () => {
  it("orders by major, minor, patch", () => {
    expect(compareVersions("2.1.3", "2.1.4")).toBe(-1);
    expect(compareVersions("2.2.0", "2.1.9")).toBe(1);
    expect(compareVersions("3.0.0", "2.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
  });

  it("reads the first x.y.z of each side", () => {
    expect(compareVersions("codex-cli 0.153.4", "v0.154.0")).toBe(-1);
    expect(compareVersions("2.1.3-beta.1", "2.1.3")).toBe(0);
  });

  it("returns 0 when either side is unparsable", () => {
    expect(compareVersions("unknown", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "")).toBe(0);
  });
});

describe("isBehind", () => {
  it("is true only when current is older", () => {
    expect(isBehind("2.1.312", "2.1.314")).toBe(true);
    expect(isBehind("2.1.314", "2.1.314")).toBe(false);
    expect(isBehind("2.1.315", "2.1.314")).toBe(false);
    expect(isBehind("garbage", "2.1.314")).toBe(false);
  });
});
