import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachmentsDir,
  cwCodeHome,
  ensureAppDirs,
  logsDir,
  migrateFromUserData,
  opencodeConfigDir,
  opencodeServerDir,
  skillsDir,
  titleGenDir,
  userdataDir,
  worktreesDir
} from "./appPaths.js";

describe("cwCodeHome", () => {
  it("defaults to ~/.cw-code", () => {
    expect(cwCodeHome(undefined, {})).toBe(normalize(join(homedir(), ".cw-code")));
  });

  it("honors CW_CODE_HOME trimmed", () => {
    const base = mkdtempSync(join(tmpdir(), "cw-home-"));
    expect(cwCodeHome(undefined, { CW_CODE_HOME: `  ${base}  ` })).toBe(normalize(base));
  });

  it("ignores blank CW_CODE_HOME", () => {
    expect(cwCodeHome(undefined, { CW_CODE_HOME: "   " })).toBe(normalize(join(homedir(), ".cw-code")));
  });

  it("expands ~ in CW_CODE_HOME", () => {
    expect(cwCodeHome(undefined, { CW_CODE_HOME: "~/custom-home" })).toBe(
      normalize(join(homedir(), "custom-home"))
    );
  });

  it("prefers the explicit home arg over env", () => {
    const base = mkdtempSync(join(tmpdir(), "cw-home-"));
    expect(cwCodeHome(base, { CW_CODE_HOME: "/ignored" })).toBe(normalize(base));
  });
});

describe("layout", () => {
  it("lays out dirs under the default home", () => {
    const home = normalize(join(homedir(), ".cw-code"));
    const userdata = normalize(join(home, "userdata"));
    expect(userdataDir(undefined, {})).toBe(userdata);
    expect(attachmentsDir(undefined, {})).toBe(join(userdata, "attachments"));
    expect(logsDir(undefined, {})).toBe(join(home, "logs"));
    expect(worktreesDir(undefined, {})).toBe(join(home, "worktrees"));
    expect(opencodeConfigDir(undefined, {})).toBe(join(userdata, "cw-opencode"));
    expect(opencodeServerDir(undefined, {})).toBe(join(userdata, "cw-opencode-server"));
    expect(skillsDir(undefined, {})).toBe(join(userdata, "skills"));
    expect(titleGenDir(undefined, {})).toBe(join(userdata, "title-gen"));
  });

  it("lays out dirs under CW_CODE_HOME", () => {
    const base = mkdtempSync(join(tmpdir(), "cw-home-"));
    const env = { CW_CODE_HOME: base };
    const userdata = join(normalize(base), "userdata");
    expect(cwCodeHome(undefined, env)).toBe(normalize(base));
    expect(userdataDir(undefined, env)).toBe(userdata);
    expect(attachmentsDir(undefined, env)).toBe(join(userdata, "attachments"));
    expect(logsDir(undefined, env)).toBe(join(normalize(base), "logs"));
    expect(worktreesDir(undefined, env)).toBe(join(normalize(base), "worktrees"));
    expect(opencodeConfigDir(undefined, env)).toBe(join(userdata, "cw-opencode"));
    expect(opencodeServerDir(undefined, env)).toBe(join(userdata, "cw-opencode-server"));
    expect(skillsDir(undefined, env)).toBe(join(userdata, "skills"));
    expect(titleGenDir(undefined, env)).toBe(join(userdata, "title-gen"));
  });

  it("keeps attachments inside userdata", () => {
    const base = mkdtempSync(join(tmpdir(), "cw-home-"));
    expect(attachmentsDir(base)).toBe(join(userdataDir(base), "attachments"));
  });
});

describe("ensureAppDirs", () => {
  it("creates base, userdata, attachments, logs, and worktrees", () => {
    const base = join(mkdtempSync(join(tmpdir(), "cw-home-")), "nested", "home");
    const dirs = ensureAppDirs(base);
    expect(dirs).toEqual({
      home: normalize(base),
      userdata: join(normalize(base), "userdata"),
      attachments: join(normalize(base), "userdata", "attachments"),
      logs: join(normalize(base), "logs"),
      worktrees: join(normalize(base), "worktrees")
    });
    for (const dir of [dirs.home, dirs.userdata, dirs.attachments, dirs.logs, dirs.worktrees]) {
      expect(existsSync(dir)).toBe(true);
    }
  });
});

describe("migrateFromUserData", () => {
  function makeOldUserData(): string {
    const dir = mkdtempSync(join(tmpdir(), "cw-old-userdata-"));
    writeFileSync(join(dir, "cw-code.db.json"), '{"sessions":[]}');
    writeFileSync(join(dir, "cw-settings.json"), "{}");
    writeFileSync(join(dir, "skills.json"), "{}");
    writeFileSync(join(dir, "crash.log"), "boom");
    writeFileSync(join(dir, "harness-trace.jsonl"), "{}\n");
    mkdirSync(join(dir, "skills", "my-skill"), { recursive: true });
    writeFileSync(join(dir, "skills", "my-skill", "SKILL.md"), "skill");
    mkdirSync(join(dir, "cw-opencode"), { recursive: true });
    writeFileSync(join(dir, "cw-opencode", "opencode.json"), "{}");
    mkdirSync(join(dir, "cw-opencode-server"), { recursive: true });
    writeFileSync(join(dir, "cw-opencode-server", "state.json"), "{}");
    return dir;
  }

  it("copies missing files and trees to the new locations", () => {
    const oldDir = makeOldUserData();
    const home = mkdtempSync(join(tmpdir(), "cw-new-home-"));
    const result = migrateFromUserData(oldDir, home);
    expect(result.copied).toContain("cw-code.db.json");
    expect(result.copied).toContain("skills");
    expect(result.copied).toContain("cw-opencode");
    expect(readFileSync(join(home, "userdata", "cw-code.db.json"), "utf8")).toBe('{"sessions":[]}');
    expect(readFileSync(join(home, "userdata", "skills", "my-skill", "SKILL.md"), "utf8")).toBe("skill");
    expect(readFileSync(join(home, "userdata", "cw-opencode", "opencode.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(home, "logs", "crash.log"), "utf8")).toBe("boom");
    expect(readFileSync(join(home, "logs", "harness-trace.jsonl"), "utf8")).toBe("{}\n");
  });

  it("copies the rotated harness trace when present", () => {
    const oldDir = makeOldUserData();
    writeFileSync(join(oldDir, "harness-trace.1.jsonl"), "{}\n");
    const home = mkdtempSync(join(tmpdir(), "cw-new-home-"));
    const result = migrateFromUserData(oldDir, home);
    expect(result.copied).toContain("harness-trace.1.jsonl");
    expect(readFileSync(join(home, "logs", "harness-trace.1.jsonl"), "utf8")).toBe("{}\n");
  });

  it("never overwrites existing destinations", () => {
    const oldDir = makeOldUserData();
    const home = mkdtempSync(join(tmpdir(), "cw-new-home-"));
    mkdirSync(join(home, "userdata"), { recursive: true });
    writeFileSync(join(home, "userdata", "cw-settings.json"), "existing");
    const result = migrateFromUserData(oldDir, home);
    expect(readFileSync(join(home, "userdata", "cw-settings.json"), "utf8")).toBe("existing");
    expect(result.skipped).toContain("cw-settings.json");
    expect(result.copied).not.toContain("cw-settings.json");
  });

  it("does not copy a legacy metadata file over a missing one that has cw-code backups", () => {
    const oldDir = makeOldUserData();
    const home = mkdtempSync(join(tmpdir(), "cw-new-home-"));
    mkdirSync(join(home, "userdata"), { recursive: true });
    writeFileSync(join(home, "userdata", "cw-code.db.json.last-good.bak"), '{"schemaVersion":1,"projects":[],"sessions":[]}');
    const result = migrateFromUserData(oldDir, home);
    expect(existsSync(join(home, "userdata", "cw-code.db.json"))).toBe(false);
    expect(result.skipped).toContain("cw-code.db.json");
    expect(result.copied).toContain("cw-settings.json");
  });

  it("skips worktrees entirely", () => {
    const oldDir = makeOldUserData();
    mkdirSync(join(oldDir, "worktrees", "proj"), { recursive: true });
    writeFileSync(join(oldDir, "worktrees", "proj", "file.txt"), "wt");
    const home = mkdtempSync(join(tmpdir(), "cw-new-home-"));
    const result = migrateFromUserData(oldDir, home);
    expect(result.copied).not.toContain("worktrees");
    expect(existsSync(join(home, "worktrees", "proj", "file.txt"))).toBe(false);
  });

  it("returns all-skipped when userDataDir is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-new-home-"));
    const missing = join(mkdtempSync(join(tmpdir(), "cw-missing-")), "gone");
    const result = migrateFromUserData(missing, home);
    expect(result.copied).toEqual([]);
    expect(result.skipped).toContain("cw-code.db.json");
    expect(result.skipped).toContain("crash.log");
    expect(result.skipped).toContain("skills");
  });
});
