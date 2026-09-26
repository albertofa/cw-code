import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDataPreservedSemantically,
  assertDataUnchanged,
  cleanupSeededFixtures,
  createSeedPlan,
  cwCodeHomeDir,
  seedRealUserData
} from "./lib/real-user-data.mjs";
import {
  cleanupInstallation,
  defaultInstallDir,
  isElevated,
  resolveAsarLib,
  readRegistryValue,
  registryPaths,
  requireDisposableEnvironment,
  runPackageProbe,
  startupModeProblem,
  runSilent,
  runSilentWithRetry,
  withCleanupErrors
} from "./lib/windows-install.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const desktopDir = join(repoRoot, "apps", "desktop");
const UPDATER_GUID = "d6e18d04-bf35-5bfe-9145-b95301660833";
const PRODUCT_NAME = "cw-code";
const EXECUTABLE_NAME = `${PRODUCT_NAME}.exe`;
const UNINSTALLER_NAME = `Uninstall ${PRODUCT_NAME}.exe`;

function cleanupProductInstallation(registryKeys, dirs) {
  return cleanupInstallation({ registryKeys, uninstallerName: UNINSTALLER_NAME, executableName: EXECUTABLE_NAME, ...dirs }).errors;
}

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
    const asarLib = await resolveAsarLib(desktopDir);
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
      const result = await runPackageProbe(join(installDir, EXECUTABLE_NAME));
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
    cleanupErrors = cleanupProductInstallation(registryPaths(UPDATER_GUID, false), { ownedDirs: [installDir] });
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
  if (perMachine && !isElevated()) {
    throw new Error(
      "--per-machine requires an elevated (Administrator) process — 'net session' did not succeed. " +
        "Re-run from an elevated shell (hosted GitHub Windows runners are elevated by default)."
    );
  }
  const registryKeys = registryPaths(UPDATER_GUID, perMachine);
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
        const { exitCode, probe } = await runPackageProbe(join(installLocationAfter, EXECUTABLE_NAME), {
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
    cleanupErrors = cleanupProductInstallation(registryKeys, {
      candidateDirs: [installLocationBefore, installLocationAfter, customDir, defaultInstallDir(PRODUCT_NAME, perMachine)]
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
