import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ELECTRON_BUILDER_NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
export const PROBE_TIMEOUT_MS = 30_000;
export const UNINSTALL_POLL_TIMEOUT_MS = 30_000;
const UNINSTALL_POLL_INTERVAL_MS = 500;

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
  const result = spawnSync(command, args, { encoding: "utf8" });
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

export function runUninstallSync(uninstallerPath, installDir) {
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

export async function runPackageProbe(exePath, opts = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "cw-verify-probe-"));
  try {
    const cwCodeHome = opts.cwCodeHome ?? join(workDir, "cw-code-home");
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
