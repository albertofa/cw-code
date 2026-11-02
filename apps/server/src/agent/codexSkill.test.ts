import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCodexSkills } from "./codexSkill.js";
import { cwPrSkillMarkdown, cwSkillMarkdown } from "./cwSkill.js";

describe("writeCodexSkills", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cw-codex-skill-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes every Codex skill and leaves unchanged content untouched on the next write", async () => {
    const file = join(root, "cw-code", "SKILL.md");
    await writeCodexSkills(root);
    expect(readFileSync(file, "utf8")).toBe(cwSkillMarkdown("codex"));
    expect(readFileSync(join(root, "cw-code-prs", "SKILL.md"), "utf8")).toBe(cwPrSkillMarkdown("codex"));
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    const before = statSync(file).mtimeMs;
    await writeCodexSkills(root);
    expect(statSync(file).mtimeMs).toBe(before);
  });
});
