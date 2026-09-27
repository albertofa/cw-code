import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const desktopDir = join(repoRoot, "apps", "desktop");
const UPDATER_GUID = "d6e18d04-bf35-5bfe-9145-b95301660833";
const PROBE_TIMEOUT_MS = 30_000;
const UNINSTALL_POLL_TIMEOUT_MS = 30_000;
const UNINSTALL_POLL_INTERVAL_MS = 500;
const PROCESS_EXIT_GRACE_MS = 15_000;
const PRODUCT_NAME = "cw-code";
const UNINSTALLER_NAME = `Uninstall ${PRODUCT_NAME}.exe`;

function parseArgs(argv) {
  const args = {
    dist: join(desktopDir, "dist"),
    install: false,
    upgradeFrom: null,
    customDir: null,
    perMachine: false,
    disposableEnvironment: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dist") args.dist = resolve(argv[++i]);
    else if (arg === "--install") args.install = true;
    else if (arg === "--upgrade-from") args.upgradeFrom = resolve(argv[++i]);
    else if (arg === "--custom-dir") args.customDir = resolve(argv[++i]);
    else if (arg === "--per-machine") args.perMachine = true;
    else if (arg === "--disposable-environment") args.disposableEnvironment = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function readDesktopPackageJson() {
  return JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
}

function readDesktopVersion() {
  return readDesktopPackageJson().version;
}

function readDesktopAuthor() {
  const author = readDesktopPackageJson().author;
  if (!author) return null;
  return typeof author === "string" ? author : (author.name ?? null);
}

function findInstallerVersion(distDir) {
  if (!existsSync(distDir)) return readDesktopVersion();
  const pattern = /^cw-code-Setup-(.+)-x64\.exe$/;
  const matches = readdirSync(distDir)
    .map((name) => name.match(pattern))
    .filter((match) => match !== null);
  return matches.length === 1 ? matches[0][1] : readDesktopVersion();
}

function parseLegacyInstallerVersion(installerPath) {
  const match = basename(installerPath).match(/^cw-code\.Setup\.(.+)\.exe$/);
  return match ? match[1] : null;
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : null;
}

async function resolveAsarLib() {
  try {
    return await import("@electron/asar");
  } catch (primaryErr) {
    try {
      const desktopRequire = createRequire(join(desktopDir, "package.json"));
      const builderPkgPath = desktopRequire.resolve("electron-builder/package.json");
      const builderRequire = createRequire(builderPkgPath);
      return builderRequire("@electron/asar");
    } catch (fallbackErr) {
      console.warn(
        `warning: @electron/asar not resolvable, skipping app.asar content listing ` +
          `(direct import: ${primaryErr.message}; via electron-builder: ${fallbackErr.message})`
      );
      return null;
    }
  }
}

function safePathWithoutClis() {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return [
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0")
  ].join(";");
}

function killProcessTree(pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

function isElevated() {
  return spawnSync("net", ["session"], { encoding: "utf8" }).status === 0;
}

async function runPackageProbe(exePath, opts = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "cw-verify-probe-"));
  try {
    const probeOutPath = join(workDir, "probe.json");
    const cwCodeHome = opts.cwCodeHome ?? join(workDir, "cw-code-home");
    if (!opts.cwCodeHome) mkdirSync(cwCodeHome, { recursive: true });
    const appArgs = [];
    if (!opts.defaultUserData) {
      const userDataDir = join(workDir, "user-data");
      mkdirSync(userDataDir, { recursive: true });
      appArgs.push(`--user-data-dir=${userDataDir}`);
    }

    const env = {
      ...process.env,
      ...opts.env,
      CW_CODE_HOME: cwCodeHome,
      CW_PACKAGE_PROBE_OUT: probeOutPath,
      PATH: opts.stripCliPath === false ? process.env.PATH : safePathWithoutClis()
    };

    const result = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(exePath, appArgs, { env });
      const timer = setTimeout(() => {
        if (child.pid) killProcessTree(child.pid);
        rejectPromise(new Error(`packaged app did not exit within ${PROBE_TIMEOUT_MS}ms`));
      }, PROBE_TIMEOUT_MS);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolvePromise({ exitCode });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
    });

    if (!existsSync(probeOutPath)) {
      throw new Error(`packaged app exited (code ${result.exitCode}) without writing a probe result to ${probeOutPath}`);
    }
    const probe = JSON.parse(readFileSync(probeOutPath, "utf8"));
    return { exitCode: result.exitCode, probe };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function checkPackage(distDir) {
  const version = findInstallerVersion(distDir);
  const installerName = `cw-code-Setup-${version}-x64.exe`;
  const installerPath = join(distDir, installerName);
  const blockmapPath = `${installerPath}.blockmap`;
  const unpackedExePath = join(distDir, "win-unpacked", "cw-code.exe");
  const asarPath = join(distDir, "win-unpacked", "resources", "app.asar");
  const asarUnpackedDir = join(distDir, "win-unpacked", "resources", "app.asar.unpacked");
  const ptyNativePath = join(asarUnpackedDir, "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node");

  const report = {
    version,
    dist: distDir,
    installer: { path: installerPath, exists: existsSync(installerPath), sizeBytes: fileSize(installerPath) },
    blockmap: { path: blockmapPath, exists: existsSync(blockmapPath) },
    unpackedExe: { path: unpackedExePath, exists: existsSync(unpackedExePath) },
    asar: { path: asarPath, exists: existsSync(asarPath), sizeBytes: fileSize(asarPath), containsMainEntry: null },
    nodePtyNative: { path: ptyNativePath, exists: existsSync(ptyNativePath) },
    probe: null
  };

  const problems = [];
  if (!report.installer.exists) problems.push(`installer not found: ${installerPath}`);
  if (!report.blockmap.exists) problems.push(`blockmap not found: ${blockmapPath}`);
  if (!report.unpackedExe.exists) problems.push(`unpacked exe not found: ${unpackedExePath}`);
  if (!report.asar.exists) problems.push(`app.asar not found: ${asarPath}`);
  if (!report.nodePtyNative.exists) problems.push(`node-pty win32-x64 native binary not found: ${ptyNativePath}`);

  if (report.asar.exists) {
    const asarLib = await resolveAsarLib();
    if (asarLib) {
      const entries = asarLib.listPackage(asarPath);
      report.asar.containsMainEntry = entries.some((entry) => entry.replace(/\\/g, "/").endsWith("out/main/index.js"));
      if (!report.asar.containsMainEntry) problems.push("app.asar does not contain out/main/index.js");
    }
  }

  if (report.unpackedExe.exists) {
    try {
      const { exitCode, probe } = await runPackageProbe(unpackedExePath);
      report.probe = { exitCode, ...probe };
      if (!probe.rendererLoaded) problems.push("packaged startup probe: renderer failed to load");
      if (!probe.nodePty.spawned) problems.push(`packaged startup probe: node-pty did not spawn (${probe.nodePty.error ?? "unknown error"})`);
      const startupProblem = startupModeProblem("packaged startup probe", probe);
      if (startupProblem) problems.push(startupProblem);
    } catch (err) {
      problems.push(`packaged startup probe failed: ${err.message}`);
    }
  }

  return { report, problems };
}

function requireDisposableEnvironment(modeName, disposableEnvironment) {
  if (process.env.CI === "true" || disposableEnvironment) return;
  throw new Error(
    `${modeName} installs and uninstalls the packaged app; refusing to run outside CI. ` +
      "Set CI=true or pass --disposable-environment only in a disposable Windows environment."
  );
}

function runSilent(command, args) {
  const isolatedTemp = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "cw-installer-temp-"));
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp }
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function installDiagnostics(registryKeys) {
  const processes = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*cw-code*' -or $_.ExecutablePath -like '*cw-code*' -or $_.Name -like 'Un_*' -or $_.Name -like 'Au_*' } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | Format-List | Out-String -Width 400"
    ],
    { encoding: "utf8" }
  );
  const registry = [registryKeys.install, registryKeys.uninstall]
    .map((key) => {
      const result = spawnSync("reg", ["query", key, "/s"], { encoding: "utf8" });
      return `${key}:\n${result.status === 0 ? result.stdout.trim() : "(absent)"}`;
    })
    .join("\n");
  return `processes:\n${processes.stdout.trim() || "(none)"}\nregistry:\n${registry}`;
}

const INSTALLER_RETRY_DELAYS_SECONDS = [15, 30, 60];

function runSilentWithRetry(command, args, registryKeys) {
  for (let attempt = 0; ; attempt++) {
    try {
      return { result: runSilent(command, args), retried: attempt > 0 };
    } catch (err) {
      const delay = INSTALLER_RETRY_DELAYS_SECONDS[attempt];
      if (delay === undefined) throw new Error(`${err.message}\n${installDiagnostics(registryKeys)}`);
      console.warn(`${err.message}\n${installDiagnostics(registryKeys)}\nretrying in ${delay}s (attempt ${attempt + 2} of ${INSTALLER_RETRY_DELAYS_SECONDS.length + 1})`);
      spawnSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Seconds ${delay}`]);
    }
  }
}

function registryPaths(perMachine) {
  const hive = perMachine ? "HKLM" : "HKCU";
  return {
    install: `${hive}\\Software\\${UPDATER_GUID}`,
    uninstall: `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UPDATER_GUID}`
  };
}

function readRegistryValue(keyPath, name) {
  const result = spawnSync("reg", ["query", keyPath, "/v", name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.match(new RegExp(`${name}\\s+REG_SZ\\s+(.+)`));
  return match ? match[1].trim() : null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForRegistryValueGone(keyPath, name, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readRegistryValue(keyPath, name) === null) return;
    sleepSync(UNINSTALL_POLL_INTERVAL_MS);
  }
  throw new Error(`registry value '${name}' at ${keyPath} did not clear within ${timeoutMs}ms after uninstall`);
}

function defaultInstallDir(perMachine) {
  if (perMachine) return join(process.env["ProgramFiles"] ?? "C:\\Program Files", PRODUCT_NAME);
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", PRODUCT_NAME);
}

function dirKey(dir) {
  return resolve(dir).toLowerCase();
}

function hasInstallEvidence(dir) {
  return existsSync(join(dir, UNINSTALLER_NAME)) || existsSync(join(dir, `${PRODUCT_NAME}.exe`));
}

function protectedDirs() {
  return [
    homedir(),
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    process.env.SystemRoot,
    process.env.RUNNER_TEMP,
    tmpdir()
  ].filter((dir) => typeof dir === "string" && dir !== "");
}

function isSafeRemovalTarget(dir) {
  if (typeof dir !== "string" || dir.trim() === "" || !isAbsolute(dir)) return false;
  const absolute = resolve(dir);
  if (parse(absolute).root === absolute) return false;
  return !protectedDirs().some((guarded) => dirKey(guarded) === dirKey(absolute) || isInsideDir(guarded, absolute));
}

function detectInstallDirs(registryLocation, candidateDirs, ownedDirs) {
  const detected = new Map();
  const add = (dir) => {
    if (dir && !detected.has(dirKey(dir))) detected.set(dirKey(dir), dir);
  };
  for (const dir of [registryLocation, ...candidateDirs]) {
    if (dir && hasInstallEvidence(dir) && isSafeRemovalTarget(dir)) add(dir);
  }
  for (const dir of ownedDirs) if (isSafeRemovalTarget(dir)) add(dir);
  return [...detected.values()];
}

function isInsideDir(path, dir) {
  const root = dirKey(dir);
  return dirKey(path).startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function processesInsideDirs(processes, dirs, excludedPid = process.pid) {
  return processes.filter(
    (entry) =>
      Number.isInteger(entry?.ProcessId) &&
      entry.ProcessId !== excludedPid &&
      typeof entry.ExecutablePath === "string" &&
      entry.ExecutablePath !== "" &&
      dirs.some((dir) => isInsideDir(entry.ExecutablePath, dir))
  );
}

function survivingProcesses(requested, current) {
  return requested.filter((entry) =>
    current.some((candidate) => candidate.ProcessId === entry.ProcessId && dirKey(candidate.ExecutablePath) === dirKey(entry.ExecutablePath))
  );
}

function parseProcessList(text) {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function listWindowsProcesses() {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath)"
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) throw new Error(`could not list processes (exit ${result.status}): ${result.stderr || result.stdout}`);
  return parseProcessList(result.stdout);
}

function stopProcessesInsideDirs(dirs) {
  const existingDirs = dirs.filter((dir) => existsSync(dir));
  if (existingDirs.length === 0) return [];
  const running = processesInsideDirs(listWindowsProcesses(), existingDirs);
  if (running.length === 0) return [];
  for (const entry of running) spawnSync("taskkill", ["/PID", String(entry.ProcessId), "/T"], { encoding: "utf8" });
  const deadline = Date.now() + PROCESS_EXIT_GRACE_MS;
  let remaining = survivingProcesses(running, processesInsideDirs(listWindowsProcesses(), existingDirs));
  while (remaining.length > 0 && Date.now() < deadline) {
    sleepSync(UNINSTALL_POLL_INTERVAL_MS);
    remaining = survivingProcesses(remaining, processesInsideDirs(listWindowsProcesses(), existingDirs));
  }
  for (const entry of remaining) spawnSync("taskkill", ["/PID", String(entry.ProcessId), "/T", "/F"], { encoding: "utf8" });
  const forced = new Set(remaining.map((entry) => entry.ProcessId));
  return running.map((entry) => ({ pid: entry.ProcessId, path: entry.ExecutablePath, forced: forced.has(entry.ProcessId) }));
}

function describeStoppedProcesses(stopped) {
  return stopped.map((entry) => `${entry.pid} ${entry.path} (${entry.forced ? "force-killed" : "exited on request"})`).join(", ");
}

function stopInstallProcesses(dirs, stage) {
  try {
    const stopped = stopProcessesInsideDirs(dirs);
    if (stopped.length > 0) console.warn(`stopped processes running from the install directory ${stage}: ${describeStoppedProcesses(stopped)}`);
  } catch (err) {
    console.warn(`could not stop processes running from the install directory ${stage}: ${err.message}`);
  }
}

function removalFailureOutcome(failure, appFilesLeft) {
  return appFilesLeft ? { error: failure } : { warning: `${failure} (no app files left in it, continuing)` };
}

function staleRegistryKeys({ registryKeys, guid, installLocation, uninstallerPresent }) {
  if (installLocation === null || uninstallerPresent || !guid) return [];
  const keys = [registryKeys.install, registryKeys.uninstall];
  const suffix = `\\${guid}`.toLowerCase();
  return keys.every((key) => key.toLowerCase().endsWith(suffix)) ? keys : [];
}

function deleteRegistryKeys(keys) {
  const failures = [];
  for (const key of keys) {
    const result = spawnSync("reg", ["delete", key, "/f"], { encoding: "utf8" });
    const stillPresent = spawnSync("reg", ["query", key], { encoding: "utf8" }).status === 0;
    if (result.status !== 0 && stillPresent) failures.push(`${key}: ${(result.stderr || result.stdout).trim()}`);
  }
  return failures;
}

function settleInstallRegistry(registryKeys, waitForUninstaller) {
  let waitError = null;
  if (waitForUninstaller) {
    try {
      waitForRegistryValueGone(registryKeys.install, "InstallLocation", UNINSTALL_POLL_TIMEOUT_MS);
      return {};
    } catch (err) {
      waitError = err.message;
    }
  }
  const location = readRegistryValue(registryKeys.install, "InstallLocation");
  if (location === null) return {};
  const uninstallerPresent = existsSync(join(location, UNINSTALLER_NAME));
  const missingUninstaller = `registry InstallLocation points to ${location} but ${UNINSTALLER_NAME} is missing there`;
  const keys = staleRegistryKeys({ registryKeys, guid: UPDATER_GUID, installLocation: location, uninstallerPresent });
  if (keys.length === 0) return { error: uninstallerPresent ? (waitError ?? `registry InstallLocation still points to ${location}`) : missingUninstaller };
  const failures = deleteRegistryKeys(keys);
  if (failures.length > 0) return { error: `${missingUninstaller}; could not delete its registry keys: ${failures.join("; ")}` };
  const remaining = readRegistryValue(registryKeys.install, "InstallLocation");
  if (remaining !== null) return { error: `${missingUninstaller}; InstallLocation still reads ${remaining} after deleting ${keys.join(", ")}` };
  return { warning: `${missingUninstaller}; deleted the stale registry keys ${keys.join(", ")}` };
}

function removeInstallDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 1000 });
    return existsSync(dir) ? `install directory still present after removal: ${dir}` : null;
  } catch (err) {
    return `could not remove install directory ${dir}: ${err.message}`;
  }
}

function cleanupInstallation({ registryKeys, candidateDirs = [], ownedDirs = [], removableDirs = [] }) {
  const errors = [];
  const registryLocation = readRegistryValue(registryKeys.install, "InstallLocation");
  const dirs = detectInstallDirs(registryLocation, candidateDirs, ownedDirs);
  let uninstallerRan = false;
  stopInstallProcesses(dirs, "before uninstalling");
  for (const dir of dirs) {
    const uninstallerPath = join(dir, UNINSTALLER_NAME);
    if (!existsSync(uninstallerPath)) continue;
    uninstallerRan = true;
    try {
      runSilent(uninstallerPath, ["/S", `_?=${dir}`]);
    } catch (err) {
      errors.push(`uninstall of ${dir} failed: ${err.message}`);
    }
  }
  const removable = new Set([...ownedDirs, ...removableDirs].filter((dir) => isSafeRemovalTarget(dir)).map(dirKey));
  stopInstallProcesses(dirs, "before removing it");
  for (const dir of dirs) {
    if (!removable.has(dirKey(dir))) {
      if (hasInstallEvidence(dir)) console.warn(`left ${dir} in place: it is not a verifier-owned or expected install directory`);
      continue;
    }
    let failure = removeInstallDir(dir);
    if (failure && hasInstallEvidence(dir)) {
      stopInstallProcesses([dir], "before retrying its removal");
      failure = removeInstallDir(dir);
    }
    if (!failure) continue;
    const outcome = removalFailureOutcome(failure, hasInstallEvidence(dir));
    if (outcome.error) errors.push(outcome.error);
    else console.warn(outcome.warning);
  }
  if (registryLocation !== null || uninstallerRan) {
    const outcome = settleInstallRegistry(registryKeys, uninstallerRan);
    if (outcome.error) errors.push(outcome.error);
    if (outcome.warning) console.warn(outcome.warning);
  }
  return errors;
}

function withCleanupErrors(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) return primaryError;
  const details = cleanupErrors.map((message) => `  - ${message}`).join("\n");
  return new Error(`${primaryError.message}\ncleanup after this failure also failed:\n${details}`, { cause: primaryError });
}

function startupModeProblem(label, probe) {
  if (probe.startupMode === undefined || probe.startupMode === "ready") return null;
  return `${label}: app started in '${probe.startupMode}' mode instead of 'ready'`;
}

function cwCodeHomeDir() {
  return join(process.env.USERPROFILE ?? homedir(), ".cw-code");
}

function electronUserDataDir() {
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "@cw-code", "desktop");
}

const FIXTURE_SENTINEL_PATTERN = /^cw-verify-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIXTURE_UNKNOWN_KEY = "cwVerifyUnknownKey";
const PROJECT_FIELDS = ["id", "rootPath", "name"];
const SESSION_FIELDS = ["id", "projectId", "resumeCursor", "worktreePath", "branch", FIXTURE_UNKNOWN_KEY];

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

function createSeedPlan() {
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
        resumeCursor: "cw-verify-resume-cursor",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        worktreePath: worktreeDir,
        branch: "cw-verify/fixture-branch",
        [FIXTURE_UNKNOWN_KEY]: sentinel
      }
    ]
  };
  const settings = {
    _fixture: sentinel,
    claudeExtraArgs: "--verbose",
    sourceControlRefreshIntervalSeconds: 45,
    autoTitleEnabled: false,
    holdingHours: 12
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

function seedRealUserData(seed) {
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

function cleanupSeededFixtures(seed) {
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

function assertDataUnchanged(seed, stage, problems) {
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

function compareEntries(label, expectedEntries, actualEntries, fields, stage, problems) {
  const actualList = Array.isArray(actualEntries) ? actualEntries : [];
  for (const expected of expectedEntries) {
    const actual = actualList.find((candidate) => candidate?.id === expected.id);
    if (!actual) {
      problems.push(`${label} '${expected.id}' missing ${stage}`);
      continue;
    }
    for (const field of fields) {
      if (!sameValue(actual[field], expected[field])) {
        problems.push(
          `${label} '${expected.id}' field '${field}' changed ${stage}: ` +
            `expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(actual[field])}`
        );
      }
    }
  }
}

function assertDataPreservedSemantically(seed, stage, problems) {
  const db = readJsonForCheck("userdata db", seed.paths.db, stage, problems);
  if (db) {
    compareEntries("project", seed.db.projects, db.projects, PROJECT_FIELDS, stage, problems);
    compareEntries("session", seed.db.sessions, db.sessions, SESSION_FIELDS, stage, problems);
    if (!sameValue(db[FIXTURE_UNKNOWN_KEY], seed.db[FIXTURE_UNKNOWN_KEY])) {
      problems.push(`userdata db unknown key '${FIXTURE_UNKNOWN_KEY}' not preserved ${stage}`);
    }
  }
  const settings = readJsonForCheck("settings", seed.paths.settings, stage, problems);
  if (settings) {
    for (const [key, expected] of Object.entries(seed.settings)) {
      if (key === "_fixture") continue;
      if (!sameValue(settings[key], expected)) {
        problems.push(`settings '${key}' changed ${stage}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(settings[key])}`);
      }
    }
  }
  assertBytesUnchanged(markerChecks(seed), stage, problems);
}

async function installMode(distDir, disposableEnvironment) {
  requireDisposableEnvironment("--install", disposableEnvironment);
  const version = findInstallerVersion(distDir);
  const installerPath = join(distDir, `cw-code-Setup-${version}-x64.exe`);
  if (!existsSync(installerPath)) throw new Error(`installer not found: ${installerPath}`);

  const installDir = mkdtempSync(join(tmpdir(), "cw-verify-install-"));
  const problems = [];
  let durationMs = null;
  let exitCode = null;
  let probe = null;
  let primaryError = null;
  let cleanupErrors = [];
  try {
    const start = Date.now();
    runSilent(installerPath, ["/S", `/D=${installDir}`]);
    durationMs = Date.now() - start;
    try {
      const result = await runPackageProbe(join(installDir, `${PRODUCT_NAME}.exe`));
      exitCode = result.exitCode;
      probe = result.probe;
      if (!probe.rendererLoaded) problems.push("install mode probe: renderer failed to load");
      if (!probe.nodePty.spawned) problems.push(`install mode probe: node-pty did not spawn (${probe.nodePty.error ?? "unknown error"})`);
      const startupProblem = startupModeProblem("install mode probe", probe);
      if (startupProblem) problems.push(startupProblem);
    } catch (err) {
      problems.push(`install mode probe failed: ${err.message}`);
    }
  } catch (err) {
    primaryError = err;
  } finally {
    cleanupErrors = cleanupInstallation({ registryKeys: registryPaths(false), ownedDirs: [installDir] });
  }

  if (primaryError) throw withCleanupErrors(primaryError, cleanupErrors);
  problems.push(...cleanupErrors.map((message) => `install mode cleanup: ${message}`));
  return { durationMs, exitCode, probe, installDir, problems };
}

async function upgradeFromMode(distDir, legacyInstallerPath, disposableEnvironment, opts = {}) {
  requireDisposableEnvironment("--upgrade-from", disposableEnvironment);
  if (!existsSync(legacyInstallerPath)) throw new Error(`legacy installer not found: ${legacyInstallerPath}`);
  const newVersion = findInstallerVersion(distDir);
  const newInstallerPath = join(distDir, `cw-code-Setup-${newVersion}-x64.exe`);
  if (!existsSync(newInstallerPath)) throw new Error(`installer not found: ${newInstallerPath}`);

  const perMachine = Boolean(opts.perMachine);
  const customDir = opts.customDir ?? null;
  if (customDir && (existsSync(customDir) || !isSafeRemovalTarget(customDir))) {
    throw new Error(`--custom-dir must be a new directory outside profile and system folders (it is removed afterwards): ${customDir}`);
  }
  if (perMachine && !isElevated()) {
    throw new Error(
      "--per-machine requires an elevated (Administrator) process — 'net session' did not succeed. " +
        "Re-run from an elevated shell (hosted GitHub Windows runners are elevated by default)."
    );
  }
  const registryKeys = registryPaths(perMachine);
  const legacyArgs = perMachine ? ["/S", "/allusers"] : customDir ? ["/S", `/D=${customDir}`] : ["/S"];
  const upgradeArgs = perMachine ? ["/S", "/allusers"] : ["/S"];

  const problems = [];
  const seed = createSeedPlan();
  let installLocationBefore = null;
  let displayVersionBefore = null;
  let publisherBefore = null;
  let installLocationAfter = null;
  let displayVersionAfter = null;
  let publisherAfter = null;
  let postUpgradeProbe = null;
  let primaryError = null;
  let cleanupErrors = [];

  try {
    const legacyInstall = runSilentWithRetry(legacyInstallerPath, legacyArgs, registryKeys);
    if (legacyInstall.retried) console.warn("legacy installer succeeded only on retry; see diagnostics above");
    installLocationBefore = readRegistryValue(registryKeys.install, "InstallLocation");
    displayVersionBefore = readRegistryValue(registryKeys.uninstall, "DisplayVersion");
    publisherBefore = readRegistryValue(registryKeys.uninstall, "Publisher");

    if (!installLocationBefore) problems.push(`InstallLocation missing at ${registryKeys.install} after legacy install`);
    if (customDir && installLocationBefore !== customDir) {
      problems.push(`legacy install did not honor the custom directory: expected '${customDir}', got '${installLocationBefore}'`);
    }
    const legacyVersion = parseLegacyInstallerVersion(legacyInstallerPath);
    if (legacyVersion && displayVersionBefore !== legacyVersion) {
      problems.push(`DisplayVersion after legacy install is '${displayVersionBefore}', expected '${legacyVersion}'`);
    }

    seedRealUserData(seed);
    runSilent(newInstallerPath, upgradeArgs);

    installLocationAfter = readRegistryValue(registryKeys.install, "InstallLocation");
    displayVersionAfter = readRegistryValue(registryKeys.uninstall, "DisplayVersion");
    publisherAfter = readRegistryValue(registryKeys.uninstall, "Publisher");
    const expectedAuthor = readDesktopAuthor();

    if (!installLocationAfter) problems.push(`InstallLocation missing at ${registryKeys.install} after upgrade`);
    if (installLocationAfter !== installLocationBefore) {
      problems.push(`InstallLocation changed from '${installLocationBefore}' to '${installLocationAfter}'`);
    }
    if (displayVersionBefore === displayVersionAfter) {
      problems.push(`DisplayVersion did not change across the upgrade (stayed '${displayVersionBefore}')`);
    }
    if (displayVersionAfter !== newVersion) {
      problems.push(`DisplayVersion after upgrade is '${displayVersionAfter}', expected '${newVersion}'`);
    }
    if (expectedAuthor && publisherAfter !== expectedAuthor) {
      problems.push(`Publisher after upgrade is '${publisherAfter}' (was '${publisherBefore}'), expected '${expectedAuthor}'`);
    }

    assertDataUnchanged(seed, "after the upgrade installer", problems);

    if (installLocationAfter) {
      try {
        const { exitCode, probe } = await runPackageProbe(join(installLocationAfter, `${PRODUCT_NAME}.exe`), {
          cwCodeHome: cwCodeHomeDir(),
          defaultUserData: true
        });
        postUpgradeProbe = { exitCode, ...probe };
        if (exitCode !== 0) problems.push(`post-upgrade probe exited with code ${exitCode}`);
        if (!probe.rendererLoaded) {
          const failures = Array.isArray(probe.rendererFailures) ? probe.rendererFailures.join("; ") : "";
          problems.push(`post-upgrade probe: renderer failed to load (${failures || "no failure recorded"})`);
        }
        if (probe.appVersion !== newVersion) {
          problems.push(`post-upgrade probe appVersion is '${probe.appVersion}', expected '${newVersion}'`);
        }
        if (!probe.nodePty.spawned) {
          problems.push(`post-upgrade probe: node-pty did not spawn (${probe.nodePty.error ?? "unknown error"})`);
        }
        const startupProblem = startupModeProblem("post-upgrade probe", probe);
        if (startupProblem) problems.push(startupProblem);
      } catch (err) {
        problems.push(`post-upgrade probe failed: ${err.message}`);
      }
      assertDataPreservedSemantically(seed, "after the first post-upgrade start", problems);
    }
  } catch (err) {
    primaryError = err;
  } finally {
    cleanupErrors = cleanupInstallation({
      registryKeys,
      candidateDirs: [installLocationBefore, installLocationAfter, customDir, defaultInstallDir(perMachine)],
      removableDirs: [customDir, defaultInstallDir(perMachine)].filter(Boolean)
    });
    cleanupSeededFixtures(seed);
  }

  if (primaryError) throw withCleanupErrors(primaryError, cleanupErrors);
  problems.push(...cleanupErrors.map((message) => `upgrade cleanup: ${message}`));
  return {
    perMachine,
    customDir,
    installLocationBefore,
    installLocationAfter,
    displayVersionBefore,
    displayVersionAfter,
    publisherBefore,
    publisherAfter,
    postUpgradeProbe,
    problems
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = { dist: args.dist };

  const { report, problems } = await checkPackage(args.dist);
  summary.package = report;
  summary.problems = problems;

  if (args.install) {
    summary.install = await installMode(args.dist, args.disposableEnvironment);
    problems.push(...summary.install.problems);
  }
  if (args.upgradeFrom) {
    summary.upgrade = await upgradeFromMode(args.dist, args.upgradeFrom, args.disposableEnvironment, {
      customDir: args.customDir,
      perMachine: args.perMachine
    });
    problems.push(...summary.upgrade.problems);
  }

  const jsonText = JSON.stringify(summary, null, 2);
  const reportPath = join(args.dist, "verify-windows-package.json");
  if (existsSync(args.dist)) writeFileSync(reportPath, jsonText, "utf8");

  console.log(jsonText);
  console.log("");
  console.log(`cw-code Windows package verification (${report.version})`);
  console.log(`  installer: ${report.installer.exists ? "OK" : "MISSING"} (${installerSummary(report)})`);
  console.log(`  blockmap: ${report.blockmap.exists ? "OK" : "MISSING"}`);
  console.log(`  win-unpacked exe: ${report.unpackedExe.exists ? "OK" : "MISSING"}`);
  console.log(`  app.asar: ${report.asar.exists ? "OK" : "MISSING"} (${asarSummary(report)})`);
  console.log(`  node-pty win32-x64 native binary: ${report.nodePtyNative.exists ? "OK" : "MISSING"}`);
  if (report.probe) {
    console.log(`  probe: rendererLoaded=${report.probe.rendererLoaded} nodePty.spawned=${report.probe.nodePty.spawned} durationMs=${report.probe.durationMs}`);
  }

  if (problems.length > 0) {
    console.error("");
    console.error("FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

function installerSummary(report) {
  return report.installer.sizeBytes !== null ? `${(report.installer.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "n/a";
}

function asarSummary(report) {
  return report.asar.sizeBytes !== null ? `${(report.asar.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "n/a";
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
