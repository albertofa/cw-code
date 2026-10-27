import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha512Base64 } from "../tools/release/src/rehash.ts";
import { requireDisposableEnvironment } from "./lib/package-probe.mjs";
import {
  DEB_INSTALL_DIR,
  DEB_LAUNCHER,
  DEB_PACKAGE_NAME,
  DEB_SANDBOX_HELPER,
  commandExists,
  debInstallState,
  debianVersion,
  ensureExecutable,
  fuseAvailability,
  installedDebVersion,
  linuxProbeProblems,
  readUsernsRestriction,
  runLinuxProbe,
  runSudo,
  unprivilegedUsernsUsable
} from "./lib/linux-install.mjs";

const USAGE = [
  "usage: node verify-linux-package.mjs --desktop-dir <dir> --dist <dir> [--install-deb] --disposable-environment",
  "  --desktop-dir <dir>       apps/desktop of the build; its package.json gives the expected version",
  "  --dist <dir>              electron-builder output holding the AppImage, deb and latest-linux.yml",
  "  --install-deb             also install, start and remove the deb with sudo apt-get",
  "  --disposable-environment  required: the AppImage runs and the deb installs on this machine"
].join("\n");

class UsageError extends Error {}

function optionValue(argv, index, name) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} requires a directory`);
  return resolve(value);
}

function parseArgs(argv) {
  const args = { desktopDir: null, dist: null, installDeb: false, disposableEnvironment: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--desktop-dir") args.desktopDir = optionValue(argv, ++i, arg);
    else if (arg === "--dist") args.dist = optionValue(argv, ++i, arg);
    else if (arg === "--install-deb") args.installDeb = true;
    else if (arg === "--disposable-environment") args.disposableEnvironment = true;
    else if (arg === "--help") args.help = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.desktopDir) throw new UsageError("--desktop-dir is required");
  if (!args.dist) throw new UsageError("--dist is required");
  return args;
}

function readDesktopVersion(desktopDir) {
  const packageJsonPath = join(desktopDir, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error(`desktop package.json not found: ${packageJsonPath}; --desktop-dir must point at apps/desktop of the build`);
  const version = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  if (typeof version !== "string" || version === "") throw new Error(`${packageJsonPath} has no version`);
  return version;
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : null;
}

function requireLinuxHost() {
  if (process.platform !== "linux") throw new Error(`verify-linux-package runs on Linux only (this is ${process.platform})`);
  if (process.getuid() === 0) {
    throw new Error("verify-linux-package must run as a non-root user with passwordless sudo: Chromium refuses to start as root with the sandbox enabled");
  }
  const missing = ["xvfb-run", "xauth"].filter((command) => !commandExists(command));
  if (missing.length > 0) throw new Error(`missing required commands: ${missing.join(", ")} (install the xvfb and xauth packages)`);
}

async function describeArtifact(path) {
  const exists = existsSync(path);
  return { path, exists, sizeBytes: fileSize(path), sha512: exists ? await sha512Base64(path) : null };
}

async function checkArtifacts(distDir, version) {
  const appImagePath = join(distDir, `cw-code-${version}-x86_64.AppImage`);
  const debPath = join(distDir, `cw-code-${version}-amd64.deb`);
  const latestPath = join(distDir, "latest-linux.yml");
  const latestText = existsSync(latestPath) ? readFileSync(latestPath, "utf8") : null;
  const serverDir = join(distDir, "linux-unpacked", "resources", "server");
  const serverBinaryPath = join(serverDir, "cw-code-server");
  const ptyNativePath = join(serverDir, "node_modules", "node-pty", "build", "Release", "pty.node");
  const uiIndexPath = join(serverDir, "ui", "index.html");
  const artifacts = {
    appImage: await describeArtifact(appImagePath),
    deb: await describeArtifact(debPath),
    latestLinuxYml: { path: latestPath, exists: latestText !== null, matchesVersion: latestText?.includes(`version: ${version}\n`) ?? false },
    serverBinary: {
      path: serverBinaryPath,
      exists: existsSync(serverBinaryPath),
      sizeBytes: fileSize(serverBinaryPath),
      executable: existsSync(serverBinaryPath) && (statSync(serverBinaryPath).mode & 0o111) !== 0
    },
    nodePtyNative: { path: ptyNativePath, exists: existsSync(ptyNativePath) },
    uiIndex: { path: uiIndexPath, exists: existsSync(uiIndexPath) }
  };
  const problems = [];
  if (!artifacts.appImage.exists) problems.push(`AppImage not found: ${appImagePath}`);
  if (!artifacts.deb.exists) problems.push(`deb not found: ${debPath}`);
  if (!artifacts.latestLinuxYml.exists) problems.push(`latest-linux.yml not found: ${latestPath}`);
  else if (!artifacts.latestLinuxYml.matchesVersion) problems.push(`latest-linux.yml does not declare version ${version}`);
  if (!artifacts.serverBinary.exists) problems.push(`server binary not found: ${serverBinaryPath}`);
  else if (!artifacts.serverBinary.executable) problems.push(`server binary is not executable: ${serverBinaryPath}`);
  if (!artifacts.nodePtyNative.exists) problems.push(`node-pty native module not found: ${ptyNativePath}`);
  if (!artifacts.uiIndex.exists) problems.push(`bundled UI not found: ${uiIndexPath}`);
  return { artifacts, problems };
}

async function appImageMode(appImagePath, version) {
  const report = { path: appImagePath, madeExecutable: null, launch: null, probe: null, sandbox: null };
  const problems = [];
  try {
    const fuse = fuseAvailability();
    report.launch = fuse.available
      ? { mode: "fuse-mount", reason: fuse.reason, env: { APPIMAGE_SILENT_INSTALL: "1" } }
      : { mode: "extract-and-run", reason: fuse.reason, env: { APPIMAGE_SILENT_INSTALL: "1", APPIMAGE_EXTRACT_AND_RUN: "1" } };
    report.madeExecutable = ensureExecutable(appImagePath);
    const result = await runLinuxProbe(appImagePath, { env: report.launch.env, appImage: true });
    report.probe = { exitCode: result.exitCode, processGroupExited: result.processGroupExited, ...result.probe };
    report.sandbox = result.sandbox;
    problems.push(...linuxProbeProblems("AppImage probe", result, version));
  } catch (err) {
    problems.push(`AppImage probe failed: ${err.message}`);
  }
  return { report, problems };
}

async function debMode(debPath, version) {
  const report = { path: debPath, installedVersion: null, install: null, probe: null, sandbox: null, remove: null, purge: null };
  const problems = [];
  const preinstalled = installedDebVersion();
  if (preinstalled !== null) {
    problems.push(`${DEB_PACKAGE_NAME} ${preinstalled} is already installed; refusing to replace it`);
    return { report, problems };
  }
  try {
    runSudo(["apt-get", "install", "-y", debPath]);
    report.installedVersion = installedDebVersion();
    report.install = debInstallState();
    const expectedDebVersion = debianVersion(version);
    if (report.installedVersion !== expectedDebVersion) problems.push(`installed deb version is '${report.installedVersion}', expected '${expectedDebVersion}'`);
    if (report.install.chromeSandbox.error) problems.push(`chrome-sandbox missing from ${DEB_INSTALL_DIR}: ${report.install.chromeSandbox.error}`);
    if (report.install.packageType !== "deb") problems.push(`${DEB_INSTALL_DIR}/resources/package-type is '${report.install.packageType}', expected 'deb'`);
    if (report.install.launcherTarget === null) problems.push(`${DEB_LAUNCHER} is missing after install`);
    try {
      const result = await runLinuxProbe(DEB_LAUNCHER, { sandboxHelperPath: DEB_SANDBOX_HELPER });
      report.probe = { exitCode: result.exitCode, processGroupExited: result.processGroupExited, ...result.probe };
      report.sandbox = result.sandbox;
      problems.push(...linuxProbeProblems("deb probe", result, version));
    } catch (err) {
      problems.push(`deb probe failed: ${err.message}`);
    }
    runSudo(["apt-get", "remove", "-y", DEB_PACKAGE_NAME]);
    report.remove = {
      installedVersion: installedDebVersion(),
      binaryPresent: existsSync(join(DEB_INSTALL_DIR, "cw-code-bin")),
      launcherPresent: existsSync(DEB_LAUNCHER)
    };
    if (report.remove.installedVersion !== null) problems.push(`${DEB_PACKAGE_NAME} is still installed after apt-get remove`);
    if (report.remove.binaryPresent) problems.push(`${DEB_INSTALL_DIR}/cw-code-bin still present after apt-get remove`);
    if (report.remove.launcherPresent) problems.push(`${DEB_LAUNCHER} still present after apt-get remove`);
  } catch (err) {
    problems.push(`deb verification failed: ${err.message}`);
  } finally {
    try {
      runSudo(["apt-get", "purge", "-y", DEB_PACKAGE_NAME]);
      report.purge = { ok: true, installDirPresent: existsSync(DEB_INSTALL_DIR) };
      if (report.purge.installDirPresent) problems.push(`${DEB_INSTALL_DIR} still present after apt-get purge`);
    } catch (err) {
      report.purge = { ok: false, error: err.message };
      problems.push(`deb cleanup: ${err.message}`);
    }
  }
  return { report, problems };
}

function describeSandbox(sandbox) {
  if (!sandbox) return "not run";
  if (!sandbox.decision) return "the app reported no sandbox evidence";
  const helper = sandbox.host.sandboxHelper;
  const helperText = helper.path === null ? "inside AppImage" : `${helper.uid ?? "?"}:${helper.mode ?? helper.error}`;
  return `${sandbox.decision.verdict}; noSandboxSwitch=${sandbox.app.noSandboxSwitch}; label=${sandbox.app.apparmorLabel ?? "none"}; chrome-sandbox ${helperText}`;
}

function describeProbe(probe) {
  if (!probe) return "not run";
  return `platform=${probe.platform} startupMode=${probe.startupMode} rendererLoaded=${probe.rendererLoaded} nodePty.spawned=${probe.nodePty?.spawned} nodePty.exitCode=${probe.nodePty?.exitCode} durationMs=${probe.durationMs}`;
}

async function verify(args, summary) {
  requireLinuxHost();
  const version = readDesktopVersion(args.desktopDir);
  summary.version = version;
  summary.apparmorRestrictUnprivilegedUserns = readUsernsRestriction();
  summary.unprivilegedUsernsUsable = unprivilegedUsernsUsable();

  const { artifacts, problems } = await checkArtifacts(args.dist, version);
  summary.artifacts = artifacts;
  summary.problems.push(...problems);

  if (artifacts.appImage.exists) {
    const appImage = await appImageMode(artifacts.appImage.path, version);
    summary.appImage = appImage.report;
    summary.problems.push(...appImage.problems);
  }
  if (args.installDeb && artifacts.deb.exists) {
    const deb = await debMode(artifacts.deb.path, version);
    summary.deb = deb.report;
    summary.problems.push(...deb.problems);
  }
}

function printSummary(summary, args) {
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`cw-code Linux package verification (${summary.version ?? "unknown version"})`);
  if (summary.artifacts) {
    console.log(`  AppImage: ${summary.artifacts.appImage.exists ? "OK" : "MISSING"}`);
    console.log(`  deb: ${summary.artifacts.deb.exists ? "OK" : "MISSING"}`);
    console.log(`  latest-linux.yml: ${summary.artifacts.latestLinuxYml.matchesVersion ? "OK" : "MISSING OR STALE"}`);
    console.log(`  server binary: ${summary.artifacts.serverBinary.executable ? "OK" : "MISSING OR NOT EXECUTABLE"}`);
    console.log(`  node-pty native module: ${summary.artifacts.nodePtyNative.exists ? "OK" : "MISSING"}`);
    console.log(`  bundled UI: ${summary.artifacts.uiIndex.exists ? "OK" : "MISSING"}`);
    console.log(`  apparmor_restrict_unprivileged_userns: ${summary.apparmorRestrictUnprivilegedUserns ?? "absent"}`);
    console.log(`  unprivileged user namespaces usable: ${summary.unprivilegedUsernsUsable}`);
  }
  if (summary.appImage) {
    console.log(`  AppImage launch: ${summary.appImage.launch ? `${summary.appImage.launch.mode} (${summary.appImage.launch.reason})` : "not started"}`);
    console.log(`  AppImage probe: ${describeProbe(summary.appImage.probe)}`);
    console.log(`  AppImage sandbox: ${describeSandbox(summary.appImage.sandbox)}`);
  }
  if (summary.deb) {
    console.log(`  deb install: version=${summary.deb.installedVersion} chrome-sandbox=${summary.deb.install?.chromeSandboxMechanism} package-type=${summary.deb.install?.packageType}`);
    console.log(`  deb probe: ${describeProbe(summary.deb.probe)}`);
    console.log(`  deb sandbox: ${describeSandbox(summary.deb.sandbox)}`);
  } else if (!args.installDeb) {
    console.log("  deb install: skipped (pass --install-deb)");
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      return;
    }
    requireDisposableEnvironment("verify-linux-package", args.disposableEnvironment, "Linux");
  } catch (err) {
    console.error(err instanceof UsageError ? `${err.message}\n${USAGE}` : err.message);
    process.exitCode = 1;
    return;
  }

  const summary = { version: null, desktopDir: args.desktopDir, dist: args.dist, error: null, problems: [] };
  try {
    await verify(args, summary);
  } catch (err) {
    summary.error = err.stack ?? err.message;
    summary.problems.push(`verification aborted: ${err.message}`);
  } finally {
    if (existsSync(args.dist)) writeFileSync(join(args.dist, "verify-linux-package.json"), JSON.stringify(summary, null, 2), "utf8");
    else summary.problems.push(`--dist ${args.dist} does not exist; no evidence file was written`);
  }

  printSummary(summary, args);
  if (summary.problems.length > 0) {
    console.error("");
    console.error("FAILED:");
    for (const problem of summary.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
