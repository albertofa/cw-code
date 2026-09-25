import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const desktopDir = join(repoRoot, "apps", "desktop");
const UPDATER_GUID = "d6e18d04-bf35-5bfe-9145-b95301660833";
const PROBE_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const args = {
    dist: join(desktopDir, "dist"),
    install: false,
    upgradeFrom: null,
    disposableEnvironment: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dist") args.dist = resolve(argv[++i]);
    else if (arg === "--install") args.install = true;
    else if (arg === "--upgrade-from") args.upgradeFrom = resolve(argv[++i]);
    else if (arg === "--disposable-environment") args.disposableEnvironment = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function readDesktopVersion() {
  const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  return pkg.version;
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : null;
}

async function resolveAsarLib() {
  try {
    return await import("@electron/asar");
  } catch {
  }
  try {
    const desktopRequire = createRequire(join(desktopDir, "package.json"));
    const builderPkgPath = desktopRequire.resolve("electron-builder/package.json");
    const builderRequire = createRequire(builderPkgPath);
    return builderRequire("@electron/asar");
  } catch {
    return null;
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

async function runPackageProbe(exePath, opts = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "cw-verify-probe-"));
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
      child.kill();
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
  rmSync(workDir, { recursive: true, force: true });
  return { exitCode: result.exitCode, probe };
}

async function checkPackage(distDir) {
  const version = readDesktopVersion();
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
    if (!asarLib) {
      console.warn("warning: @electron/asar not resolvable, skipping app.asar content listing");
    } else {
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

function readUninstallRegistryValue(name) {
  const keyPath = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UPDATER_GUID}`;
  const result = spawnSync("reg", ["query", keyPath, "/v", name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.match(new RegExp(`${name}\\s+REG_SZ\\s+(.+)`));
  return match ? match[1].trim() : null;
}

async function installMode(distDir, disposableEnvironment) {
  requireDisposableEnvironment("--install", disposableEnvironment);
  const version = readDesktopVersion();
  const installerPath = join(distDir, `cw-code-Setup-${version}-x64.exe`);
  if (!existsSync(installerPath)) throw new Error(`installer not found: ${installerPath}`);

  const installDir = mkdtempSync(join(tmpdir(), "cw-verify-install-"));
  const start = Date.now();
  runSilent(installerPath, ["/S", `/D=${installDir}`]);
  const durationMs = Date.now() - start;

  const exePath = join(installDir, "cw-code.exe");
  const { exitCode, probe } = await runPackageProbe(exePath);

  const uninstallerPath = join(installDir, "Uninstall cw-code.exe");
  if (existsSync(uninstallerPath)) runSilent(uninstallerPath, ["/S"]);

  return { durationMs, exitCode, probe, installDir };
}

async function upgradeFromMode(distDir, legacyInstallerPath, disposableEnvironment) {
  requireDisposableEnvironment("--upgrade-from", disposableEnvironment);
  if (!existsSync(legacyInstallerPath)) throw new Error(`legacy installer not found: ${legacyInstallerPath}`);
  const version = readDesktopVersion();
  const newInstallerPath = join(distDir, `cw-code-Setup-${version}-x64.exe`);
  if (!existsSync(newInstallerPath)) throw new Error(`installer not found: ${newInstallerPath}`);

  runSilent(legacyInstallerPath, ["/S"]);
  const installLocationBefore = readUninstallRegistryValue("InstallLocation");

  const seedHome = join(process.env.LOCALAPPDATA ?? tmpdir(), "..", "cw-code-upgrade-seed");
  mkdirSync(join(seedHome, "userdata"), { recursive: true });
  mkdirSync(join(seedHome, "worktrees"), { recursive: true });

  runSilent(newInstallerPath, ["/S"]);

  const displayVersionAfter = readUninstallRegistryValue("DisplayVersion");
  const installLocationAfter = readUninstallRegistryValue("InstallLocation");

  const problems = [];
  if (displayVersionAfter !== version) problems.push(`DisplayVersion is '${displayVersionAfter}', expected '${version}'`);
  if (installLocationAfter !== installLocationBefore) {
    problems.push(`InstallLocation changed from '${installLocationBefore}' to '${installLocationAfter}'`);
  }
  if (!existsSync(join(seedHome, "userdata")) || !existsSync(join(seedHome, "worktrees"))) {
    problems.push("seeded userdata/worktrees were not preserved across the upgrade");
  }

  const uninstallerPath = installLocationAfter ? join(installLocationAfter, "Uninstall cw-code.exe") : null;
  if (uninstallerPath && existsSync(uninstallerPath)) runSilent(uninstallerPath, ["/S"]);

  return { installLocationBefore, installLocationAfter, displayVersionAfter, problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = { dist: args.dist };

  const { report, problems } = await checkPackage(args.dist);
  summary.package = report;
  summary.problems = problems;

  if (args.install) {
    summary.install = await installMode(args.dist, args.disposableEnvironment);
  }
  if (args.upgradeFrom) {
    summary.upgrade = await upgradeFromMode(args.dist, args.upgradeFrom, args.disposableEnvironment);
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
