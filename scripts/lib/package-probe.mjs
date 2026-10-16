import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const PROBE_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_BYTES = 8 * 1024;
const PROCESS_GROUP_EXIT_GRACE_MS = 5_000;

export function requireDisposableEnvironment(modeName, disposableEnvironment, platformName = "Windows") {
  if (disposableEnvironment) return;
  throw new Error(
    `${modeName} installs and uninstalls the packaged app; refusing to run without --disposable-environment. ` +
      `Pass it only in a disposable ${platformName} environment such as a CI runner.`
  );
}

export function nodePtyProblem(label, nodePty) {
  if (nodePty.spawned && nodePty.exitCode === 0 && !nodePty.error) return null;
  return `${label}: node-pty probe failed (spawned=${nodePty.spawned}, exitCode=${nodePty.exitCode}, error=${nodePty.error ?? "none"})`;
}

export function startupModeProblem(label, probe) {
  if (probe.startupMode === undefined || probe.startupMode === "ready") return null;
  return `${label}: app started in '${probe.startupMode}' mode instead of 'ready'`;
}

export function safePathWithoutClis() {
  if (process.platform !== "win32") return ["/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":");
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return [
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0")
  ].join(";");
}

function signalQuietly(target, signal) {
  try {
    process.kill(target, signal);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function killProcessTree(pid) {
  if (process.platform !== "win32") {
    if (!signalQuietly(-pid, "SIGKILL")) signalQuietly(pid, "SIGKILL");
    return;
  }
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

async function reapProcessGroup(pgid) {
  signalQuietly(-pgid, "SIGKILL");
  const deadline = Date.now() + PROCESS_GROUP_EXIT_GRACE_MS;
  while (signalQuietly(-pgid, 0)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

function collectOutputTail(child) {
  let tail = "";
  const append = (chunk) => {
    tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => tail.trim();
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
    const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    const [command, ...launcherArgs] = [...(opts.launcher ?? []), exePath];
    let outputTail = () => "";
    const withOutput = (message) => {
      const output = outputTail();
      return output === "" ? message : `${message}\napp output (tail):\n${output}`;
    };

    const ownProcessGroup = process.platform !== "win32";
    let processGroupId = null;
    let processGroupExited;
    const result = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, [...launcherArgs, ...appArgs], { env, detached: ownProcessGroup });
      if (ownProcessGroup) processGroupId = child.pid ?? null;
      if (opts.captureOutput) outputTail = collectOutputTail(child);
      opts.onSpawn?.(child);
      const timer = setTimeout(() => {
        if (child.pid) killProcessTree(child.pid);
        rejectPromise(new Error(withOutput(`packaged app did not exit within ${timeoutMs}ms`)));
      }, timeoutMs);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolvePromise({ exitCode });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
    }).finally(async () => {
      if (processGroupId !== null) processGroupExited = await reapProcessGroup(processGroupId);
    });

    if (!existsSync(probeOutPath)) {
      throw new Error(withOutput(`packaged app exited (code ${result.exitCode}) without writing a probe result to ${probeOutPath}`));
    }
    const probe = JSON.parse(readFileSync(probeOutPath, "utf8"));
    return { exitCode: result.exitCode, probe, processGroupExited };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
