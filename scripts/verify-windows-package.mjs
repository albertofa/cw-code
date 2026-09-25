import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const desktopDir = join(repoRoot, "apps", "desktop");
const UPDATER_GUID = "d6e18d04-bf35-5bfe-9145-b95301660833";
const PROBE_TIMEOUT_MS = 30_000;
const UNINSTALL_POLL_TIMEOUT_MS = 30_000;
const UNINSTALL_POLL_INTERVAL_MS = 500;

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

async function runPackageProbe(exePath, opts = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "cw-verify-probe-"));
  try {
    const cwCodeHome = join(workDir, "cw-code-home");
    const userDataDir = join(workDir, "user-data");
    const probeOutPath = join(workDir, "probe.json");
    mkdirSync(cwCodeHome, { recursive: true });
    mkdirSync(userDataDir, { recursive: true });

    const env = {
      ...process.env,
      ...opts.env,
      CW_CODE_HOME: cwCodeHome,
      CW_PACKAGE_PROBE_OUT: probeOutPath,
      PATH: opts.stripCliPath === false ? process.env.PATH : safePathWithoutClis()
    };

    const result = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(exePath, [`--user-data-dir=${userDataDir}`], { env });
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
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
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

function runUninstallSync(uninstallerPath, installDir) {
  runSilent(uninstallerPath, ["/S", `_?=${installDir}`]);
  try {
    rmSync(uninstallerPath, { force: true });
  } catch (err) {
    console.warn(`warning: could not remove leftover uninstaller ${uninstallerPath}: ${err.message}`);
  }
  try {
    rmSync(installDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`warning: could not remove leftover install directory ${installDir}: ${err.message}`);
  }
}

function cwCodeHomeDir() {
  return join(process.env.USERPROFILE ?? homedir(), ".cw-code");
}

function electronUserDataDir() {
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "@cw-code", "desktop");
}

function seedRealUserData() {
  const home = cwCodeHomeDir();
  const userdataDir = join(home, "userdata");
  const worktreeMarkerPath = join(home, "worktrees", "cw-verify-fake-worktree", "marker.txt");
  const electronMarkerPath = join(electronUserDataDir(), "marker.txt");
  const dbPath = join(userdataDir, "cw-code.db.json");
  const settingsPath = join(userdataDir, "cw-settings.json");

  mkdirSync(userdataDir, { recursive: true });
  mkdirSync(dirname(worktreeMarkerPath), { recursive: true });
  mkdirSync(dirname(electronMarkerPath), { recursive: true });

  const dbContent = `${JSON.stringify(
    {
      schemaVersion: 1,
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
  const settingsContent = `${JSON.stringify({ schemaVersion: 1, claudeBinaryPath: "claude.exe" }, null, 2)}\n`;
  const markerContent = `cw-verify marker ${Date.now()}\n`;

  writeFileSync(dbPath, dbContent, "utf8");
  writeFileSync(settingsPath, settingsContent, "utf8");
  writeFileSync(worktreeMarkerPath, markerContent, "utf8");
  writeFileSync(electronMarkerPath, markerContent, "utf8");

  return { dbPath, settingsPath, worktreeMarkerPath, electronMarkerPath, dbContent, settingsContent, markerContent };
}

function assertDataPreserved(seed, problems) {
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

async function installMode(distDir, disposableEnvironment) {
  requireDisposableEnvironment("--install", disposableEnvironment);
  const version = findInstallerVersion(distDir);
  const installerPath = join(distDir, `cw-code-Setup-${version}-x64.exe`);
  if (!existsSync(installerPath)) throw new Error(`installer not found: ${installerPath}`);

  const installDir = mkdtempSync(join(tmpdir(), "cw-verify-install-"));
  const start = Date.now();
  runSilent(installerPath, ["/S", `/D=${installDir}`]);
  const durationMs = Date.now() - start;

  const problems = [];
  let exitCode = null;
  let probe = null;
  try {
    const exePath = join(installDir, "cw-code.exe");
    const result = await runPackageProbe(exePath);
    exitCode = result.exitCode;
    probe = result.probe;
    if (!probe.rendererLoaded) problems.push("install mode probe: renderer failed to load");
    if (!probe.nodePty.spawned) problems.push(`install mode probe: node-pty did not spawn (${probe.nodePty.error ?? "unknown error"})`);
  } catch (err) {
    problems.push(`install mode probe failed: ${err.message}`);
  } finally {
    const uninstallerPath = join(installDir, "Uninstall cw-code.exe");
    if (existsSync(uninstallerPath)) {
      try {
        runUninstallSync(uninstallerPath, installDir);
      } catch (err) {
        problems.push(`install mode cleanup uninstall failed: ${err.message}`);
      }
    }
  }

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
  const registryKeys = registryPaths(perMachine);
  const legacyArgs = perMachine ? ["/S", "/allusers"] : customDir ? ["/S", `/D=${customDir}`] : ["/S"];
  const upgradeArgs = perMachine ? ["/S", "/allusers"] : ["/S"];

  const problems = [];

  runSilent(legacyInstallerPath, legacyArgs);
  const installLocationBefore = readRegistryValue(registryKeys.install, "InstallLocation");
  const displayVersionBefore = readRegistryValue(registryKeys.uninstall, "DisplayVersion");
  const publisherBefore = readRegistryValue(registryKeys.uninstall, "Publisher");

  if (!installLocationBefore) problems.push(`InstallLocation missing at ${registryKeys.install} after legacy install`);
  if (customDir && installLocationBefore !== customDir) {
    problems.push(`legacy install did not honor the custom directory: expected '${customDir}', got '${installLocationBefore}'`);
  }
  const legacyVersion = parseLegacyInstallerVersion(legacyInstallerPath);
  if (legacyVersion && displayVersionBefore !== legacyVersion) {
    problems.push(`DisplayVersion after legacy install is '${displayVersionBefore}', expected '${legacyVersion}'`);
  }

  const seed = seedRealUserData();

  runSilent(newInstallerPath, upgradeArgs);

  const installLocationAfter = readRegistryValue(registryKeys.install, "InstallLocation");
  const displayVersionAfter = readRegistryValue(registryKeys.uninstall, "DisplayVersion");
  const publisherAfter = readRegistryValue(registryKeys.uninstall, "Publisher");
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

  assertDataPreserved(seed, problems);

  if (installLocationAfter) {
    const uninstallerPath = join(installLocationAfter, "Uninstall cw-code.exe");
    if (existsSync(uninstallerPath)) {
      try {
        runUninstallSync(uninstallerPath, installLocationAfter);
        waitForRegistryValueGone(registryKeys.install, "InstallLocation", UNINSTALL_POLL_TIMEOUT_MS);
      } catch (err) {
        problems.push(`cleanup uninstall failed: ${err.message}`);
      }
    }
  }

  return {
    perMachine,
    customDir,
    installLocationBefore,
    installLocationAfter,
    displayVersionBefore,
    displayVersionAfter,
    publisherBefore,
    publisherAfter,
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
