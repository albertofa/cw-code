import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const FIXTURE_MARKER = "cw-verify";

export function cwCodeHomeDir() {
  return join(process.env.USERPROFILE ?? homedir(), ".cw-code");
}

export function electronUserDataDir() {
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "@cw-code", "desktop");
}

function assertSafeToSeed(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  if (!content.includes(FIXTURE_MARKER)) {
    throw new Error(
      `refusing to seed over existing file that is not a cw-verify fixture: ${path}. ` +
        "This looks like real user data; aborting before writing anything."
    );
  }
}

export function seedRealUserData() {
  const home = cwCodeHomeDir();
  const userdataDir = join(home, "userdata");
  const worktreeMarkerPath = join(home, "worktrees", "cw-verify-fake-worktree", "marker.txt");
  const electronMarkerPath = join(electronUserDataDir(), "marker.txt");
  const dbPath = join(userdataDir, "cw-code.db.json");
  const settingsPath = join(userdataDir, "cw-settings.json");

  for (const path of [dbPath, settingsPath, worktreeMarkerPath, electronMarkerPath]) {
    assertSafeToSeed(path);
  }

  mkdirSync(userdataDir, { recursive: true });
  mkdirSync(dirname(worktreeMarkerPath), { recursive: true });
  mkdirSync(dirname(electronMarkerPath), { recursive: true });

  const dbContent = `${JSON.stringify(
    {
      schemaVersion: 1,
      _fixture: FIXTURE_MARKER,
      projects: [{ id: "proj_verify_fake", rootPath: "C:\\verify\\fake-project" }],
      sessions: [
        {
          id: "sess_verify_fake",
          projectId: "proj_verify_fake",
          driver: "claude",
          worktreePath: "C:\\verify\\fake-worktree",
          title: "verify fixture"
        }
      ]
    },
    null,
    2
  )}\n`;
  const settingsContent = `${JSON.stringify(
    { schemaVersion: 1, claudeBinaryPath: "claude.exe", _fixture: FIXTURE_MARKER },
    null,
    2
  )}\n`;
  const markerContent = `${FIXTURE_MARKER} marker ${Date.now()}\n`;

  writeFileSync(dbPath, dbContent, "utf8");
  writeFileSync(settingsPath, settingsContent, "utf8");
  writeFileSync(worktreeMarkerPath, markerContent, "utf8");
  writeFileSync(electronMarkerPath, markerContent, "utf8");

  return { dbPath, settingsPath, worktreeMarkerPath, electronMarkerPath, dbContent, settingsContent, markerContent };
}

export function cleanupSeededFixtures(seed) {
  for (const path of [seed.dbPath, seed.settingsPath, seed.electronMarkerPath]) {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      console.warn(`warning: could not remove seeded fixture ${path}: ${err.message}`);
    }
  }
  try {
    rmSync(dirname(seed.worktreeMarkerPath), { recursive: true, force: true });
  } catch (err) {
    console.warn(`warning: could not remove seeded fixture worktree ${dirname(seed.worktreeMarkerPath)}: ${err.message}`);
  }
}

export function assertDataPreserved(seed, problems) {
  const checks = [
    ["userdata db", seed.dbPath, seed.dbContent],
    ["settings", seed.settingsPath, seed.settingsContent],
    ["worktree marker", seed.worktreeMarkerPath, seed.markerContent],
    ["Electron userData marker", seed.electronMarkerPath, seed.markerContent]
  ];
  for (const [label, path, expected] of checks) {
    if (!existsSync(path)) {
      problems.push(`${label} missing after upgrade: ${path}`);
      continue;
    }
    if (readFileSync(path, "utf8") !== expected) {
      problems.push(`${label} changed after upgrade: ${path}`);
    }
  }
}
