import { describe, expect, it } from "vitest";
import type { CliBinary } from "@cw-code/contracts";
import { candidatePaths } from "./binaryDiscovery.js";
import type { CandidatePathsOptions } from "./binaryDiscovery.js";

const POSIX_OPTS: CandidatePathsOptions = {
  platform: "linux",
  homeDir: "/home/testuser",
  env: {}
};

const WIN_OPTS: CandidatePathsOptions = {
  platform: "win32",
  homeDir: "C:\\Users\\testuser",
  env: {
    APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
    USERPROFILE: "C:\\Users\\testuser",
    PROGRAMDATA: "C:\\ProgramData",
    PROGRAMFILES: "C:\\Program Files"
  }
};

describe("candidatePaths on posix", () => {
  for (const platform of ["linux", "darwin"] as const) {
    it(`lists well-known locations on ${platform}`, () => {
      const paths = candidatePaths("claude", { ...POSIX_OPTS, platform });
      expect(paths[0]).toBe("claude");
      for (const dir of [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/home/testuser/.local/bin",
        "/home/testuser/bin",
        "/home/testuser/.npm-global/bin"
      ]) {
        expect(paths).toContain(`${dir}/claude`);
      }
      expect(new Set(paths).size).toBe(paths.length);
    });
  }

  it("scopes home-only install dirs per binary", () => {
    expect(candidatePaths("opencode", POSIX_OPTS)).toContain("/home/testuser/.opencode/bin/opencode");
    expect(candidatePaths("claude", POSIX_OPTS)).toContain("/home/testuser/.claude/local/claude");
    expect(candidatePaths("codex", POSIX_OPTS)).not.toContain("/home/testuser/.opencode/bin/opencode");
    expect(candidatePaths("codex", POSIX_OPTS)).not.toContain("/home/testuser/.claude/local/claude");
    expect(candidatePaths("git", POSIX_OPTS)).toContain("/usr/bin/git");
  });
});

describe("candidatePaths on win32", () => {
  it("expands env vars and includes per-binary executable forms", () => {
    const paths = candidatePaths("claude", WIN_OPTS);
    expect(paths).toContain("claude");
    expect(paths).toContain("claude.exe");
    expect(paths).toContain("claude.cmd");
    expect(paths).toContain("claude.ps1");
    expect(paths).toContain("C:\\Users\\testuser\\AppData\\Roaming\\npm\\claude.cmd");
    expect(paths).toContain("C:\\Users\\testuser\\AppData\\Roaming\\npm\\claude.ps1");
    expect(paths).toContain("C:\\Users\\testuser\\AppData\\Roaming\\npm\\claude.exe");
    expect(paths).toContain("C:\\Users\\testuser\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe");
    expect(paths).toContain("C:\\Users\\testuser\\scoop\\shims\\claude.exe");
    expect(paths).toContain("C:\\ProgramData\\chocolatey\\bin\\claude.exe");
  });

  it("includes tool-specific install locations", () => {
    expect(candidatePaths("opencode", WIN_OPTS)).toContain(
      "C:\\Users\\testuser\\.opencode\\bin\\opencode.exe"
    );
    expect(candidatePaths("git", WIN_OPTS)).toContain("C:\\Program Files\\Git\\bin\\git.exe");
    expect(candidatePaths("gh", WIN_OPTS)).toContain("C:\\Program Files\\GitHub CLI\\gh.exe");
  });

  it("derives win32 locations from homeDir when env vars are missing", () => {
    const paths = candidatePaths("claude", { platform: "win32", homeDir: "D:\\work\\me", env: {} });
    expect(paths).toContain("D:\\work\\me\\AppData\\Roaming\\npm\\claude.cmd");
    expect(paths).toContain("D:\\work\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe");
    expect(paths).toContain("D:\\work\\me\\scoop\\shims\\claude.exe");
  });

  it("dedupes case-insensitively and normalizes separators", () => {
    const paths = candidatePaths("opencode", {
      platform: "win32",
      homeDir: "C:\\Users\\TestUser",
      env: {
        USERPROFILE: "c:\\users\\testuser",
        APPDATA: "C:/Users/testuser/AppData/Roaming/"
      }
    });
    expect(paths).toContain("C:\\Users\\testuser\\AppData\\Roaming\\npm\\opencode.cmd");
    expect(paths.filter((p) => p.toLowerCase().includes("scoop\\shims"))).toHaveLength(3);
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length);
  });
});

describe("candidatePaths fallback", () => {
  it("falls back to the bare name for unknown binaries", () => {
    expect(candidatePaths("mystery-tool" as CliBinary, POSIX_OPTS)).toEqual(["mystery-tool"]);
    expect(candidatePaths("mystery-tool" as CliBinary, WIN_OPTS)).toEqual(["mystery-tool"]);
  });
});
