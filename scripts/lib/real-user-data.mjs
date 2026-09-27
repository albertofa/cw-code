import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareMetadata, projectMetadata } from "../../tools/release/src/upgradeScenarios.ts";

const FIXTURE_SENTINEL_PATTERN = /^cw-verify-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIXTURE_UNKNOWN_KEY = "cwVerifyUnknownKey";
export const REAL_FIXTURE_SETTINGS_KEYS = ["claudeBinaryPath", "holdingHours", "autoTitleEnabled", "updateBackgroundDownload", FIXTURE_UNKNOWN_KEY];

export function cwCodeHomeDir() {
  return join(process.env.USERPROFILE ?? homedir(), ".cw-code");
}

export function electronUserDataDir() {
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "@cw-code", "desktop");
}

function isFixtureSentinel(value) {
  return typeof value === "string" && FIXTURE_SENTINEL_PATTERN.test(value);
}

function isJsonFixture(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && isFixtureSentinel(parsed._fixture);
  } catch {
    return false;
  }
}

function isMarkerFixture(text) {
  return text.endsWith("\n") && isFixtureSentinel(text.slice(0, -1));
}

function assertSafeToSeed({ path, kind }) {
  if (!existsSync(path)) return;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`refusing to seed: cannot read existing ${path} (${err.message}); aborting before writing anything.`);
  }
  const isFixture = kind === "json" ? isJsonFixture(text) : isMarkerFixture(text);
  if (!isFixture) {
    throw new Error(
      `refusing to seed over existing file that is not a cw-verify fixture: ${path}. ` +
        "This looks like real user data; aborting before writing anything."
    );
  }
}

function ensureDirTracked(dir, createdDirs) {
  const missing = [];
  let current = dir;
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of missing) {
    mkdirSync(path);
    createdDirs.push(path);
  }
}

export function createSeedPlan() {
  const sentinel = `cw-verify-${randomUUID()}`;
  const home = cwCodeHomeDir();
  const userdataDir = join(home, "userdata");
  const worktreeDir = join(home, "worktrees", "cw-verify-fixture-worktree");
  const db = {
    _fixture: sentinel,
    [FIXTURE_UNKNOWN_KEY]: { preserved: sentinel },
    projects: [{ id: "proj_verify_fixture", rootPath: "C:\\verify\\fixture-project", name: "fixture-project" }],
    sessions: [
      {
        id: "sess_verify_fixture",
        projectId: "proj_verify_fixture",
        driver: "claude",
        title: "verify fixture",
        status: "idle",
        resumeCursor: "00000000-0000-4000-8000-00000000c0de",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        worktreePath: worktreeDir,
        branch: "cw/verify-fixture",
        [FIXTURE_UNKNOWN_KEY]: sentinel
      }
    ]
  };
  const settings = {
    _fixture: sentinel,
    claudeBinaryPath: "claude.exe",
    holdingHours: 12,
    autoTitleEnabled: false,
    updateBackgroundDownload: false,
    [FIXTURE_UNKNOWN_KEY]: "kept-across-updates"
  };
  return {
    sentinel,
    paths: {
      db: join(userdataDir, "cw-code.db.json"),
      settings: join(userdataDir, "cw-settings.json"),
      worktreeMarker: join(worktreeDir, "marker.txt"),
      electronMarker: join(electronUserDataDir(), "marker.txt")
    },
    db,
    settings,
    dbContent: `${JSON.stringify(db, null, 2)}\n`,
    settingsContent: `${JSON.stringify(settings, null, 2)}\n`,
    markerContent: `${sentinel}\n`,
    writtenFiles: [],
    createdDirs: []
  };
}

export function seedRealUserData(seed) {
  const targets = [
    { path: seed.paths.db, kind: "json", content: seed.dbContent },
    { path: seed.paths.settings, kind: "json", content: seed.settingsContent },
    { path: seed.paths.worktreeMarker, kind: "marker", content: seed.markerContent },
    { path: seed.paths.electronMarker, kind: "marker", content: seed.markerContent }
  ];
  for (const target of targets) assertSafeToSeed(target);
  for (const target of targets) {
    ensureDirTracked(dirname(target.path), seed.createdDirs);
    writeFileSync(target.path, target.content, "utf8");
    seed.writtenFiles.push(target.path);
  }
}

export function cleanupSeededFixtures(seed) {
  for (const path of seed.writtenFiles) {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      console.warn(`warning: could not remove seeded fixture ${path}: ${err.message}`);
    }
  }
  for (const dir of [...seed.createdDirs].reverse()) {
    if (!existsSync(dir)) continue;
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
      else console.warn(`leaving directory created by the seed in place because it is no longer empty: ${dir}`);
    } catch (err) {
      console.warn(`warning: could not remove seeded fixture directory ${dir}: ${err.message}`);
    }
  }
}

function markerChecks(seed) {
  return [
    ["worktree marker", seed.paths.worktreeMarker, seed.markerContent],
    ["Electron userData marker", seed.paths.electronMarker, seed.markerContent]
  ];
}

function assertBytesUnchanged(checks, stage, problems) {
  for (const [label, path, expected] of checks) {
    if (!existsSync(path)) {
      problems.push(`${label} missing ${stage}: ${path}`);
      continue;
    }
    if (readFileSync(path, "utf8") !== expected) {
      problems.push(`${label} changed ${stage}: ${path}`);
    }
  }
}

export function assertDataUnchanged(seed, stage, problems) {
  assertBytesUnchanged(
    [
      ["userdata db", seed.paths.db, seed.dbContent],
      ["settings", seed.paths.settings, seed.settingsContent],
      ...markerChecks(seed)
    ],
    stage,
    problems
  );
}

function readJsonForCheck(label, path, stage, problems) {
  if (!existsSync(path)) {
    problems.push(`${label} missing ${stage}: ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    problems.push(`${label} is not valid JSON ${stage}: ${path} (${err.message})`);
    return null;
  }
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function assertDataPreservedSemantically(seed, stage, problems) {
  const db = readJsonForCheck("userdata db", seed.paths.db, stage, problems);
  const settings = readJsonForCheck("settings", seed.paths.settings, stage, problems);
  if (db && settings) {
    const before = projectMetadata(seed.db, seed.settings, REAL_FIXTURE_SETTINGS_KEYS);
    const after = projectMetadata(db, settings, REAL_FIXTURE_SETTINGS_KEYS);
    for (const problem of compareMetadata(before, after)) problems.push(`${problem} (${stage})`);
  }
  if (db) {
    if (!sameValue(db[FIXTURE_UNKNOWN_KEY], seed.db[FIXTURE_UNKNOWN_KEY])) {
      problems.push(`userdata db unknown key '${FIXTURE_UNKNOWN_KEY}' not preserved ${stage}`);
    }
    const expectedSession = seed.db.sessions[0];
    const actualSession = Array.isArray(db.sessions) ? db.sessions.find((session) => session?.id === expectedSession.id) : undefined;
    if (actualSession && !sameValue(actualSession[FIXTURE_UNKNOWN_KEY], expectedSession[FIXTURE_UNKNOWN_KEY])) {
      problems.push(`session '${expectedSession.id}' unknown key '${FIXTURE_UNKNOWN_KEY}' not preserved ${stage}`);
    }
  }
  assertBytesUnchanged(markerChecks(seed), stage, problems);
}
