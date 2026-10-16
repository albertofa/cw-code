import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDisposableEnvironment } from "./lib/package-probe.mjs";
import {
  DEB_INSTALL_DIR,
  DEB_LAUNCHER,
  DEB_PACKAGE_NAME,
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

const defaultDesktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop");

function optionValue(argv, index, name) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a directory`);
  return resolve(value);
}

function parseArgs(argv) {
  const args = { desktopDir: defaultDesktopDir, dist: null, installDeb: false, disposableEnvironment: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--desktop-dir") args.desktopDir = optionValue(argv, ++i, arg);
    else if (arg === "--dist") args.dist = optionValue(argv, ++i, arg);
    else if (arg === "--install-deb") args.installDeb = true;
    else if (arg === "--disposable-environment") args.disposableEnvironment = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.dist ??= join(args.desktopDir, "dist");
  return args;
}

function readDesktopVersion(desktopDir) {
  const packageJsonPath = join(desktopDir, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error(`desktop package.json not found: ${packageJsonPath} (pass --desktop-dir <apps/desktop of the build>)`);
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

function checkArtifacts(distDir, version) {
  const appImagePath = join(distDir, `cw-code-${version}-x86_64.AppImage`);
  const debPath = join(distDir, `cw-code-${version}-amd64.deb`);
  const latestPath = join(distDir, "latest-linux.yml");
  const latestText = existsSync(latestPath) ? readFileSync(latestPath, "utf8") : null;
  const artifacts = {
    appImage: { path: appImagePath, exists: existsSync(appImagePath), sizeBytes: fileSize(appImagePath) },
    deb: { path: debPath, exists: existsSync(debPath), sizeBytes: fileSize(debPath) },
    latestLinuxYml: { path: latestPath, exists: latestText !== null, matchesVersion: latestText?.includes(`version: ${version}\n`) ?? false }
  };
  const problems = [];
  if (!artifacts.appImage.exists) problems.push(`AppImage not found: ${appImagePath}`);
  if (!artifacts.deb.exists) problems.push(`deb not found: ${debPath}`);
  if (!artifacts.latestLinuxYml.exists) problems.push(`latest-linux.yml not found: ${latestPath}`);
  else if (!artifacts.latestLinuxYml.matchesVersion) problems.push(`latest-linux.yml does not declare version ${version}`);
  return { artifacts, problems };
}

async function appImageMode(appImagePath, version) {
  const fuse = fuseAvailability();
  const launch = fuse.available
    ? { mode: "fuse-mount", reason: fuse.reason, env: { APPIMAGE_SILENT_INSTALL: "1" } }
    : { mode: "extract-and-run", reason: fuse.reason, env: { APPIMAGE_SILENT_INSTALL: "1", APPIMAGE_EXTRACT_AND_RUN: "1" } };
  const madeExecutable = ensureExecutable(appImagePath);
  const report = { path: appImagePath, madeExecutable, launch, probe: null, sandbox: null };
  const problems = [];
  try {
    const result = await runLinuxProbe(appImagePath, { env: launch.env, appImage: true });
    report.probe = { exitCode: result.exitCode, ...result.probe };
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
  if (preinstalled !== null) throw new Error(`${DEB_PACKAGE_NAME} ${preinstalled} is already installed; refusing to replace it`);
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
      const result = await runLinuxProbe(DEB_LAUNCHER);
      report.probe = { exitCode: result.exitCode, ...result.probe };
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
  if (!sandbox) return "not observed";
  return `${sandbox.decision.verdict}; label=${sandbox.decision.label ?? "none"}; chrome-sandbox ${sandbox.sandboxHelper.uid ?? "?"}:${sandbox.sandboxHelper.mode ?? sandbox.sandboxHelper.error}`;
}

function describeProbe(probe) {
  if (!probe) return "not run";
  return `platform=${probe.platform} startupMode=${probe.startupMode} rendererLoaded=${probe.rendererLoaded} nodePty.spawned=${probe.nodePty?.spawned} nodePty.exitCode=${probe.nodePty?.exitCode} durationMs=${probe.durationMs}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireDisposableEnvironment("verify-linux-package", args.disposableEnvironment, "Linux");
  requireLinuxHost();
  const version = readDesktopVersion(args.desktopDir);
  const summary = {
    version,
    desktopDir: args.desktopDir,
    dist: args.dist,
    apparmorRestrictUnprivilegedUserns: readUsernsRestriction(),
    unprivilegedUsernsUsable: unprivilegedUsernsUsable()
  };

  const { artifacts, problems } = checkArtifacts(args.dist, version);
  summary.artifacts = artifacts;
  summary.problems = problems;

  if (artifacts.appImage.exists) {
    const appImage = await appImageMode(artifacts.appImage.path, version);
    summary.appImage = appImage.report;
    problems.push(...appImage.problems);
  }
  if (args.installDeb && artifacts.deb.exists) {
    const deb = await debMode(artifacts.deb.path, version);
    summary.deb = deb.report;
    problems.push(...deb.problems);
  }

  const jsonText = JSON.stringify(summary, null, 2);
  if (existsSync(args.dist)) writeFileSync(join(args.dist, "verify-linux-package.json"), jsonText, "utf8");

  console.log(jsonText);
  console.log("");
  console.log(`cw-code Linux package verification (${version})`);
  console.log(`  AppImage: ${artifacts.appImage.exists ? "OK" : "MISSING"}`);
  console.log(`  deb: ${artifacts.deb.exists ? "OK" : "MISSING"}`);
  console.log(`  latest-linux.yml: ${artifacts.latestLinuxYml.matchesVersion ? "OK" : "MISSING OR STALE"}`);
  console.log(`  apparmor_restrict_unprivileged_userns: ${summary.apparmorRestrictUnprivilegedUserns ?? "absent"}`);
  console.log(`  unprivileged user namespaces usable: ${summary.unprivilegedUsernsUsable}`);
  if (summary.appImage) {
    console.log(`  AppImage launch: ${summary.appImage.launch.mode} (${summary.appImage.launch.reason})`);
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

  if (problems.length > 0) {
    console.error("");
    console.error("FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
