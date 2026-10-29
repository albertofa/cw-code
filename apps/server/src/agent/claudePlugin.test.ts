import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePluginArgs, claudePluginFiles, writeClaudePlugin } from "./claudePlugin.js";

describe("claudePluginFiles", () => {
  it("declares the plugin name and version", () => {
    const manifest = JSON.parse(claudePluginFiles("1.2.3")[".claude-plugin/plugin.json"] ?? "");
    expect(manifest).toEqual({ name: "cw-code", version: "1.2.3", description: "cw-code session tools" });
  });

  it("points the cw MCP server at the environment-provided url and token", () => {
    const config = JSON.parse(claudePluginFiles("1.2.3")[".mcp.json"] ?? "");
    expect(config).toEqual({
      mcpServers: {
        cw: { type: "http", url: "${CW_MCP_URL}", headers: { Authorization: "Bearer ${CW_AGENT_TOKEN}" } }
      }
    });
  });

  it("ships a cw-code skill with frontmatter", () => {
    const skill = claudePluginFiles("1.2.3")["skills/cw-code/SKILL.md"] ?? "";
    expect(skill.startsWith("---\nname: cw-code\ndescription: ")).toBe(true);
    expect(skill).toContain("mcp__plugin_cw-code_cw__");
  });
});

describe("claudePluginArgs", () => {
  it("adds the plugin directory only when available", () => {
    expect(claudePluginArgs("C:\\plugin")).toEqual(["--plugin-dir", "C:\\plugin"]);
    expect(claudePluginArgs(null)).toEqual([]);
  });
});

describe("writeClaudePlugin", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cw-claude-plugin-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes every file and leaves unchanged files untouched on the next write", async () => {
    await writeClaudePlugin(dir, "1.0.0");
    for (const [relativePath, content] of Object.entries(claudePluginFiles("1.0.0"))) {
      expect(readFileSync(join(dir, ...relativePath.split("/")), "utf8")).toBe(content);
    }
    const mcpFile = join(dir, ".mcp.json");
    const past = new Date(Date.now() - 60_000);
    utimesSync(mcpFile, past, past);
    const before = statSync(mcpFile).mtimeMs;
    await writeClaudePlugin(dir, "1.0.0");
    expect(statSync(mcpFile).mtimeMs).toBe(before);
  });

  it("rewrites only the files whose content changed", async () => {
    await writeClaudePlugin(dir, "1.0.0");
    await writeClaudePlugin(dir, "2.0.0");
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).version).toBe("2.0.0");
  });
});
