import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { validateLinuxReleaseFeed } from "../../tools/release/src/feedManifest.ts";
import { startFeedServer, summarizeTransfers } from "../../tools/release/src/feedServer.ts";
import { sha512Base64 } from "../../tools/release/src/rehash.ts";
import {
  DEB_INSTALL_DIR,
  DEB_LAUNCHER,
  DEB_PACKAGE_NAME,
  commandExists,
  debianVersion,
  ensureExecutable,
  fuseAvailability,
  installedDebVersion,
  runSudo
} from "./linux-install.mjs";
import { nodePtyProblem, requireDisposableEnvironment, runPackageProbe, safePathWithoutClis, startupModeProblem } from "./package-probe.mjs";
import { assertDataPreservedSemantically, cleanupSeededFixtures, createSeedPlan, cwCodeHomeDir, seedRealUserData } from "./real-user-data.mjs";
import { RENDERER_DRIVER, RENDERER_UPDATE_STATE, devToolsPage, evaluateInPage, rewriteAppUpdateForLoopback, waitFor } from "./renderer-driver.mjs";
import { resolveAsarLib } from "./windows-install.mjs";

export const LINUX_SCENARIOS = ["appimage", "deb"];
const APP_BINARY = "cw-code-bin";
const APPIMAGE_TOOLSET = "1.0.3";
const DEFAULT_CACHE_DIR_NAME = "@cw-codedesktop-updater";
const SQUASHFS_COMPRESSORS = { 1: "gzip", 2: "lzma", 3: "lzo", 4: "xz", 5: "lz4", 6: "zstd" };
const XVFB_TIMEOUT_MS = 30_000;
const DRIVE_TIMEOUT_MS = 15 * 60_000;
const EXIT_TIMEOUT_MS = 2 * 60_000;
const RELAUNCH_TIMEOUT_MS = 3 * 60_000;
const STARTUP_TIMEOUT_MS = 90_000;
const RELAUNCH_DEVTOOLS_TIMEOUT_MS = 60_000;
const RELAUNCH_SETTLE_MS = 5_000;
const STATE_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 90_000;
const UPDATER_LOG_LINES = 200;
const STRIPPED_ENV = ["CW_CODE_HOME", "CW_PACKAGE_PROBE_OUT", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "GH_TOKEN", "GITHUB_TOKEN", "APPIMAGE", "APPDIR", "APPIMAGE_EXTRACT_AND_RUN", "WAYLAND_DISPLAY"];
const PRIVILEGE_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/invocations.log"
if [ "$1" = "--message" ]; then shift 2; fi
exec sudo -n /bin/sh -c "$1"
`;

function requireLinuxHost() {
  if (process.platform !== "linux") throw new Error(`verify-linux-upgrade runs on Linux only (this is ${process.platform})`);
  if (process.getuid() === 0) throw new Error("verify-linux-upgrade must run as a non-root user with passwordless sudo: Chromium refuses to start as root with the sandbox enabled");
  const missing = ["Xvfb", "sudo", "dpkg-query", "dpkg-deb", "apt-get"].filter((command) => !commandExists(command));
  if (missing.length > 0) throw new Error(`missing required commands: ${missing.join(", ")} (install xvfb)`);
  if (spawnSync("sudo", ["-n", "true"]).status !== 0) throw new Error("sudo needs a password here; the deb scenario needs passwordless sudo");
}

async function startXvfb() {
  const child = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  const display = await new Promise((resolvePromise, rejectPromise) => {
    let text = "";
    const timer = setTimeout(() => rejectPromise(new Error(`Xvfb did not report a display within ${XVFB_TIMEOUT_MS / 1000}s`)), XVFB_TIMEOUT_MS);
    child.stdio[3].on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (!text.includes("\n")) return;
      clearTimeout(timer);
      resolvePromise(`:${text.trim()}`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Xvfb exited with code ${code}`));
    });
  });
  return { display, stop: () => child.kill("SIGTERM") };
}

function isAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    return;
  }
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    signal(pid, "SIGKILL");
  }
}

async function stopProcess(pid) {
  signal(pid, "SIGTERM");
  if (await waitFor(() => !isAlive(pid), CLOSE_TIMEOUT_MS)) return true;
  signal(pid, "SIGKILL");
  return false;
}

function readEnviron(pid) {
  try {
    const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => entry.includes("="));
    return Object.fromEntries(entries.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  } catch {
    return {};
  }
}

function appMainProcesses() {
  const uid = process.getuid();
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (statSync(`/proc/${entry}`).uid !== uid) continue;
      const exe = readlinkSync(`/proc/${entry}/exe`);
      if (basename(exe.replace(/ \(deleted\)$/, "")) !== APP_BINARY) continue;
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (args.some((arg) => arg.startsWith("--type="))) continue;
      found.push({ pid: Number(entry), exe, args, appImage: readEnviron(entry).APPIMAGE ?? null });
    } catch {
      continue;
    }
  }
  return found;
}

function readAt(path, position, length) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, position);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function appImagePayloadOffset(elfHeader) {
  if (elfHeader.readUInt32BE(0) !== 0x7f454c46 || elfHeader[4] !== 2 || elfHeader[5] !== 1) throw new Error("the AppImage runtime is not a 64-bit little-endian ELF");
  return Number(elfHeader.readBigUInt64LE(0x28)) + elfHeader.readUInt16LE(0x3a) * elfHeader.readUInt16LE(0x3c);
}

function squashfsLayout(superblock) {
  if (superblock.toString("latin1", 0, 4) !== "hsqs") throw new Error("no squashfs payload after the AppImage runtime");
  const compression = SQUASHFS_COMPRESSORS[superblock.readUInt16LE(20)];
  if (!compression) throw new Error(`unknown squashfs compression id ${superblock.readUInt16LE(20)}`);
  return { compression, blockSize: superblock.readUInt32LE(12) };
}

function builderLib(desktopDir) {
  const fromDesktop = createRequire(join(desktopDir, "package.json"));
  const fromBuilder = createRequire(fromDesktop.resolve("electron-builder/package.json"));
  const libPackageJson = fromBuilder.resolve("app-builder-lib/package.json");
  const fromLib = createRequire(libPackageJson);
  const libDir = dirname(libPackageJson);
  return {
    version: JSON.parse(readFileSync(libPackageJson, "utf8")).version,
    getAppImageTools: fromLib(join(libDir, "out", "toolsets", "linux.js")).getAppImageTools,
    buildBlockMap: fromLib(join(libDir, "out", "targets", "blockmap", "blockmap.js")).buildBlockMap,
    x64: fromLib("builder-util").Arch.x64
  };
}

async function asarVersion(asar, asarPath) {
  try {
    return JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8")).version ?? null;
  } catch {
    return null;
  }
}

async function repackAppImage({ source, target, scratchDir, feedUrl, desktopDir, asar }) {
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });
  const env = { ...process.env };
  delete env.APPIMAGE_EXTRACT_AND_RUN;
  execFileSync(source, ["--appimage-extract"], { cwd: scratchDir, env, stdio: "ignore" });
  const root = join(scratchDir, "squashfs-root");
  const appUpdatePath = join(root, "resources", "app-update.yml");
  if (!existsSync(appUpdatePath)) throw new Error("the base AppImage has no resources/app-update.yml");
  const rewrite = rewriteAppUpdateForLoopback(readFileSync(appUpdatePath, "utf8"), feedUrl);
  writeFileSync(appUpdatePath, rewrite.text, "utf8");
  const version = await asarVersion(asar, join(root, "resources", "app.asar"));

  const offset = appImagePayloadOffset(readAt(source, 0, 64));
  const layout = squashfsLayout(readAt(source, offset, 96));
  const runtime = readAt(source, 0, offset);
  const lib = builderLib(desktopDir);
  const tools = await lib.getAppImageTools(APPIMAGE_TOOLSET, lib.x64);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  execFileSync(
    tools.mksquashfs,
    [root, target, "-offset", String(offset), "-all-root", "-noappend", "-no-progress", "-quiet", "-no-xattrs", "-no-fragments", "-comp", layout.compression, "-b", String(layout.blockSize)],
    { stdio: "ignore" }
  );
  const fd = openSync(target, "r+");
  try {
    writeSync(fd, runtime, 0, runtime.length, 0);
  } finally {
    closeSync(fd);
  }
  const embedded = await lib.buildBlockMap(target, "deflate");
  chmodSync(target, 0o755);
  rmSync(scratchDir, { recursive: true, force: true });
  return {
    version,
    rewrite,
    repack: { runtimeBytes: offset, ...layout, embeddedBlockMapBytes: embedded.blockMapSize ?? null, appImageToolset: APPIMAGE_TOOLSET, appBuilderLib: lib.version },
    sha512: await sha512Base64(target),
    sizeBytes: statSync(target).size
  };
}

function appEnv(display, extra = {}) {
  const env = { ...process.env, PATH: safePathWithoutClis(), DISPLAY: display, APPIMAGE_SILENT_INSTALL: "1", ...extra };
  for (const name of STRIPPED_ENV) if (!(name in extra)) delete env[name];
  return env;
}

function updaterCacheDir(cacheDirName) {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), cacheDirName ?? DEFAULT_CACHE_DIR_NAME);
}

function removeUpdaterCache(dir, record) {
  if (!/-updater$/.test(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    record.problems.push(`cleanup: could not remove updater cache ${dir}: ${err.message}`);
  }
}

function updaterLogSince(startedAt) {
  const path = join(cwCodeHomeDir(), "logs", "updater.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.slice(0, 24) >= startedAt)
    .slice(-UPDATER_LOG_LINES);
}

function transferSummary(feed, candidateFile) {
  const transfers = summarizeTransfers(feed.requests());
  const served = transfers.filter((entry) => entry.path === candidateFile.name).reduce((total, entry) => total + entry.bytes, 0);
  return {
    transfers,
    packageBytes: candidateFile.size,
    bytesServed: served,
    ratio: Number((served / candidateFile.size).toFixed(4)),
    differential: transfers.some((entry) => entry.path === candidateFile.name && entry.rangeRequests > 0)
  };
}

async function readRendererState(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = await devToolsPage(port, Math.max(deadline - Date.now(), 1_000));
    try {
      return { page, state: await evaluateInPage(page, RENDERER_UPDATE_STATE, STATE_TIMEOUT_MS) };
    } catch (err) {
      if (!/Execution context was destroyed|Cannot find context|bridge is not available/.test(err.message) || Date.now() >= deadline) throw err;
      await sleep(1_000);
    }
  }
}

async function runUpdateCycle(ctx, record, { command, env, isRelaunched }) {
  const output = openSync(join(ctx.logsDir, `${record.id}-n.log`), "a");
  const n = spawn(command, [`--remote-debugging-port=${ctx.devToolsPort}`], { env, detached: true, stdio: ["ignore", output, output] });
  closeSync(output);
  const state = { exited: false, exitCode: null };
  n.on("exit", (code) => Object.assign(state, { exited: true, exitCode: code }));
  n.on("error", (err) => Object.assign(state, { exited: true, error: err.message }));
  const owned = new Set(n.pid ? [n.pid] : []);
  let relaunched = null;
  try {
    const startup = await readRendererState(ctx.devToolsPort, STARTUP_TIMEOUT_MS);
    const page = startup.page;
    record.before = startup.state;
    if (record.before.runningVersion === ctx.candidate.version) throw new Error(`N already runs ${ctx.candidate.version}`);
    if (record.before.phase === "disabled") throw new Error(`updates are disabled in N: ${record.before.disabledReason}`);
    const before = new Set(appMainProcesses().map((entry) => entry.pid));
    for (const pid of before) owned.add(pid);

    const driven = await evaluateInPage(page, RENDERER_DRIVER, DRIVE_TIMEOUT_MS);
    record.steps = driven.steps ?? [];
    if (driven.error) record.problems.push(driven.error);
    const check = record.steps.find((step) => step.step === "check");
    if (check?.availableVersion !== ctx.candidate.version) record.problems.push(`N was offered ${check?.availableVersion ?? "nothing"}, expected ${ctx.candidate.version}`);
    if (!record.steps.some((step) => step.step === "install-requested")) record.problems.push("the install was never requested");

    const exitedAt = Date.now();
    if (!(await waitFor(() => state.exited && [...before].every((pid) => !isAlive(pid)), EXIT_TIMEOUT_MS))) record.problems.push("N did not exit after Update and restart");
    record.timings.nExitMs = Date.now() - exitedAt;
    relaunched = await waitFor(() => appMainProcesses().find((entry) => !before.has(entry.pid) && isRelaunched(entry)), RELAUNCH_TIMEOUT_MS);
    if (!relaunched) {
      record.problems.push("the updater did not relaunch cw-code");
      return;
    }
    owned.add(relaunched.pid);
    record.timings.installToRelaunchMs = Date.now() - exitedAt;
    const exe = relaunched.exe.replace(/ \(deleted\)$/, "");
    record.relaunched = {
      pid: relaunched.pid,
      exe: relaunched.exe,
      appImage: relaunched.appImage,
      noSandboxFlag: relaunched.args.includes("--no-sandbox"),
      runningVersion: relaunched.exe.endsWith(" (deleted)") ? null : await asarVersion(ctx.asar, join(dirname(exe), "resources", "app.asar")),
      reported: null
    };
    if (relaunched.args.includes(`--remote-debugging-port=${ctx.devToolsPort}`)) {
      try {
        record.relaunched.reported = (await readRendererState(ctx.devToolsPort, RELAUNCH_DEVTOOLS_TIMEOUT_MS)).state;
      } catch (err) {
        record.problems.push(`the relaunched app did not answer over DevTools: ${err.message}`);
      }
    }
    if (record.relaunched.runningVersion !== ctx.candidate.version) {
      record.problems.push(`the relaunched process runs ${record.relaunched.runningVersion ?? "an unreadable or deleted build"}, expected ${ctx.candidate.version}`);
    }
    if (record.relaunched.reported && record.relaunched.reported.runningVersion !== ctx.candidate.version) {
      record.problems.push(`the relaunched app reports ${record.relaunched.reported.runningVersion}, expected ${ctx.candidate.version}`);
    }
    await sleep(RELAUNCH_SETTLE_MS);
    if (!isAlive(relaunched.pid)) {
      record.problems.push(`the relaunched app exited by itself within ${RELAUNCH_SETTLE_MS / 1000}s of starting`);
      return;
    }
    if (!(await stopProcess(relaunched.pid))) record.notes.push("the relaunched app did not quit on SIGTERM and was killed");
  } finally {
    for (const pid of owned) if (isAlive(pid)) killGroup(pid);
    if (relaunched && isAlive(relaunched.pid)) killGroup(relaunched.pid);
  }
}

async function probeInstalled(launchPath, env, label, expectedVersion, record) {
  try {
    const { exitCode, probe } = await runPackageProbe(launchPath, { env, cwCodeHome: cwCodeHomeDir(), defaultUserData: true, timeoutMs: PROBE_TIMEOUT_MS, captureOutput: true });
    record.probe = {
      exitCode,
      platform: probe.platform,
      appVersion: probe.appVersion,
      startupMode: probe.startupMode ?? null,
      rendererLoaded: probe.rendererLoaded,
      rendererFailures: probe.rendererFailures ?? [],
      nodePtySpawned: probe.nodePty?.spawned ?? null,
      sandbox: probe.sandbox ?? null
    };
    if (exitCode !== 0) record.problems.push(`${label}: app exited with code ${exitCode}`);
    if (probe.appVersion !== expectedVersion) record.problems.push(`${label}: probe reports ${probe.appVersion}, expected ${expectedVersion}`);
    if (!probe.rendererLoaded) record.problems.push(`${label}: renderer failed to load (${record.probe.rendererFailures.join("; ") || "no failure recorded"})`);
    const ptyProblem = nodePtyProblem(label, probe.nodePty);
    if (ptyProblem) record.problems.push(ptyProblem);
    const startupProblem = startupModeProblem(label, probe);
    if (startupProblem) record.problems.push(startupProblem);
  } catch (err) {
    record.problems.push(`${label} failed: ${err.message}`);
  }
}

function newRecord(id) {
  return { id, startedAt: new Date().toISOString(), problems: [], notes: [], steps: [], timings: {}, before: null, relaunched: null, probe: null };
}

async function appImageScenario(ctx) {
  const record = newRecord("appimage");
  const dir = join(ctx.workDir, "appimage");
  const seed = createSeedPlan();
  let feed = null;
  let cacheDir = updaterCacheDir(null);
  try {
    rmSync(dir, { recursive: true, force: true });
    const installDir = join(dir, "Applications");
    mkdirSync(installDir, { recursive: true });
    record.madeExecutable = ensureExecutable(ctx.appImage);
    const installed = join(realpathSync(installDir), basename(ctx.appImage));
    const destination = /\d+\.\d+\.\d+/.test(basename(installed)) ? join(dirname(installed), ctx.candidate.appImage.name) : installed;
    const base = await repackAppImage({ source: ctx.appImage, target: installed, scratchDir: join(dir, "extract"), feedUrl: ctx.feedUrl, desktopDir: ctx.desktopDir, asar: ctx.asar });
    cacheDir = updaterCacheDir(base.rewrite.cacheDirName);
    record.base = { version: base.version, path: installed, sha512: base.sha512, sizeBytes: base.sizeBytes, repack: base.repack };
    record.appUpdate = { originalProvider: base.rewrite.originalProvider, feedUrl: ctx.feedUrl, updaterCacheDirName: base.rewrite.cacheDirName };
    const fuse = fuseAvailability();
    record.launch = { mode: fuse.available ? "fuse-mount" : "extract-and-run", reason: fuse.reason };
    const env = appEnv(ctx.display, fuse.available ? {} : { APPIMAGE_EXTRACT_AND_RUN: "1" });

    seedRealUserData(seed);
    feed = await startFeedServer({ root: ctx.candidateDir, port: ctx.feedPort });
    await runUpdateCycle(ctx, record, { command: installed, env, isRelaunched: (entry) => entry.appImage === destination });

    record.target = { path: destination, exists: existsSync(destination), sha512: null, matchesCandidate: false, basePathRemoved: destination === installed || !existsSync(installed) };
    if (!record.target.exists) record.problems.push(`no AppImage at ${destination} after the update`);
    else {
      record.target.sha512 = await sha512Base64(destination);
      record.target.matchesCandidate = record.target.sha512 === ctx.candidate.appImage.sha512;
      if (!record.target.matchesCandidate) record.problems.push(`${destination} does not have the candidate AppImage's bytes`);
    }
    if (!record.target.basePathRemoved) record.problems.push(`the base AppImage is still at ${installed} next to the update`);
    if (record.target.exists) await probeInstalled(destination, env, "post-update AppImage probe", ctx.candidate.version, record);
    await feed.idle();
    record.feed = transferSummary(feed, ctx.candidate.appImage);
    assertDataPreservedSemantically(seed, "after the AppImage update", record.problems);
  } catch (err) {
    record.problems.push(`AppImage scenario aborted: ${err.message}`);
  } finally {
    try {
      if (feed) await feed.close();
    } catch (err) {
      record.problems.push(`feed server did not close: ${err.message}`);
    }
    record.updaterLog = updaterLogSince(record.startedAt);
    removeUpdaterCache(cacheDir, record);
    cleanupSeededFixtures(seed);
    rmSync(dir, { recursive: true, force: true });
  }
  return record;
}

function debFieldVersion(debPath) {
  return execFileSync("dpkg-deb", ["-f", debPath, "Version"], { encoding: "utf8" }).trim();
}

async function debScenario(ctx) {
  const record = newRecord("deb");
  const dir = join(ctx.workDir, "deb");
  const seed = createSeedPlan();
  const appUpdatePath = join(DEB_INSTALL_DIR, "resources", "app-update.yml");
  let feed = null;
  let installedByUs = false;
  let cacheDir = updaterCacheDir(null);
  try {
    const preinstalled = installedDebVersion();
    if (preinstalled !== null) throw new Error(`${DEB_PACKAGE_NAME} ${preinstalled} is already installed; refusing to replace it`);
    rmSync(dir, { recursive: true, force: true });
    const shimDir = join(dir, "privilege-shim");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "gksudo"), PRIVILEGE_SHIM, { mode: 0o755 });

    seedRealUserData(seed);
    installedByUs = true;
    runSudo(["apt-get", "install", "-y", resolve(ctx.deb)]);
    record.base = { debianVersion: installedDebVersion(), packageVersion: debFieldVersion(ctx.deb) };
    if (record.base.debianVersion !== record.base.packageVersion) record.problems.push(`installed ${record.base.debianVersion}, but the base deb is ${record.base.packageVersion}`);

    const rewrite = rewriteAppUpdateForLoopback(readFileSync(appUpdatePath, "utf8"), ctx.feedUrl);
    const staged = join(dir, "app-update.yml");
    writeFileSync(staged, rewrite.text, "utf8");
    runSudo(["install", "-m", "0644", staged, appUpdatePath]);
    cacheDir = updaterCacheDir(rewrite.cacheDirName);
    record.appUpdate = { originalProvider: rewrite.originalProvider, feedUrl: ctx.feedUrl, updaterCacheDirName: rewrite.cacheDirName };

    const env = appEnv(ctx.display);
    env.PATH = `${shimDir}:${env.PATH}`;
    feed = await startFeedServer({ root: ctx.candidateDir, port: ctx.feedPort });
    const binary = join(DEB_INSTALL_DIR, APP_BINARY);
    await runUpdateCycle(ctx, record, { command: DEB_LAUNCHER, env, isRelaunched: (entry) => entry.exe === binary });

    const expected = debianVersion(ctx.candidate.version);
    record.installedAfter = installedDebVersion();
    if (record.installedAfter !== expected) record.problems.push(`dpkg reports ${DEB_PACKAGE_NAME} ${record.installedAfter ?? "not installed"}, expected ${expected}`);
    const shimLog = join(shimDir, "invocations.log");
    record.privilege = { wrapper: "gksudo shim -> sudo -n", invocations: existsSync(shimLog) ? readFileSync(shimLog, "utf8").trim().split("\n") : [] };
    if (!record.privilege.invocations.some((line) => line.includes("dpkg -i"))) record.problems.push("DebUpdater never ran dpkg -i through the privilege wrapper");
    await probeInstalled(DEB_LAUNCHER, appEnv(ctx.display), "post-update deb probe", ctx.candidate.version, record);
    await feed.idle();
    record.feed = transferSummary(feed, ctx.candidate.deb);
    assertDataPreservedSemantically(seed, "after the deb update", record.problems);
  } catch (err) {
    record.problems.push(`deb scenario aborted: ${err.message}`);
  } finally {
    try {
      if (feed) await feed.close();
    } catch (err) {
      record.problems.push(`feed server did not close: ${err.message}`);
    }
    record.updaterLog = updaterLogSince(record.startedAt);
    if (installedByUs) {
      try {
        runSudo(["apt-get", "purge", "-y", DEB_PACKAGE_NAME]);
        if (installedDebVersion() !== null) record.problems.push(`cleanup: ${DEB_PACKAGE_NAME} is still installed after apt-get purge`);
      } catch (err) {
        record.problems.push(`cleanup: ${err.message}`);
      }
    }
    removeUpdaterCache(cacheDir, record);
    cleanupSeededFixtures(seed);
    rmSync(dir, { recursive: true, force: true });
  }
  return record;
}

async function describeBase(path) {
  return path ? { name: basename(path), sizeBytes: statSync(path).size, sha512: await sha512Base64(path) } : null;
}

export async function runLinuxProductionBytes(options) {
  requireDisposableEnvironment("verify-linux-upgrade", options.disposableEnvironment, "Linux");
  requireLinuxHost();
  const scenarios = options.scenarios ?? LINUX_SCENARIOS;
  if (scenarios.includes("appimage") && !options.appImage) throw new Error("the appimage scenario needs --appimage <N AppImage>");
  if (scenarios.includes("deb") && !options.deb) throw new Error("the deb scenario needs --deb <N deb>");
  const candidate = await validateLinuxReleaseFeed(options.candidateDir);
  if (candidate.errors.length > 0) throw new Error(`candidate Linux feed is invalid: ${candidate.errors.join("; ")}`);
  const asar = await resolveAsarLib(options.desktopDir);
  if (!asar) throw new Error("@electron/asar is not resolvable from the desktop package; run bun install");

  const report = {
    schema: 1,
    mode: "linux-production-bytes",
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, node: process.version, ci: process.env.CI === "true", uid: process.getuid() },
    candidate: { version: candidate.version, channelFiles: candidate.channelFiles, appImage: candidate.appImage, deb: candidate.deb, debianVersion: debianVersion(candidate.version) },
    base: { appImage: await describeBase(options.appImage), deb: await describeBase(options.deb) },
    selected: scenarios,
    scenarios: [],
    problems: [],
    notes: [],
    passed: false,
    complete: false
  };
  options.onUpdate?.(report);
  const logsDir = join(options.workDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const xvfb = await startXvfb();
  report.display = xvfb.display;
  const ctx = {
    ...options,
    asar,
    candidate,
    logsDir,
    display: xvfb.display,
    feedUrl: `http://127.0.0.1:${options.feedPort}/`
  };
  try {
    for (const id of scenarios) {
      console.log(`== ${id}`);
      const record = id === "appimage" ? await appImageScenario(ctx) : await debScenario(ctx);
      console.log(record.problems.length === 0 ? "   passed" : `   FAILED\n${record.problems.map((problem) => `   - ${problem}`).join("\n")}`);
      report.scenarios.push(record);
      report.problems.push(...record.problems.map((problem) => `${id}: ${problem}`));
      options.onUpdate?.(report);
    }
  } finally {
    xvfb.stop();
  }
  report.passed = report.problems.length === 0;
  report.complete = true;
  return report;
}
