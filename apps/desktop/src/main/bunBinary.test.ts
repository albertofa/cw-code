import { describe, expect, it } from "bun:test";
import { resolveBunBinary, type BunLookup } from "./bunBinary.js";

function lookup(overrides: Partial<BunLookup> & { existing?: string[] } = {}): BunLookup {
  const existing = new Set(overrides.existing ?? []);
  return {
    env: overrides.env ?? {},
    platform: overrides.platform ?? "win32",
    homeDir: overrides.homeDir ?? "C:\\Users\\dev",
    exists: overrides.exists ?? ((path) => existing.has(path))
  };
}

describe("resolveBunBinary", () => {
  it("prefers CW_BUN over everything else", () => {
    const env = { CW_BUN: " D:\\tools\\bun.exe ", npm_execpath: "C:\\Users\\dev\\.bun\\bin\\bun.exe", BUN_INSTALL: "E:\\bun" };
    expect(resolveBunBinary(lookup({ env, existing: ["E:\\bun\\bin\\bun.exe"] }))).toBe("D:\\tools\\bun.exe");
  });

  it("uses npm_execpath when bun launched the script", () => {
    expect(resolveBunBinary(lookup({ env: { npm_execpath: "C:\\Users\\dev\\.bun\\bin\\bun.exe" } }))).toBe("C:\\Users\\dev\\.bun\\bin\\bun.exe");
    expect(resolveBunBinary(lookup({ platform: "linux", homeDir: "/home/dev", env: { npm_execpath: "/home/dev/.bun/bin/bun" } }))).toBe(
      "/home/dev/.bun/bin/bun"
    );
  });

  it("ignores npm_execpath when another package manager launched the script", () => {
    const env = { npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" };
    expect(resolveBunBinary(lookup({ env }))).toBe("bun.exe");
  });

  it("falls back to BUN_INSTALL when the binary exists there", () => {
    const env = { BUN_INSTALL: "E:\\bun" };
    expect(resolveBunBinary(lookup({ env, existing: ["E:\\bun\\bin\\bun.exe", "C:\\Users\\dev\\.bun\\bin\\bun.exe"] }))).toBe("E:\\bun\\bin\\bun.exe");
    expect(resolveBunBinary(lookup({ env, existing: ["C:\\Users\\dev\\.bun\\bin\\bun.exe"] }))).toBe("C:\\Users\\dev\\.bun\\bin\\bun.exe");
  });

  it("falls back to ~/.bun/bin when the binary exists there", () => {
    expect(resolveBunBinary(lookup({ existing: ["C:\\Users\\dev\\.bun\\bin\\bun.exe"] }))).toBe("C:\\Users\\dev\\.bun\\bin\\bun.exe");
    expect(resolveBunBinary(lookup({ platform: "linux", homeDir: "/home/dev", existing: ["/home/dev/.bun/bin/bun"] }))).toBe("/home/dev/.bun/bin/bun");
  });

  it("falls back to bun from PATH", () => {
    expect(resolveBunBinary(lookup())).toBe("bun.exe");
    expect(resolveBunBinary(lookup({ platform: "darwin", homeDir: "/Users/dev" }))).toBe("bun");
  });
});
