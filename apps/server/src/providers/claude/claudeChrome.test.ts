import { describe, expect, it, vi } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeGlobalConfigPath, readClaudeChromeDefault } from "./claudeChrome.js";

function writeConfig(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "claude-chrome-")), ".claude.json");
  writeFileSync(path, content);
  return path;
}

describe("claudeGlobalConfigPath", () => {
  it("defaults to ~/.claude.json", () => {
    expect(claudeGlobalConfigPath({})).toBe(join(homedir(), ".claude.json"));
  });

  it("follows CLAUDE_CONFIG_DIR", () => {
    expect(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: join("C:", "cfg") })).toBe(join("C:", "cfg", ".claude.json"));
  });
});

describe("readClaudeChromeDefault", () => {
  it("is true only when the CLI default is enabled", () => {
    expect(readClaudeChromeDefault(writeConfig(JSON.stringify({ claudeInChromeDefaultEnabled: true })))).toBe(true);
    expect(readClaudeChromeDefault(writeConfig(JSON.stringify({ claudeInChromeDefaultEnabled: false })))).toBe(false);
    expect(readClaudeChromeDefault(writeConfig(JSON.stringify({})))).toBe(false);
  });

  it("treats a missing config as off without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readClaudeChromeDefault(join(tmpdir(), "missing-claude-config", ".claude.json"))).toBe(false);
    expect(readClaudeChromeDefault(writeConfig("null"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns and degrades to off for unreadable or malformed config", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readClaudeChromeDefault(mkdtempSync(join(tmpdir(), "claude-chrome-dir-")))).toBe(false);
    expect(readClaudeChromeDefault(writeConfig("{not json"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
