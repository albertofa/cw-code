import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateReleaseFeed } from "../../tools/release/src/feedManifest.ts";
import { startFeedServer, summarizeTransfers } from "../../tools/release/src/feedServer.ts";
import { RENDERER_DRIVER, devToolsPage, evaluateInPage, rewriteAppUpdateForLoopback, waitFor } from "./renderer-driver.mjs";
import { assertDataPreservedSemantically, cleanupSeededFixtures, createSeedPlan, cwCodeHomeDir, seedRealUserData } from "./real-user-data.mjs";
import {
  cleanupInstallation,
  defaultInstallDir,
  isProcessAlive,
  killProcessTreeIfImage,
  nsisGuid,
  readRegistryValue,
  registryPaths,
  runSilent
} from "./windows-install.mjs";
import { nodePtyProblem, requireDisposableEnvironment, runPackageProbe, safePathWithoutClis, startupModeProblem } from "./package-probe.mjs";

const PRODUCTION_APP_ID = "com.cwcode.app";
const PRODUCTION_PRODUCT_NAME = "cw-code";
const PRODUCTION_EXECUTABLE = "cw-code.exe";
const PRODUCTION_UNINSTALLER = "Uninstall cw-code.exe";
const DRIVE_TIMEOUT_MS = 15 * 60_000;
const RELAUNCH_TIMEOUT_MS = 6 * 60_000;
const CLOSE_TIMEOUT_MS = 30_000;

function productionIdentity(cacheDirName) {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return { cacheDir: join(localAppData, cacheDirName) };
}

function mainProcessOf(exePath) {
  const quoted = exePath.replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${quoted}' -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const pid = Number.parseInt(result.stdout.trim().split(/\r?\n/)[0] ?? "", 10);
  return Number.isInteger(pid) ? pid : null;
}

function authenticode(path) {
  const quoted = path.replaceAll("'", "''");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${quoted}'; [pscustomobject]@{ status = [string]$s.Status; subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { status: "unknown", subject: null, error: result.stderr.trim() };
  }
}

export async function runProductionBytes(options) {
  requireDisposableEnvironment("--production-bytes", options.disposableEnvironment);
  const guid = nsisGuid(PRODUCTION_APP_ID);
  const perUser = registryPaths(guid, false);
  const perMachine = registryPaths(guid, true);
  if (readRegistryValue(perUser.install, "InstallLocation") || readRegistryValue(perMachine.install, "InstallLocation")) {
    throw new Error("cw-code is already installed on this machine; --production-bytes only runs on a clean disposable runner");
  }
  const candidate = await validateReleaseFeed(options.candidateDir, { requireBlockMap: true });
  if (candidate.errors.length > 0) throw new Error(`candidate release set is invalid: ${candidate.errors.join("; ")}`);

  const report = { mode: "production-bytes", candidate: { version: candidate.version, installer: candidate.installer, channelFiles: candidate.channelFiles }, steps: [], problems: [], notes: [] };
  const seed = createSeedPlan();
  const knownPids = new Set();
  let feed = null;
  let location = null;
  let cacheDir = null;
  let exe = null;
  const isInstalledExe = (image) => exe !== null && image.toLowerCase() === exe.toLowerCase();
  try {
    seedRealUserData(seed);
    runSilent(options.installer, ["/S"]);
    location = readRegistryValue(perUser.install, "InstallLocation");
    if (!location) throw new Error(`InstallLocation is missing at ${perUser.install} after installing ${options.installer}`);
    report.installedVersion = readRegistryValue(perUser.uninstall, "DisplayVersion");
    exe = join(location, PRODUCTION_EXECUTABLE);
    const appUpdatePath = join(location, "resources", "app-update.yml");
    if (!existsSync(appUpdatePath)) throw new Error("the installed production build has no resources/app-update.yml");
    const feedUrl = `http://127.0.0.1:${options.feedPort}/`;
    const rewrite = rewriteAppUpdateForLoopback(readFileSync(appUpdatePath, "utf8"), feedUrl);
    writeFileSync(appUpdatePath, rewrite.text, "utf8");
    report.appUpdate = { originalProvider: rewrite.originalProvider, publisherNames: rewrite.publisherNames, feedUrl };
    if (rewrite.publisherNames.length === 0) report.notes.push("the installed build has no publisherName, so electron-updater only checks sha512 (unsigned build)");
    cacheDir = productionIdentity(rewrite.cacheDirName ?? "@cw-codedesktop-updater").cacheDir;

    feed = await startFeedServer({ root: options.candidateDir, port: options.feedPort });
    const env = { ...process.env, PATH: safePathWithoutClis() };
    for (const name of ["CW_CODE_HOME", "CW_PACKAGE_PROBE_OUT", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[name];
    const app = spawn(exe, [`--remote-debugging-port=${options.devToolsPort}`], { env, stdio: "ignore" });
    if (app.pid) knownPids.add(app.pid);

    const driven = await evaluateInPage(await devToolsPage(options.devToolsPort), RENDERER_DRIVER, DRIVE_TIMEOUT_MS);
    report.steps = driven.steps ?? [];
    if (driven.error) report.problems.push(driven.error);
    const check = report.steps.find((step) => step.step === "check");
    if (check?.availableVersion !== candidate.version) report.problems.push(`N was offered ${check?.availableVersion ?? "nothing"}, expected ${candidate.version}`);
    if (!report.steps.some((step) => step.step === "install-requested")) report.problems.push("the install was never requested");

    const relaunchedPid = await waitFor(() => {
      if (app.pid && isProcessAlive(app.pid)) return null;
      if (readRegistryValue(perUser.uninstall, "DisplayVersion") !== candidate.version) return null;
      return mainProcessOf(exe);
    }, RELAUNCH_TIMEOUT_MS);
    report.displayVersionAfter = readRegistryValue(perUser.uninstall, "DisplayVersion");
    if (report.displayVersionAfter !== candidate.version) report.problems.push(`DisplayVersion is ${report.displayVersionAfter}, expected ${candidate.version}`);
    if (relaunchedPid === null) report.problems.push("the installer did not relaunch cw-code");
    else {
      knownPids.add(relaunchedPid);
      spawnSync("taskkill", ["/PID", String(relaunchedPid), "/T"]);
      if (!(await waitFor(() => !isProcessAlive(relaunchedPid), CLOSE_TIMEOUT_MS))) report.notes.push("the relaunched app did not close on WM_CLOSE and was stopped by PID");
    }

    for (const pid of knownPids) killProcessTreeIfImage(pid, isInstalledExe);
    const { exitCode, probe } = await runPackageProbe(exe, { cwCodeHome: cwCodeHomeDir(), defaultUserData: true });
    report.probe = { exitCode, appVersion: probe.appVersion, rendererLoaded: probe.rendererLoaded, rendererFailures: probe.rendererFailures ?? [], nodePtySpawned: probe.nodePty.spawned, startupMode: probe.startupMode ?? null };
    if (exitCode !== 0) report.problems.push(`post-update probe exited with code ${exitCode}`);
    if (probe.appVersion !== candidate.version) report.problems.push(`post-update probe reports ${probe.appVersion}, expected ${candidate.version}`);
    if (!probe.rendererLoaded) report.problems.push(`post-update probe: renderer failed to load (${report.probe.rendererFailures.join("; ") || "no failure recorded"})`);
    const ptyProblem = nodePtyProblem("post-update probe", probe.nodePty);
    if (ptyProblem) report.problems.push(ptyProblem);
    const startupProblem = startupModeProblem("post-update probe", probe);
    if (startupProblem) report.problems.push(startupProblem);

    report.signature = authenticode(exe);
    if (rewrite.publisherNames.length > 0) {
      if (report.signature.status !== "Valid") report.problems.push(`installed executable signature is ${report.signature.status}`);
      else if (!rewrite.publisherNames.some((name) => String(report.signature.subject).includes(name))) {
        report.problems.push(`installed executable is signed by ${report.signature.subject}, not by ${rewrite.publisherNames.join(", ")}`);
      }
    }

    await feed.idle();
    report.transfers = summarizeTransfers(feed.requests());
    assertDataPreservedSemantically(seed, "after the update", report.problems);
  } catch (err) {
    report.problems.push(`production-bytes run aborted: ${err.message}`);
  } finally {
    try {
      if (feed) await feed.close();
    } catch (err) {
      report.problems.push(`feed server did not close: ${err.message}`);
    }
    for (const pid of knownPids) killProcessTreeIfImage(pid, isInstalledExe);
    const cleanup = cleanupInstallation({
      registryKeys: perUser,
      registryGuid: guid,
      uninstallerName: PRODUCTION_UNINSTALLER,
      executableName: PRODUCTION_EXECUTABLE,
      candidateDirs: [location, defaultInstallDir(PRODUCTION_PRODUCT_NAME, false)],
      removableDirs: [defaultInstallDir(PRODUCTION_PRODUCT_NAME, false)]
    });
    report.problems.push(...cleanup.errors.map((message) => `cleanup: ${message}`));
    report.notes.push(...cleanup.warnings.map((message) => `cleanup: ${message}`));
    try {
      if (cacheDir && /-updater$/.test(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
    } catch (err) {
      report.problems.push(`cleanup: could not remove updater cache ${cacheDir}: ${err.message}`);
    }
    cleanupSeededFixtures(seed);
  }
  return report;
}
