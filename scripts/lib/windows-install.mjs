import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ELECTRON_BUILDER_NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
export const PROBE_TIMEOUT_MS = 30_000;
export const UNINSTALL_POLL_TIMEOUT_MS = 30_000;
const UNINSTALL_POLL_INTERVAL_MS = 500;
const PROCESS_EXIT_GRACE_MS = 15_000;

export function nsisGuid(appId) {
  const hash = createHash("sha1")
    .update(Buffer.from(ELECTRON_BUILDER_NS_UUID.replaceAll("-", ""), "hex"))
    .update(Buffer.from(appId, "utf8"))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function requireDisposableEnvironment(modeName, disposableEnvironment) {
  if (process.env.CI === "true" || disposableEnvironment) return;
  throw new Error(
    `${modeName} installs and uninstalls the packaged app; refusing to run outside CI. ` +
      "Set CI=true or pass --disposable-environment only in a disposable Windows environment."
  );
}

export function safePathWithoutClis() {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return [
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0")
  ].join(";");
}

export function killProcessTree(pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

export function processImagePath(pid) {
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").ExecutablePath`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const path = result.stdout.trim();
  return path === "" ? null : path;
}

export function killProcessTreeIfImage(pid, isExpectedImage) {
  if (!Number.isInteger(pid) || !isProcessAlive(pid)) return { pid, killed: false, image: null };
  const image = processImagePath(pid);
  if (image === null || !isExpectedImage(image)) return { pid, killed: false, image };
  killProcessTree(pid);
  return { pid, killed: true, image };
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function isElevated() {
  return spawnSync("net", ["session"], { encoding: "utf8" }).status === 0;
}

export function runSilent(command, args) {
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

export function installDiagnostics(registryKeys) {
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

export function runSilentWithRetry(command, args, registryKeys) {
  try {
    return { result: runSilent(command, args), retried: false };
  } catch (firstError) {
    console.warn(`${firstError.message}\n${installDiagnostics(registryKeys)}\nretrying once in 10s`);
    spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 10"]);
    try {
      return { result: runSilent(command, args), retried: true };
    } catch (secondError) {
      throw new Error(`${secondError.message}\n${installDiagnostics(registryKeys)}`);
    }
  }
}

export function registryPaths(guid, perMachine) {
  const hive = perMachine ? "HKLM" : "HKCU";
  return {
    install: `${hive}\\Software\\${guid}`,
    uninstall: `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`
  };
}

export function readRegistryValue(keyPath, name) {
  const result = spawnSync("reg", ["query", keyPath, "/v", name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.match(new RegExp(`${name}\\s+REG_SZ\\s+(.+)`));
  return match ? match[1].trim() : null;
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function waitForRegistryValueGone(keyPath, name, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readRegistryValue(keyPath, name) === null) return;
    sleepSync(UNINSTALL_POLL_INTERVAL_MS);
  }
  throw new Error(`registry value '${name}' at ${keyPath} did not clear within ${timeoutMs}ms after uninstall`);
}

export function defaultInstallDir(productName, perMachine) {
  if (perMachine) return join(process.env["ProgramFiles"] ?? "C:\\Program Files", productName);
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", productName);
}

function dirKey(dir) {
  return resolve(dir).toLowerCase();
}

export function detectInstallDirs({ registryLocation, candidateDirs = [], ownedDirs = [], uninstallerName, executableName }) {
  const detected = new Map();
  const add = (dir) => {
    if (dir && !detected.has(dirKey(dir))) detected.set(dirKey(dir), dir);
  };
  const hasInstallEvidence = (dir) => existsSync(join(dir, uninstallerName)) || existsSync(join(dir, executableName));
  for (const dir of [registryLocation, ...candidateDirs]) {
    if (dir && hasInstallEvidence(dir) && isSafeRemovalTarget(dir)) add(dir);
  }
  for (const dir of ownedDirs) if (isSafeRemovalTarget(dir)) add(dir);
  return [...detected.values()];
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

export function isSafeRemovalTarget(dir) {
  if (typeof dir !== "string" || dir.trim() === "" || !isAbsolute(dir)) return false;
  const absolute = resolve(dir);
  if (parse(absolute).root === absolute) return false;
  return !protectedDirs().some((guarded) => dirKey(guarded) === dirKey(absolute) || isInsideDir(guarded, absolute));
}

function acceptedDirs(dirs, guardPath, errors) {
  if (!guardPath) return dirs;
  return dirs.filter((dir) => {
    try {
      guardPath(dir);
      return true;
    } catch (err) {
      errors.push(err.message);
      return false;
    }
  });
}

function passesGuard(guardPath, path) {
  if (!guardPath) return true;
  try {
    guardPath(path);
    return true;
  } catch {
    return false;
  }
}

export function isInsideDir(path, dir) {
  const root = dirKey(dir);
  return dirKey(path).startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function processesInsideDirs(processes, dirs, excludedPid = process.pid) {
  return processes.filter(
    (entry) =>
      Number.isInteger(entry?.ProcessId) &&
      entry.ProcessId !== excludedPid &&
      typeof entry.ExecutablePath === "string" &&
      entry.ExecutablePath !== "" &&
      dirs.some((dir) => isInsideDir(entry.ExecutablePath, dir))
  );
}

export function survivingProcesses(requested, current) {
  return requested.filter((entry) =>
    current.some((candidate) => candidate.ProcessId === entry.ProcessId && dirKey(candidate.ExecutablePath) === dirKey(entry.ExecutablePath))
  );
}

export function parseProcessList(text) {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function listWindowsProcesses() {
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

export function stopProcessesInsideDirs(dirs) {
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
    return stopped.length > 0 ? [`stopped processes running from the install directory ${stage}: ${describeStoppedProcesses(stopped)}`] : [];
  } catch (err) {
    return [`could not stop processes running from the install directory ${stage}: ${err.message}`];
  }
}

export function removalFailureOutcome(failure, appFilesLeft) {
  return appFilesLeft ? { error: failure } : { warning: `${failure} (no app files left in it, continuing)` };
}

export function staleRegistryKeys({ registryKeys, guid, installLocation, uninstallerPresent }) {
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

function settleInstallRegistry({ registryKeys, registryGuid, uninstallerName, guardPath, waitForUninstaller }) {
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
  const uninstallerPresent = existsSync(join(location, uninstallerName));
  const missingUninstaller = `registry InstallLocation points to ${location} but ${uninstallerName} is missing there`;
  const keys = passesGuard(guardPath, location) ? staleRegistryKeys({ registryKeys, guid: registryGuid, installLocation: location, uninstallerPresent }) : [];
  if (keys.length === 0) return { error: uninstallerPresent ? (waitError ?? `registry InstallLocation still points to ${location}`) : missingUninstaller };
  const failures = deleteRegistryKeys(keys);
  if (failures.length > 0) return { error: `${missingUninstaller}; could not delete its registry keys: ${failures.join("; ")}` };
  const remaining = readRegistryValue(registryKeys.install, "InstallLocation");
  if (remaining !== null) return { error: `${missingUninstaller}; InstallLocation still reads ${remaining} after deleting ${keys.join(", ")}` };
  return { warning: `${missingUninstaller}; deleted the stale registry keys ${keys.join(", ")}` };
}

export function cleanupInstallation({
  registryKeys,
  registryGuid = null,
  uninstallerName,
  executableName,
  candidateDirs = [],
  ownedDirs = [],
  guardPath = null
}) {
  const errors = [];
  const warnings = [];
  const uninstalledDirs = [];
  const registryLocation = readRegistryValue(registryKeys.install, "InstallLocation");
  const detected = detectInstallDirs({ registryLocation, candidateDirs, ownedDirs, uninstallerName, executableName });
  const dirs = acceptedDirs(detected, guardPath, errors);
  warnings.push(...stopInstallProcesses(dirs, "before uninstalling"));
  for (const dir of dirs) {
    const uninstallerPath = join(dir, uninstallerName);
    if (!existsSync(uninstallerPath)) continue;
    try {
      runSilent(uninstallerPath, ["/S", `_?=${dir}`]);
      uninstalledDirs.push(dir);
    } catch (err) {
      errors.push(`uninstall of ${dir} failed: ${err.message}`);
    }
  }
  warnings.push(...stopInstallProcesses(dirs, "before removing it"));
  for (const dir of dirs) {
    let failure = null;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      if (existsSync(dir)) failure = `install directory still present after removal: ${dir}`;
    } catch (err) {
      failure = `could not remove install directory ${dir}: ${err.message}`;
    }
    if (!failure) continue;
    const outcome = removalFailureOutcome(failure, existsSync(join(dir, executableName)) || existsSync(join(dir, uninstallerName)));
    if (outcome.error) errors.push(outcome.error);
    else warnings.push(outcome.warning);
  }
  const registryAccepted = registryLocation !== null && dirs.includes(registryLocation);
  if (registryAccepted || uninstalledDirs.length > 0) {
    const outcome = settleInstallRegistry({ registryKeys, registryGuid, uninstallerName, guardPath, waitForUninstaller: uninstalledDirs.length > 0 });
    if (outcome.error) errors.push(outcome.error);
    if (outcome.warning) warnings.push(outcome.warning);
  }
  return { registryLocation, dirs, uninstalledDirs, errors, warnings };
}

export function withCleanupErrors(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) return primaryError;
  const details = cleanupErrors.map((message) => `  - ${message}`).join("\n");
  return new Error(`${primaryError.message}\ncleanup after this failure also failed:\n${details}`, { cause: primaryError });
}

export async function runPackageProbe(exePath, opts = {}) {
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

export function startupModeProblem(label, probe) {
  if (probe.startupMode === undefined || probe.startupMode === "ready") return null;
  return `${label}: app started in '${probe.startupMode}' mode instead of 'ready'`;
}

export async function resolveAsarLib(desktopDir) {
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
