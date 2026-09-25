import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { validateReleaseFeed } from "../../tools/release/src/feedManifest.ts";
import { startFeedServer, summarizeTransfers } from "../../tools/release/src/feedServer.ts";
import { formatScalar, readPublisherNames } from "../../tools/release/src/updateInfoYaml.ts";
import { compareMetadata, projectMetadata } from "../../tools/release/src/upgradeScenarios.ts";
import { parseAppUpdateYaml } from "./upgrade-builds.mjs";
import { cleanupSeededFixtures, seedRealUserData } from "./real-user-data.mjs";
import {
  UNINSTALL_POLL_TIMEOUT_MS,
  isProcessAlive,
  killProcessTree,
  nsisGuid,
  readRegistryValue,
  registryPaths,
  requireDisposableEnvironment,
  runPackageProbe,
  runSilent,
  runUninstallSync,
  safePathWithoutClis,
  waitForRegistryValueGone
} from "./windows-install.mjs";

const PRODUCTION_APP_ID = "com.cwcode.app";
const PRODUCTION_EXECUTABLE = "cw-code.exe";
const PRODUCTION_UNINSTALLER = "Uninstall cw-code.exe";
const DEVTOOLS_TIMEOUT_MS = 90_000;
const DRIVE_TIMEOUT_MS = 15 * 60_000;
const RELAUNCH_TIMEOUT_MS = 6 * 60_000;
const CLOSE_TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;

const RENDERER_DRIVER = `(async () => {
  const steps = [];
  const cw = window.cw;
  if (!cw || !cw.updates || !cw.shutdown) return { steps, error: "window.cw bridge is not available" };
  const summary = (result) => ({ ok: result.ok, code: result.code ?? null, message: result.message ?? null, phase: result.state.phase, availableVersion: result.state.availableVersion, downloadedVersion: result.state.downloadedVersion, error: result.state.error });
  const check = await cw.updates.check();
  steps.push({ step: "check", ...summary(check) });
  if (check.state.phase !== "available" && check.state.phase !== "ready") return { steps };
  const download = await cw.updates.download();
  steps.push({ step: "download", ...summary(download) });
  const state = await cw.updates.getState();
  if (state.phase !== "ready" || !state.downloadedVersion) return { steps };
  const prepared = await cw.shutdown.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 15000 });
  steps.push({ step: "prepare", ok: prepared.ok, code: prepared.code ?? null });
  if (!prepared.ok) return { steps };
  void cw.updates.install({ version: state.downloadedVersion, channel: state.channel, token: prepared.token });
  steps.push({ step: "install-requested", version: state.downloadedVersion, channel: state.channel });
  return { steps };
})()`;

function productionIdentity(cacheDirName) {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return { cacheDir: join(localAppData, cacheDirName) };
}

export function rewriteAppUpdateForLoopback(original, feedUrl) {
  const parsed = parseAppUpdateYaml(original);
  const publisherNames = readPublisherNames(original);
  const lines = ["provider: generic", `url: ${feedUrl}`];
  if (parsed.updaterCacheDirName) lines.push(`updaterCacheDirName: ${formatScalar(parsed.updaterCacheDirName)}`);
  if (publisherNames.length > 0) lines.push("publisherName:", ...publisherNames.map((name) => `  - ${formatScalar(name)}`));
  return { text: `${lines.join("\n")}\n`, publisherNames, cacheDirName: parsed.updaterCacheDirName ?? null, originalProvider: parsed.provider ?? null };
}

async function devToolsPage(port) {
  const deadline = Date.now() + DEVTOOLS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && String(target.url).startsWith("file:"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      await sleep(POLL_MS);
      continue;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`the production app did not expose its renderer on DevTools port ${port} within ${DEVTOOLS_TIMEOUT_MS / 1000}s`);
}

function evaluateInPage(webSocketUrl, expression, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      rejectPromise(new Error(`renderer evaluation did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (payload.error || payload.result?.exceptionDetails) {
        rejectPromise(new Error(JSON.stringify(payload.error ?? payload.result.exceptionDetails).slice(0, 500)));
        return;
      }
      resolvePromise(payload.result.result.value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectPromise(new Error("could not talk to the renderer over DevTools"));
    });
  });
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

function startWizardDriver(driverPath, installerDir, logPath) {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driverPath, "-InstallerDir", installerDir, "-LogPath", logPath, "-TimeoutSeconds", "600"],
    { stdio: "ignore", windowsHide: true }
  );
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(POLL_MS);
  }
  return null;
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
  const seed = seedRealUserData();
  const before = projectMetadata(JSON.parse(seed.dbContent), JSON.parse(seed.settingsContent), ["claudeBinaryPath"]);
  const knownPids = new Set();
  let feed = null;
  let wizard = null;
  let location = null;
  let cacheDir = null;
  try {
    runSilent(options.installer, ["/S"]);
    location = readRegistryValue(perUser.install, "InstallLocation");
    if (!location) throw new Error(`InstallLocation is missing at ${perUser.install} after installing ${options.installer}`);
    report.installedVersion = readRegistryValue(perUser.uninstall, "DisplayVersion");
    const exe = join(location, PRODUCTION_EXECUTABLE);
    const appUpdatePath = join(location, "resources", "app-update.yml");
    if (!existsSync(appUpdatePath)) throw new Error("the installed production build has no resources/app-update.yml");
    const feedUrl = `http://127.0.0.1:${options.feedPort}/`;
    const rewrite = rewriteAppUpdateForLoopback(readFileSync(appUpdatePath, "utf8"), feedUrl);
    writeFileSync(appUpdatePath, rewrite.text, "utf8");
    report.appUpdate = { originalProvider: rewrite.originalProvider, publisherNames: rewrite.publisherNames, feedUrl };
    if (rewrite.publisherNames.length === 0) report.notes.push("the installed build has no publisherName, so electron-updater only checks sha512 (unsigned build)");
    cacheDir = productionIdentity(rewrite.cacheDirName ?? "@cw-codedesktop-updater").cacheDir;

    feed = await startFeedServer({ root: options.candidateDir, port: options.feedPort });
    wizard = startWizardDriver(options.wizardDriver, join(cacheDir, "pending"), join(options.workDir, "production-wizard.jsonl"));
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

    for (const pid of knownPids) if (isProcessAlive(pid)) killProcessTree(pid);
    const { probe } = await runPackageProbe(exe);
    report.probe = { appVersion: probe.appVersion, rendererLoaded: probe.rendererLoaded, nodePtySpawned: probe.nodePty.spawned };
    if (probe.appVersion !== candidate.version) report.problems.push(`post-update probe reports ${probe.appVersion}, expected ${candidate.version}`);
    if (!probe.rendererLoaded || !probe.nodePty.spawned) report.problems.push("post-update probe failed (renderer or node-pty)");

    report.signature = authenticode(exe);
    if (rewrite.publisherNames.length > 0) {
      if (report.signature.status !== "Valid") report.problems.push(`installed executable signature is ${report.signature.status}`);
      else if (!rewrite.publisherNames.some((name) => String(report.signature.subject).includes(name))) {
        report.problems.push(`installed executable is signed by ${report.signature.subject}, not by ${rewrite.publisherNames.join(", ")}`);
      }
    }

    await feed.idle();
    report.transfers = summarizeTransfers(feed.requests());
    const sessions = JSON.parse(readFileSync(seed.dbPath, "utf8"));
    const settings = JSON.parse(readFileSync(seed.settingsPath, "utf8"));
    report.problems.push(...compareMetadata(before, projectMetadata(sessions, settings, ["claudeBinaryPath"])));
    for (const [label, path] of [["worktree marker", seed.worktreeMarkerPath], ["Electron userData marker", seed.electronMarkerPath]]) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== seed.markerContent) report.problems.push(`${label} did not survive the update`);
    }
  } catch (err) {
    report.problems.push(`production-bytes run aborted: ${err.message}`);
  } finally {
    if (wizard?.pid && isProcessAlive(wizard.pid)) killProcessTree(wizard.pid);
    if (feed) await feed.close();
    for (const pid of knownPids) if (isProcessAlive(pid)) killProcessTree(pid);
    if (location) {
      const uninstaller = join(location, PRODUCTION_UNINSTALLER);
      if (existsSync(uninstaller)) {
        try {
          runUninstallSync(uninstaller, location);
          waitForRegistryValueGone(perUser.install, "InstallLocation", UNINSTALL_POLL_TIMEOUT_MS);
        } catch (err) {
          report.problems.push(`cleanup uninstall failed: ${err.message}`);
        }
      }
    }
    if (cacheDir && /-updater$/.test(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
    cleanupSeededFixtures(seed);
  }
  return report;
}
