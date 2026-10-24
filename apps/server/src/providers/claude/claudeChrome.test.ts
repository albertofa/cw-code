import { describe, expect, it } from "bun:test";
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

  it("degrades to off for missing or malformed config", () => {
    expect(readClaudeChromeDefault(join(tmpdir(), "missing-claude-config", ".claude.json"))).toBe(false);
    expect(readClaudeChromeDefault(writeConfig("{not json"))).toBe(false);
    expect(readClaudeChromeDefault(writeConfig("null"))).toBe(false);
  });
});
