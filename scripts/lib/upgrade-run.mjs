import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseFaults } from "../../tools/release/src/feedFaults.ts";
import { validateReleaseFeed } from "../../tools/release/src/feedManifest.ts";
import { startFeedServer, summarizeTransfers } from "../../tools/release/src/feedServer.ts";
import {
  UPDATE_AUTOTEST_HANDOFF_FILE,
  UPDATE_TEST_APP_ID,
  UPDATE_TEST_EXECUTABLE,
  UPDATE_TEST_UNINSTALLER,
  classifyTransfer,
  compareMetadata,
  evaluateScenario,
  fabricateManifest,
  observedOutcome,
  parseAutotestLog,
  projectMetadata,
  splitRuns
} from "../../tools/release/src/upgradeScenarios.ts";
import { parseAppUpdateYaml } from "./upgrade-builds.mjs";
import {
  UNINSTALL_POLL_TIMEOUT_MS,
  isProcessAlive,
  killProcessTree,
  nsisGuid,
  readRegistryValue,
  registryPaths,
  runSilent,
  runUninstallSync,
  safePathWithoutClis,
  waitForRegistryValueGone
} from "./windows-install.mjs";

const libDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(libDir, "..");
const repoRoot = resolve(scriptsDir, "..");
const FIXTURES_DIR = join(repoRoot, "apps", "desktop", "src", "main", "storage", "__fixtures__");
const FAKE_CLAUDE = join(scriptsDir, "fixtures", "fake-claude.mjs");
const WIZARD_DRIVER = join(libDir, "drive-installer-wizard.ps1");

export const TEST_GUID = nsisGuid(UPDATE_TEST_APP_ID);
export const BUSY_SESSION_ID = "sess_fx000001";
const BUSY_PROJECT_ID = "proj_fx000001";
const DEFAULT_CACHE_DIR_NAME = "@cw-codedesktop-updatetest-updater";
const SETTINGS_KEYS = [
  "claudeBinaryPath",
  "opencodeBinaryPath",
  "codexBinaryPath",
  "claudeExtraArgs",
  "gitBinaryPath",
  "holdingHours",
  "autoTitleEnabled",
  "updateBackgroundDownload",
  "cwUpdateTestUnknownKey"
];
const STRIPPED_ENV = [
  "CW_PACKAGE_PROBE_OUT",
  "CW_UPDATE_AUTOTEST",
  "CW_UPDATE_AUTOTEST_OUT",
  "CW_UPDATE_AUTOTEST_BUSY_SESSION",
  "CW_UPDATE_AUTOTEST_PAUSE_FILE",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_URL",
  "NODE_OPTIONS",
  "GH_TOKEN",
  "GITHUB_TOKEN"
];
const FIRST_RUN_TIMEOUT_MS = 10 * 60_000;
const RELAUNCH_TIMEOUT_MS = 6 * 60_000;
const NO_RELAUNCH_GRACE_MS = 90_000;
const EXIT_TIMEOUT_MS = 90_000;
const POLL_MS = 1_000;

export function updateTestIdentity(cacheDirName = DEFAULT_CACHE_DIR_NAME) {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return { userDataDir: join(appData, "@cw-code", "desktop-updatetest"), cacheDir: join(localAppData, cacheDirName) };
}

function assertUpdateTestPath(path) {
  if (!/updatetest/i.test(path)) throw new Error(`refusing to modify ${path}: it is not an update-test identity path`);
}

function removeTestDir(path) {
  assertUpdateTestPath(path);
  if (!existsSync(path)) return;
  spawnSync("icacls", [path, "/reset", "/T", "/C", "/Q"], { encoding: "utf8" });
  rmSync(path, { recursive: true, force: true });
}

export function cleanupTestIdentity(identity) {
  const notes = [];
  for (const perMachine of [false, true]) {
    const keys = registryPaths(TEST_GUID, perMachine);
    const location = readRegistryValue(keys.install, "InstallLocation");
    if (!location) continue;
    assertUpdateTestPath(location);
    const uninstaller = join(location, UPDATE_TEST_UNINSTALLER);
    if (existsSync(uninstaller)) {
      runUninstallSync(uninstaller, location);
      waitForRegistryValueGone(keys.install, "InstallLocation", UNINSTALL_POLL_TIMEOUT_MS);
      notes.push(`uninstalled update-test build from ${perMachine ? "HKLM" : "HKCU"}`);
    } else {
      notes.push(`update-test registry entry at ${keys.install} points to a missing uninstaller`);
    }
  }
  removeTestDir(identity.cacheDir);
  removeTestDir(identity.userDataDir);
  return notes;
}

function linkOrCopy(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

export function stageFeed(entry, builds, versions, root) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  let advertised = null;
  const { feed } = entry;
  if (feed.release) {
    const build = builds[feed.release];
    for (const name of build.channelFiles) linkOrCopy(join(build.dir, name), join(root, name));
    linkOrCopy(build.installerPath, join(root, build.installerName));
    linkOrCopy(`${build.installerPath}.blockmap`, join(root, `${build.installerName}.blockmap`));
    advertised = { name: build.installerName, size: build.size, version: build.version };
  }
  if (feed.fabricated) {
    const source = builds[feed.fabricated.installer];
    const text = fabricateManifest(versions[feed.fabricated.version], { name: source.installerName, sha512: source.sha512, size: source.size });
    for (const name of feed.fabricated.channelFiles) writeFileSync(join(root, name), text, "utf8");
    linkOrCopy(source.installerPath, join(root, source.installerName));
    advertised = { name: source.installerName, size: source.size, version: versions[feed.fabricated.version] };
  }
  for (const key of feed.blockMaps) {
    const build = builds[key];
    linkOrCopy(`${build.installerPath}.blockmap`, join(root, `${build.installerName}.blockmap`));
  }
  if (feed.staleManifestFrom) {
    const stale = builds[feed.staleManifestFrom];
    linkOrCopy(join(stale.dir, "alpha.yml"), join(root, "stale", "alpha.yml"));
  }
  return { root, faults: parseFaults(feed.faults), advertised };
}

function httpProbe(port, path, headers = {}, method = "GET") {
  return new Promise((resolvePromise) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
      });
      res.on("close", () => resolvePromise({ path, method, range: headers.Range ?? null, status: res.statusCode ?? 0, bytes }));
      res.on("error", () => resolvePromise({ path, method, range: headers.Range ?? null, status: res.statusCode ?? 0, bytes, aborted: true }));
    });
    req.on("error", (err) => resolvePromise({ path, method, range: headers.Range ?? null, status: 0, error: err.code ?? err.message }));
    req.end();
  });
}

export async function dryRunFeed(entry, staged) {
  const server = await startFeedServer({ root: staged.root, faults: staged.faults });
  const probes = [];
  try {
    for (const name of ["latest.yml", "alpha.yml"]) probes.push(await httpProbe(server.port, `/${name}`));
    if (staged.advertised) {
      probes.push(await httpProbe(server.port, `/${staged.advertised.name}`, {}, "HEAD"));
      probes.push(await httpProbe(server.port, `/${staged.advertised.name}`, { Range: "bytes=0-65535" }));
      probes.push(await httpProbe(server.port, `/${staged.advertised.name}`, { Range: "bytes=0-1023, 4096-8191" }));
    }
    probes.push(await httpProbe(server.port, "/..%2f..%2fpackage.json"));
    await server.idle();
  } finally {
    await server.close();
  }
  const validation = entry.feed.release || entry.feed.fabricated ? await validateReleaseFeed(staged.root) : null;
  return { probes, validation, faults: staged.faults.map((fault) => fault.type) };
}

export function seedIsolatedData(paths, identity) {
  const sessions = JSON.parse(readFileSync(join(FIXTURES_DIR, "sessions-v0.json"), "utf8"));
  const project = sessions.projects.find((entry) => entry.id === BUSY_PROJECT_ID);
  project.rootPath = paths.projectDir;
  mkdirSync(paths.projectDir, { recursive: true });
  const settings = {
    ...JSON.parse(readFileSync(join(FIXTURES_DIR, "settings-v0.json"), "utf8")),
    claudeBinaryPath: process.execPath,
    claudeExtraArgs: `"${paths.fakeScript}"`,
    autoTitleEnabled: false,
    updateBackgroundDownload: false,
    cwUpdateTestUnknownKey: "kept-across-updates"
  };
  const userdata = join(paths.cwCodeHome, "userdata");
  mkdirSync(join(userdata, "attachments"), { recursive: true });
  writeFileSync(join(userdata, "cw-code.db.json"), JSON.stringify(sessions), "utf8");
  writeFileSync(join(userdata, "cw-settings.json"), JSON.stringify(settings), "utf8");
  mkdirSync(dirname(paths.fakeScript), { recursive: true });
  copyFileSync(FAKE_CLAUDE, paths.fakeScript);

  const stamp = `cw-update-test marker ${Date.now()}\n`;
  const markers = [
    { label: "worktree marker", path: join(paths.cwCodeHome, "worktrees", BUSY_PROJECT_ID, "cw-update-test", "marker.txt"), content: stamp },
    { label: "attachment", path: join(userdata, "attachments", "cw-update-test.txt"), content: stamp },
    { label: "Electron userData marker", path: join(identity.userDataDir, "cw-update-test-marker.txt"), content: stamp }
  ];
  for (const marker of markers) {
    mkdirSync(dirname(marker.path), { recursive: true });
    writeFileSync(marker.path, marker.content, "utf8");
  }
  return { before: projectMetadata(sessions, settings, SETTINGS_KEYS), markers };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function checkPreservedData(paths, seed) {
  const problems = [];
  const userdata = join(paths.cwCodeHome, "userdata");
  const sessions = readJsonIfExists(join(userdata, "cw-code.db.json"));
  const settings = readJsonIfExists(join(userdata, "cw-settings.json"));
  if (sessions === null || sessions === undefined) problems.push(`cw-code.db.json is ${sessions === null ? "missing" : "unreadable"} after the update`);
  if (settings === null || settings === undefined) problems.push(`cw-settings.json is ${settings === null ? "missing" : "unreadable"} after the update`);
  if (sessions && sessions.schemaVersion !== 1) problems.push(`cw-code.db.json schemaVersion is ${sessions.schemaVersion}, expected 1`);
  if (settings && settings.schemaVersion !== 1) problems.push(`cw-settings.json schemaVersion is ${settings.schemaVersion}, expected 1`);
  if (sessions && settings) problems.push(...compareMetadata(seed.before, projectMetadata(sessions, settings, SETTINGS_KEYS)));
  for (const marker of seed.markers) {
    if (!existsSync(marker.path)) problems.push(`${marker.label} is missing after the update`);
    else if (readFileSync(marker.path, "utf8") !== marker.content) problems.push(`${marker.label} changed after the update`);
  }
  return problems;
}

function appEnv(paths, entry, mode, outPath) {
  const env = { ...process.env };
  for (const name of STRIPPED_ENV) delete env[name];
  env.PATH = safePathWithoutClis();
  env.CW_CODE_HOME = paths.cwCodeHome;
  env.CW_UPDATE_AUTOTEST = mode;
  env.CW_UPDATE_AUTOTEST_OUT = outPath;
  if (entry?.busyTurn) env.CW_UPDATE_AUTOTEST_BUSY_SESSION = BUSY_SESSION_ID;
  if (entry?.sabotage) env.CW_UPDATE_AUTOTEST_PAUSE_FILE = paths.pauseFile;
  return env;
}

function launch(exe, args, env) {
  const child = spawn(exe, args, { env, stdio: "ignore" });
  const state = { child, pid: child.pid ?? null, exited: false, exitCode: null, exitedAt: null, error: null };
  child.on("exit", (code) => {
    state.exited = true;
    state.exitCode = code;
    state.exitedAt = Date.now();
  });
  child.on("error", (err) => {
    state.exited = true;
    state.error = err.message;
    state.exitedAt = Date.now();
  });
  return state;
}

function readRuns(outPath) {
  return existsSync(outPath) ? splitRuns(parseAutotestLog(readFileSync(outPath, "utf8"))) : [];
}

function has(run, name) {
  return (run ?? []).some((event) => event.event === name);
}

function pidOf(run) {
  const started = (run ?? []).find((event) => event.event === "started");
  return typeof started?.pid === "number" ? started.pid : null;
}

async function waitForExit(pid, timeoutMs) {
  if (pid === null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

export async function runAppToResult(exe, args, env, outPath, timeoutMs, onRuns = () => undefined) {
  const app = launch(exe, args, env);
  const deadline = Date.now() + timeoutMs;
  let runs = [];
  while (Date.now() < deadline) {
    runs = readRuns(outPath);
    await onRuns(runs, app);
    if (has(runs[0], "result") || (app.exited && !has(runs[0], "installing"))) break;
    if (has(runs[0], "installing")) break;
    await sleep(POLL_MS);
  }
  return { app, runs: readRuns(outPath), timedOut: Date.now() >= deadline };
}

function sabotageInstaller(kind, installerPath) {
  if (!existsSync(installerPath)) return { kind, applied: false, reason: "the downloaded installer was not found in the pending cache" };
  if (kind === "remove-installer") rmSync(installerPath, { force: true });
  else runSilent("icacls", [installerPath, "/deny", "*S-1-1-0:(X)"]);
  return { kind, applied: true };
}

function startWizardDriver(installerDir, logPath) {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WIZARD_DRIVER, "-InstallerDir", installerDir, "-LogPath", logPath, "-TimeoutSeconds", "480"],
    { stdio: "ignore", windowsHide: true }
  );
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null);
}

function fakeCliObservation(logPath) {
  const events = readJsonLines(logPath);
  const starts = events.filter((entry) => entry.event === "turn-start");
  if (starts.length === 0) return null;
  return { turnStarts: starts.length, stillRunning: starts.map((entry) => entry.pid).filter((pid) => isProcessAlive(pid)) };
}

function eventTime(run, name) {
  const found = (run ?? []).find((event) => event.event === name);
  return found ? Date.parse(found.at) : null;
}

function scenarioPaths(dir) {
  return {
    dir,
    cwCodeHome: join(dir, "cw-code-home"),
    projectDir: join(dir, "project-alpha"),
    fakeScript: join(dir, "fake-bin", "fake-claude.mjs"),
    fakeLog: join(dir, "fake-bin", "fake-claude.jsonl"),
    feedRoot: join(dir, "feed"),
    outPath: join(dir, "autotest.jsonl"),
    recoveryOutPath: join(dir, "autotest-recovery.jsonl"),
    pauseFile: join(dir, "resume-install"),
    wizardLog: join(dir, "installer-wizard.jsonl"),
    customInstallDir: join(dir, "custom", "cw-code-updatetest")
  };
}

function installArguments(entry, paths) {
  if (entry.scope === "per-machine") return ["/S", "/allusers"];
  if (entry.scope === "custom-dir") return ["/S", `/D=${paths.customInstallDir}`];
  return ["/S"];
}

export async function runScenario(entry, context) {
  const { builds, versions, workDir, identity } = context;
  const paths = scenarioPaths(join(workDir, entry.id));
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dir, { recursive: true });
  const record = { id: entry.id, group: entry.group, title: entry.title, installed: versions[entry.install], problems: [], notes: [], timings: {}, logs: paths };
  const keys = registryPaths(TEST_GUID, entry.scope === "per-machine");
  const knownPids = new Set();
  let feed = null;
  let wizard = null;
  let staged = null;
  try {
    record.notes.push(...cleanupTestIdentity(identity));
    const seed = seedIsolatedData(paths, identity);
    const build = builds[entry.install];

    const installStartedAt = Date.now();
    runSilent(build.installerPath, installArguments(entry, paths));
    record.timings.initialInstallMs = Date.now() - installStartedAt;
    const installLocationBefore = readRegistryValue(keys.install, "InstallLocation");
    record.displayVersionBefore = readRegistryValue(keys.uninstall, "DisplayVersion");
    if (!installLocationBefore) throw new Error(`InstallLocation is missing at ${keys.install} after installing ${build.version}`);
    if (entry.scope === "custom-dir" && resolve(installLocationBefore).toLowerCase() !== resolve(paths.customInstallDir).toLowerCase()) {
      record.problems.push(`the custom install directory was not honored: ${installLocationBefore}`);
    }
    const exe = join(installLocationBefore, UPDATE_TEST_EXECUTABLE);
    const appUpdate = parseAppUpdateYaml(readFileSync(join(installLocationBefore, "resources", "app-update.yml"), "utf8"));
    const port = Number(new URL(appUpdate.url).port);
    const pendingDir = join(updateTestIdentity(appUpdate.updaterCacheDirName).cacheDir, "pending");

    staged = stageFeed(entry, builds, versions, paths.feedRoot);
    feed = await startFeedServer({ root: staged.root, port, faults: staged.faults });
    if (entry.mode === "install") wizard = startWizardDriver(pendingDir, paths.wizardLog);

    let sabotage = null;
    const first = await runAppToResult(exe, [], appEnv(paths, entry, entry.mode, paths.outPath), paths.outPath, FIRST_RUN_TIMEOUT_MS, async (runs) => {
      if (!entry.sabotage || sabotage || !has(runs[0], "paused")) return;
      sabotage = sabotageInstaller(entry.sabotage, join(pendingDir, staged.advertised.name));
      writeFileSync(paths.pauseFile, "go", "utf8");
    });
    if (first.app.pid) knownPids.add(first.app.pid);
    if (first.timedOut) record.problems.push(`the installed app did not finish within ${FIRST_RUN_TIMEOUT_MS / 1000}s`);
    if (first.app.error) record.problems.push(`the installed app could not start: ${first.app.error}`);
    record.sabotage = sabotage;

    let runs = first.runs;
    if (has(runs[0], "installing")) {
      const exited = await waitForExit(first.app.pid, EXIT_TIMEOUT_MS);
      if (!exited) record.problems.push("N did not exit after Update and restart");
      const exitedAt = first.app.exitedAt ?? Date.now();
      const waitMs = entry.sabotage ? NO_RELAUNCH_GRACE_MS : RELAUNCH_TIMEOUT_MS;
      while (Date.now() - exitedAt < waitMs) {
        runs = readRuns(paths.outPath);
        if (runs.length > 1 && has(runs[1], "result")) break;
        await sleep(POLL_MS);
      }
      const relaunchPid = pidOf(runs[1]);
      if (relaunchPid !== null) {
        knownPids.add(relaunchPid);
        if (!(await waitForExit(relaunchPid, EXIT_TIMEOUT_MS))) record.problems.push("the relaunched app did not quit after its check");
      }
      const installingAt = eventTime(runs[0], "installing");
      const relaunchedAt = eventTime(runs[1], "started");
      if (installingAt !== null && relaunchedAt !== null) record.timings.installToRelaunchMs = relaunchedAt - installingAt;
    } else {
      await waitForExit(first.app.pid, EXIT_TIMEOUT_MS);
    }
    const downloadStartedAt = (runs[0] ?? []).find((event) => event.event === "state" && event.phase === "downloading");
    const downloadDoneAt = eventTime(runs[0], "download");
    if (downloadStartedAt && downloadDoneAt !== null) record.timings.downloadMs = downloadDoneAt - Date.parse(downloadStartedAt.at);

    let recoveryEvents = null;
    if (entry.sabotage) {
      const handoff = join(identity.userDataDir, UPDATE_AUTOTEST_HANDOFF_FILE);
      record.handoffLeftBehind = existsSync(handoff);
      rmSync(handoff, { force: true });
      const recovery = await runAppToResult(exe, [], appEnv(paths, null, "check-only", paths.recoveryOutPath), paths.recoveryOutPath, EXIT_TIMEOUT_MS * 2);
      if (recovery.app.pid) knownPids.add(recovery.app.pid);
      await waitForExit(recovery.app.pid, EXIT_TIMEOUT_MS);
      recoveryEvents = recovery.runs[0] ?? [];
    }

    await feed.idle();
    const transfers = summarizeTransfers(feed.requests());
    const observation = {
      events: runs[0] ?? [],
      relaunchEvents: runs[1] ?? [],
      displayVersionAfter: readRegistryValue(keys.uninstall, "DisplayVersion"),
      installLocationBefore,
      installLocationAfter: readRegistryValue(keys.install, "InstallLocation"),
      advertisedInstaller: staged.advertised?.name ?? null,
      advertisedInstallerSize: staged.advertised?.size ?? null,
      transfers,
      metadataProblems: checkPreservedData(paths, seed),
      fakeCli: entry.busyTurn ? fakeCliObservation(paths.fakeLog) : null,
      recoveryEvents
    };
    if (!existsSync(exe) && !existsSync(join(observation.installLocationAfter ?? installLocationBefore, UPDATE_TEST_EXECUTABLE))) {
      record.problems.push("the installed executable is gone after the scenario");
    }
    record.problems.push(...evaluateScenario(entry, versions, observation));
    record.observed = {
      outcome: observedOutcome(observation),
      displayVersionBefore: record.displayVersionBefore,
      displayVersionAfter: observation.displayVersionAfter,
      installLocation: installLocationBefore,
      installLocationAfter: observation.installLocationAfter,
      events: observation.events.map((event) => event.event),
      relaunchEvents: observation.relaunchEvents.map((event) => event.event),
      result: [...observation.events].reverse().find((event) => event.event === "result") ?? null,
      relaunchResult: [...observation.relaunchEvents].reverse().find((event) => event.event === "result") ?? null,
      recoveryResult: recoveryEvents ? ([...recoveryEvents].reverse().find((event) => event.event === "result") ?? null) : null,
      transfer: classifyTransfer(transfers, observation.advertisedInstaller, observation.advertisedInstallerSize),
      advertisedInstaller: observation.advertisedInstaller,
      advertisedInstallerSize: observation.advertisedInstallerSize,
      transfers,
      fakeCli: observation.fakeCli,
      wizard: readJsonLines(paths.wizardLog)
    };
  } catch (err) {
    record.problems.push(`scenario aborted: ${err.message}`);
  } finally {
    if (wizard?.pid && isProcessAlive(wizard.pid)) killProcessTree(wizard.pid);
    if (feed) await feed.close();
    for (const pid of knownPids) if (isProcessAlive(pid)) killProcessTree(pid);
    for (const fake of readJsonLines(paths.fakeLog)) if (fake.event === "turn-start" && isProcessAlive(fake.pid)) killProcessTree(fake.pid);
    try {
      record.notes.push(...cleanupTestIdentity(identity));
    } catch (err) {
      record.problems.push(`cleanup failed: ${err.message}`);
    }
  }
  return record;
}

export async function runUnpackedAutotestSmoke(unpackedExe, workDir) {
  const dir = join(workDir, "unpacked-autotest-smoke");
  rmSync(dir, { recursive: true, force: true });
  const paths = { cwCodeHome: join(dir, "cw-code-home"), userDataDir: join(dir, "user-data"), outPath: join(dir, "autotest.jsonl") };
  mkdirSync(paths.cwCodeHome, { recursive: true });
  mkdirSync(paths.userDataDir, { recursive: true });
  const env = appEnv({ cwCodeHome: paths.cwCodeHome }, null, "check-only", paths.outPath);
  const result = await runAppToResult(unpackedExe, [`--user-data-dir=${paths.userDataDir}`], env, paths.outPath, EXIT_TIMEOUT_MS);
  const exited = await waitForExit(result.app.pid, 30_000);
  if (!exited && result.app.pid) killProcessTree(result.app.pid);
  const events = result.runs[0] ?? [];
  const outcome = [...events].reverse().find((event) => event.event === "result") ?? null;
  const problems = [];
  if (!has(events, "started")) problems.push("the unpacked update-test build did not write the autotest started event");
  if (outcome?.outcome !== "disabled") problems.push(`the unpacked build reported ${outcome?.outcome ?? "nothing"} instead of disabled updates`);
  if (!exited) problems.push("the unpacked build did not quit by itself");
  return { events: events.map((event) => event.event), result: outcome, exitCode: result.app.exitCode, problems };
}
