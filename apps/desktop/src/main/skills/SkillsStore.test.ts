import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillsStore } from "./SkillsStore.js";

function makeFixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cw-skills-home-"));
  const skillDir = join(home, ".claude", "skills", "claude-only");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: claude-only\ndescription: A Claude-only skill\n---\n\nDoes Claude things.\n",
    "utf8"
  );
  writeFileSync(join(skillDir, "scripts", "helper.sh"), "#!/bin/sh\necho hi\n", "utf8");
  return home;
}

function makeStore(home: string): { store: SkillsStore; userData: string } {
  const userData = mkdtempSync(join(tmpdir(), "cw-skills-userdata-"));
  return { store: new SkillsStore({ userDataDir: userData, homeDir: home }), userData };
}

describe("SkillsStore", () => {
  it("imports a Claude-only skill with only the claude harness enabled", async () => {
    const { store } = makeStore(makeFixtureHome());
    const result = await store.importSkills();
    const skill = result.skills.find((s) => s.name === "claude-only");
    expect(skill).toMatchObject({
      name: "claude-only",
      description: "A Claude-only skill",
      enabled: { claude: true, opencode: false, codex: false },
      sourceHarness: "claude",
      hasBody: true
    });
  });

  it("copies SKILL.md plus sidecars to canonical and to opencode on enable", async () => {
    const home = makeFixtureHome();
    const { store, userData } = makeStore(home);
    await store.importSkills();
    expect(existsSync(join(userData, "skills", "claude-only", "SKILL.md"))).toBe(true);

    const meta = await store.setSkillEnabled("claude-only", "opencode", true);
    expect(meta.enabled).toEqual({ claude: true, opencode: true, codex: false });

    const copied = join(home, ".config", "opencode", "skills", "claude-only", "SKILL.md");
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, "utf8")).toContain("A Claude-only skill");
    expect(existsSync(join(home, ".config", "opencode", "skills", "claude-only", "scripts", "helper.sh"))).toBe(true);

    const listed = await store.listSkills();
    expect(listed.skills.find((s) => s.name === "claude-only")?.enabled.opencode).toBe(true);
  });

  it("removes the harness dir on disable and reports drift as disabled", async () => {
    const home = makeFixtureHome();
    const { store } = makeStore(home);
    await store.importSkills();
    await store.setSkillEnabled("claude-only", "opencode", true);
    const target = join(home, ".config", "opencode", "skills", "claude-only");
    expect(existsSync(target)).toBe(true);

    const meta = await store.setSkillEnabled("claude-only", "opencode", false);
    expect(meta.enabled.opencode).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("removes a skill from the canonical store and every harness", async () => {
    const home = makeFixtureHome();
    const { store, userData } = makeStore(home);
    await store.importSkills();
    await store.setSkillEnabled("claude-only", "opencode", true);
    expect(existsSync(join(userData, "skills", "claude-only", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "skills", "claude-only", "SKILL.md"))).toBe(true);

    const result = await store.removeSkill("claude-only");
    expect(result.skills.some((s) => s.name === "claude-only")).toBe(false);
    expect(existsSync(join(userData, "skills", "claude-only"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "claude-only"))).toBe(false);
    expect(existsSync(join(home, ".config", "opencode", "skills", "claude-only"))).toBe(false);
    expect(JSON.parse(readFileSync(join(userData, "skills.json"), "utf8"))["claude-only"]).toBeUndefined();
    await expect(store.getSkill("claude-only")).rejects.toThrow(/unknown skill/);
  });

  it("rejects removing unknown skills and invalid names", async () => {
    const { store } = makeStore(makeFixtureHome());
    await expect(store.removeSkill("missing-skill")).rejects.toThrow(/unknown skill/);
    await expect(store.removeSkill("../escape")).rejects.toThrow(/invalid skill name/);
  });

  it("saves canonical content and re-copies to every enabled harness", async () => {
    const home = makeFixtureHome();
    const { store, userData } = makeStore(home);
    const detail = await store.saveSkill({
      name: "fresh-skill",
      description: "Freshly created",
      body: "Fresh body.\n",
      enabled: { claude: true, opencode: false, codex: false }
    });
    expect(detail.name).toBe("fresh-skill");
    expect(detail.sourceHarness).toBe("created");
    expect(readFileSync(join(userData, "skills", "fresh-skill", "SKILL.md"), "utf8")).toContain("Fresh body.");
    expect(existsSync(join(home, ".claude", "skills", "fresh-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "skills", "fresh-skill"))).toBe(false);
  });

  it("prunes newly-disabled harness copies on save", async () => {
    const home = makeFixtureHome();
    const { store, userData } = makeStore(home);
    await store.importSkills();
    await store.setSkillEnabled("claude-only", "opencode", true);
    const opencodeDir = join(home, ".config", "opencode", "skills", "claude-only");
    const claudeFile = join(home, ".claude", "skills", "claude-only", "SKILL.md");
    expect(existsSync(join(opencodeDir, "SKILL.md"))).toBe(true);

    const detail = await store.saveSkill({
      name: "claude-only",
      description: "Updated description",
      body: "Updated body.\n",
      enabled: { claude: true, opencode: false, codex: false }
    });
    expect(detail.description).toBe("Updated description");
    expect(detail.enabled).toEqual({ claude: true, opencode: false, codex: false });
    expect(existsSync(opencodeDir)).toBe(false);
    expect(readFileSync(claudeFile, "utf8")).toContain("Updated body.");
    expect(readFileSync(join(userData, "skills", "claude-only", "SKILL.md"), "utf8")).toContain("Updated body.");
  });

  it("dedupes a skill present in both claude and opencode roots with first-writer winning", async () => {
    const home = makeFixtureHome();
    const dupDir = join(home, ".config", "opencode", "skills", "claude-only");
    mkdirSync(dupDir, { recursive: true });
    writeFileSync(join(dupDir, "SKILL.md"), "---\nname: claude-only\ndescription: Opencode copy\n---\n\nOther body.\n", "utf8");
    const { store } = makeStore(home);
    const result = await store.importSkills();
    expect(result.skills.filter((s) => s.name === "claude-only")).toHaveLength(1);
    expect(result.skills.find((s) => s.name === "claude-only")).toMatchObject({
      enabled: { claude: true, opencode: false, codex: false },
      sourceHarness: "claude"
    });
  });

  it("round-trips extra frontmatter keys through save", async () => {
    const { store, userData } = makeStore(makeFixtureHome());
    const saved = await store.saveSkill({
      name: "extra-props",
      description: "Has extras",
      body: "Body here.\n",
      enabled: { claude: true, opencode: true, codex: false },
      frontmatter: { license: "MIT", audience: "devs", name: "spoofed", description: "spoofed" }
    });
    expect(saved.frontmatter).toMatchObject({
      name: "extra-props",
      description: "Has extras",
      license: "MIT",
      audience: "devs"
    });
    const raw = readFileSync(join(userData, "skills", "extra-props", "SKILL.md"), "utf8");
    expect(raw).toContain("license: MIT");
    expect(raw).not.toContain("spoofed");

    const detail = await store.getSkill("extra-props");
    const resaved = await store.saveSkill({
      name: detail.name,
      description: "Updated description",
      body: detail.body,
      enabled: detail.enabled,
      frontmatter: detail.frontmatter
    });
    expect(resaved.frontmatter).toMatchObject({
      name: "extra-props",
      description: "Updated description",
      license: "MIT",
      audience: "devs"
    });
  });

  it("rejects invalid skill names", async () => {
    const { store } = makeStore(makeFixtureHome());
    await expect(store.getSkill("../escape")).rejects.toThrow(/invalid skill name/);
    await expect(store.setSkillEnabled("nope/missing", "claude", true)).rejects.toThrow(/invalid skill name/);
  });
});
