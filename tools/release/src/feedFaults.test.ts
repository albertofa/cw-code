import { describe, expect, it } from "vitest";
import { FaultPlan, corruptChunk, parseFaults } from "./feedFaults.ts";

describe("parseFaults", () => {
  it("accepts every fault type with defaults", () => {
    expect(
      parseFaults([
        { type: "unavailable", path: "alpha.yml" },
        { type: "unavailable", path: "latest.yml", mode: "reset", times: 2 },
        { type: "missing", path: "*.blockmap" },
        { type: "truncate", path: "*.exe", bytes: 1024 },
        { type: "corrupt", path: "*.exe" },
        { type: "stale-manifest", path: "alpha.yml", serve: "stale/alpha.yml" },
        { type: "slow", path: "*.exe", bytesPerSecond: 65536 }
      ])
    ).toEqual([
      { type: "unavailable", path: "alpha.yml", mode: "503", times: null },
      { type: "unavailable", path: "latest.yml", mode: "reset", times: 2 },
      { type: "missing", path: "*.blockmap", times: null },
      { type: "truncate", path: "*.exe", bytes: 1024, times: null },
      { type: "corrupt", path: "*.exe", offset: 0, length: 1, times: null },
      { type: "stale-manifest", path: "alpha.yml", serve: "stale/alpha.yml", times: null },
      { type: "slow", path: "*.exe", bytesPerSecond: 65536, times: null }
    ]);
  });

  it("treats a missing fault list as no faults", () => {
    expect(parseFaults(undefined)).toEqual([]);
    expect(parseFaults(null)).toEqual([]);
  });

  it.each([
    ["not an array", { type: "missing", path: "a" }],
    ["unknown type", [{ type: "explode", path: "a" }]],
    ["missing path", [{ type: "missing" }]],
    ["traversal in path", [{ type: "missing", path: "../a" }]],
    ["absolute path", [{ type: "missing", path: "/a" }]],
    ["drive letter", [{ type: "missing", path: "C:/a" }]],
    ["pattern as stale target", [{ type: "stale-manifest", path: "alpha.yml", serve: "*.yml" }]],
    ["traversal in stale target", [{ type: "stale-manifest", path: "alpha.yml", serve: "../alpha.yml" }]],
    ["negative truncate", [{ type: "truncate", path: "a", bytes: -1 }]],
    ["fractional corrupt offset", [{ type: "corrupt", path: "a", offset: 1.5 }]],
    ["zero corrupt length", [{ type: "corrupt", path: "a", length: 0 }]],
    ["zero rate", [{ type: "slow", path: "a", bytesPerSecond: 0 }]],
    ["zero times", [{ type: "missing", path: "a", times: 0 }]],
    ["bad unavailable mode", [{ type: "unavailable", path: "a", mode: "timeout" }]]
  ])("rejects %s", (_label, raw) => {
    expect(() => parseFaults(raw)).toThrow();
  });
});

describe("FaultPlan", () => {
  it("matches exact paths and single-segment wildcards", () => {
    const plan = new FaultPlan(parseFaults([{ type: "missing", path: "*.blockmap" }]));
    expect(plan.take("cw-code-Setup-1.0.0-x64.exe.blockmap")?.type).toBe("missing");
    expect(plan.take("nested/cw-code-Setup-1.0.0-x64.exe.blockmap")).toBeNull();
    expect(plan.take("cw-code-Setup-1.0.0-x64.exe")).toBeNull();
  });

  it("applies a limited fault only the given number of times, then falls through", () => {
    const plan = new FaultPlan(
      parseFaults([
        { type: "unavailable", path: "alpha.yml", times: 2 },
        { type: "slow", path: "alpha.yml", bytesPerSecond: 10 }
      ])
    );
    expect(plan.take("alpha.yml")?.type).toBe("unavailable");
    expect(plan.take("alpha.yml")?.type).toBe("unavailable");
    expect(plan.take("alpha.yml")?.type).toBe("slow");
    expect(plan.take("alpha.yml")?.type).toBe("slow");
  });

  it("escapes regular expression characters in patterns", () => {
    const plan = new FaultPlan(parseFaults([{ type: "missing", path: "a.yml" }]));
    expect(plan.take("abyml")).toBeNull();
    expect(plan.take("a.yml")?.type).toBe("missing");
  });
});

describe("corruptChunk", () => {
  it("flips only the bytes of the fault window that fall inside the chunk", () => {
    const chunk = Buffer.from([0, 1, 2, 3]);
    expect([...corruptChunk(chunk, 10, { offset: 11, length: 2 })]).toEqual([0, 0xfe, 0xfd, 3]);
    expect([...corruptChunk(chunk, 10, { offset: 8, length: 3 })]).toEqual([0xff, 1, 2, 3]);
    expect([...corruptChunk(chunk, 10, { offset: 14, length: 3 })]).toEqual([0, 1, 2, 3]);
    expect([...chunk]).toEqual([0, 1, 2, 3]);
  });
});
