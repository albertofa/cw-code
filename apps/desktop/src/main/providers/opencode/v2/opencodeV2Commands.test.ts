import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildV2CommandOptions,
  commandNameOf,
  directoryCommandTemplates,
  stripFrontmatter,
  templateHints,
  v2CommandEntries,
  v2ConfigCommandSources,
  v2SkillIds
} from "./opencodeV2Commands.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("v2 command hints", () => {
  it("extracts positional and $ARGUMENTS hints like v1", () => {
    expect(templateHints("Fix $2 then $1, $1 again: $ARGUMENTS")).toEqual(["$1", "$2", "$ARGUMENTS"]);
    expect(templateHints("No arguments here")).toEqual([]);
  });

  it("drops frontmatter before reading a template", () => {
    expect(stripFrontmatter("---\ndescription: uses $1\n---\nRun $ARGUMENTS\n")).toBe("Run $ARGUMENTS\n");
    expect(stripFrontmatter("\uFEFF---\r\nagent: build\r\n---\r\nBody $1")).toBe("Body $1");
    expect(stripFrontmatter("Plain $1")).toBe("Plain $1");
  });

  it("names directory commands by their path under command/ or commands/", () => {
    const root = join(tmpdir(), "cfg");
    expect(commandNameOf(root, join(root, "command", "git", "ship.md"))).toBe("git/ship");
    expect(commandNameOf(root, join(root, "commands", "test.md"))).toBe("test");
  });

  it("merges skills into the catalog after commands and skips duplicates", () => {
    const entries = v2CommandEntries(
      { location: { directory: "C:\\p" }, data: [{ name: "init", description: "setup" }, { name: "review" }] },
      { data: [{ id: "review", name: "Review" }, { id: "opencode", name: "OpenCode", description: "Docs" }] }
    );
    expect(entries).toEqual([
      { name: "init", description: "setup" },
      { name: "review", description: "" },
      { name: "opencode", description: "Docs", skill: "opencode" }
    ]);
  });

  it("resolves skill ids by id first, then by name, once each", () => {
    const skills = { data: [{ id: "plan-dir", name: "plan" }, { id: "debug", name: "Debug" }, null] };
    expect(v2SkillIds(skills, ["debug", "plan", "plan-dir", "missing"])).toEqual([{ id: "debug" }, { id: "plan-dir" }]);
    expect(v2SkillIds("garbage", ["plan"])).toEqual([]);
  });

  it("collects config templates and command directories from /api/config", () => {
    const sources = v2ConfigCommandSources([
      { type: "document", path: "C:\\cfg\\opencode.jsonc", info: { commands: { deploy: { template: "Deploy $1" }, broken: {} } } },
      { type: "directory", path: "C:\\cfg" }
    ]);
    expect([...sources.templates]).toEqual([["deploy", "Deploy $1"]]);
    expect(sources.directories).toEqual(["C:\\cfg"]);
  });

  it("reads markdown commands from a config directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "cw-v2-commands-"));
    dirs.push(root);
    mkdirSync(join(root, "command", "git"), { recursive: true });
    writeFileSync(join(root, "command", "git", "ship.md"), "---\ndescription: Ship\n---\nShip $1 to $2\n");
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", "notes.txt"), "ignored");
    const templates = await directoryCommandTemplates(root);
    expect([...templates]).toEqual([["git/ship", "Ship $1 to $2\n"]]);
  });

  it("builds options with builtin, template and missing hints", () => {
    const options = buildV2CommandOptions(
      [
        { name: "init", description: "setup" },
        { name: "deploy", description: "Deploy" },
        { name: "github:create-issue", description: "MCP prompt" },
        { name: "opencode", description: "Docs", skill: "opencode" }
      ],
      new Map([["deploy", "Deploy $1 now"]])
    );
    const byName = Object.fromEntries(options.map((o) => [o.name, o.argumentHint]));
    expect(byName).toMatchObject({ init: "[arguments]", deploy: "<arg1>" });
    expect(byName["github:create-issue"]).toBeUndefined();
    expect(byName["opencode"]).toBeUndefined();
    expect(options.filter((o) => o.kind === "skill").map((o) => o.name)).toEqual(["opencode"]);
    expect(options.slice(0, 3).map((o) => o.name)).toEqual(["compact", "undo", "redo"]);
  });
});
