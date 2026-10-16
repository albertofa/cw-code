import { accessSync, chmodSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { nodePtyProblem, runPackageProbe, startupModeProblem } from "./package-probe.mjs";

export const DEB_INSTALL_DIR = "/opt/cw-code";
export const DEB_LAUNCHER = "/usr/bin/cw-code";
export const DEB_PACKAGE_NAME = "cw-code";
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/cw-code";
const EXECUTABLE_NAME = "cw-code";
const BINARY_NAME = `${EXECUTABLE_NAME}-bin`;
const LINUX_PROBE_TIMEOUT_MS = 90_000;
const SAMPLE_INTERVAL_MS = 50;
const APT_TIMEOUT_MS = 10 * 60_000;
const XVFB_ARGS = ["-a", "-s", "-screen 0 1280x1024x24"];

function readProcText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    return { error: err.code ?? err.message };
  }
}

function textOrNull(value) {
  return typeof value === "string" ? value.replace(/\0+$/, "").trim() : null;
}

export function parseProcCmdline(raw) {
  const trimmed = raw.endsWith("\0") ? raw.slice(0, -1) : raw;
  return trimmed === "" ? [] : trimmed.split("\0");
}

export function parseProcStatGroup(raw) {
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(fields[1]), pgrp: Number(fields[2]) };
}

export function isMainAppProcess(exeBasename, cmdline) {
  return exeBasename === BINARY_NAME && !cmdline.some((arg) => arg.startsWith("--type="));
}

function findMainAppProcess(pgid) {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcText(`/proc/${entry}/stat`);
    if (typeof stat !== "string" || parseProcStatGroup(stat).pgrp !== pgid) continue;
    let exe;
    try {
      exe = readlinkSync(`/proc/${entry}/exe`);
    } catch {
      continue;
    }
    const cmdline = readProcText(`/proc/${entry}/cmdline`);
    if (typeof cmdline !== "string") continue;
    const args = parseProcCmdline(cmdline);
    if (isMainAppProcess(basename(exe.replace(/ \(deleted\)$/, "")), args)) return { pid: Number(entry), exe, cmdline: args };
  }
  return null;
}

function fileOwnership(path) {
  try {
    const stat = statSync(path);
    return { path, uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o7777).toString(8).padStart(4, "0") };
  } catch (err) {
    return { path, error: err.code ?? err.message };
  }
}

export function readUsernsRestriction() {
  return textOrNull(readProcText("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"));
}

function captureSandboxEvidence(found) {
  const attrCurrent = readProcText(`/proc/${found.pid}/attr/current`);
  const attrApparmorCurrent = readProcText(`/proc/${found.pid}/attr/apparmor/current`);
  return {
    pid: found.pid,
    exe: found.exe,
    cmdline: found.cmdline,
    noSandboxFlag: found.cmdline.includes("--no-sandbox"),
    attrCurrent: textOrNull(attrCurrent),
    attrCurrentError: typeof attrCurrent === "string" ? null : attrCurrent.error,
    attrApparmorCurrent: textOrNull(attrApparmorCurrent),
    sandboxHelper: fileOwnership(join(dirname(found.exe.replace(/ \(deleted\)$/, "")), "chrome-sandbox")),
    apparmorRestrictUnprivilegedUserns: readUsernsRestriction()
  };
}

export function apparmorLabel(evidence) {
  return evidence.attrApparmorCurrent || evidence.attrCurrent || null;
}

export function unprivilegedUsernsUsable() {
  return spawnSync("unshare", ["-Ur", "true"], { stdio: "ignore" }).status === 0;
}

export function sandboxDecision(evidence, { appImage, usernsUsable }) {
  const label = apparmorLabel(evidence);
  const underAppProfile = label !== null && label.startsWith(`${EXECUTABLE_NAME} `);
  const setuidHelper = evidence.sandboxHelper.uid === 0 && evidence.sandboxHelper.mode === "4755";
  const usernsRestricted = evidence.apparmorRestrictUnprivilegedUserns === "1";
  const wrapperAddsNoSandbox = !underAppProfile && !setuidHelper && usernsRestricted;
  const appRunAddsNoSandbox = appImage && !usernsUsable;
  const expectNoSandbox = wrapperAddsNoSandbox || appRunAddsNoSandbox;
  const reasons = [
    ...(appRunAddsNoSandbox ? ["AppRun: 'unshare -Ur true' failed"] : []),
    ...(wrapperAddsNoSandbox ? ["wrapper: user namespaces restricted by AppArmor, no app profile, no setuid helper"] : [])
  ];
  const verdict = evidence.noSandboxFlag
    ? `disabled: --no-sandbox (${reasons.join("; ") || "no launcher rule explains it"})`
    : underAppProfile
      ? `enabled: user namespaces under the AppArmor profile '${label}'`
      : setuidHelper
        ? "enabled: setuid-root chrome-sandbox"
        : "enabled: unprivileged user namespaces";
  return {
    label,
    underAppProfile,
    setuidHelper,
    usernsRestricted,
    usernsUsable,
    wrapperAddsNoSandbox,
    appRunAddsNoSandbox,
    expectNoSandbox,
    consistent: expectNoSandbox === evidence.noSandboxFlag,
    verdict
  };
}

function watchSandboxEvidence(child, holder) {
  const timer = setInterval(() => {
    if (holder.evidence) return;
    try {
      const found = findMainAppProcess(child.pid);
      if (found) holder.evidence = captureSandboxEvidence(found);
    } catch (err) {
      holder.error = err.message;
    }
  }, SAMPLE_INTERVAL_MS);
  child.on("exit", () => clearInterval(timer));
}

export function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

export async function runLinuxProbe(launchPath, { env = {}, appImage = false } = {}) {
  const holder = { evidence: null, error: null };
  const usernsUsable = unprivilegedUsernsUsable();
  const { exitCode, probe } = await runPackageProbe(launchPath, {
    env,
    launcher: ["xvfb-run", ...XVFB_ARGS],
    timeoutMs: LINUX_PROBE_TIMEOUT_MS,
    captureOutput: true,
    onSpawn: (child) => watchSandboxEvidence(child, holder)
  });
  const sandbox = holder.evidence ? { ...holder.evidence, decision: sandboxDecision(holder.evidence, { appImage, usernsUsable }) } : null;
  return { exitCode, probe, sandbox, sandboxSampleError: holder.error };
}

export function linuxProbeProblems(label, result, expectedVersion) {
  const { probe, sandbox } = result;
  const problems = [];
  if (result.exitCode !== 0) problems.push(`${label}: app exited with code ${result.exitCode}`);
  if (probe.platform !== "linux") problems.push(`${label}: probe platform is '${probe.platform}', expected 'linux'`);
  if (probe.appVersion !== expectedVersion) problems.push(`${label}: probe appVersion is '${probe.appVersion}', expected '${expectedVersion}'`);
  if (!probe.rendererLoaded) {
    const failures = Array.isArray(probe.rendererFailures) ? probe.rendererFailures.join("; ") : "";
    problems.push(`${label}: renderer failed to load (${failures || "no failure recorded"})`);
  }
  const ptyProblem = nodePtyProblem(label, probe.nodePty);
  if (ptyProblem) problems.push(ptyProblem);
  const startupProblem = startupModeProblem(label, probe);
  if (startupProblem) problems.push(startupProblem);
  if (!sandbox) {
    problems.push(`${label}: no ${BINARY_NAME} main process was observed while the app ran${result.sandboxSampleError ? ` (${result.sandboxSampleError})` : ""}`);
  } else if (!sandbox.decision.consistent) {
    problems.push(
      `${label}: sandbox decision disagrees with the launcher rules (--no-sandbox ${sandbox.noSandboxFlag ? "added" : "not added"}, ` +
        `label=${sandbox.decision.label ?? "none"}, chrome-sandbox ${sandbox.sandboxHelper.uid ?? "?"}:${sandbox.sandboxHelper.mode ?? "?"}, ` +
        `apparmor_restrict_unprivileged_userns=${sandbox.apparmorRestrictUnprivilegedUserns ?? "absent"}, unprivileged userns usable=${sandbox.decision.usernsUsable})`
    );
  }
  return problems;
}

export function fuseAvailability() {
  try {
    accessSync("/dev/fuse", constants.R_OK | constants.W_OK);
  } catch (err) {
    return { available: false, reason: `/dev/fuse is not usable (${err.code ?? err.message})` };
  }
  const helper = ["fusermount3", "fusermount"].find(commandExists);
  if (!helper) return { available: false, reason: "neither fusermount3 nor fusermount is installed" };
  return { available: true, reason: `/dev/fuse usable, ${helper} present` };
}

export function ensureExecutable(path) {
  const mode = statSync(path).mode;
  if ((mode & 0o111) === 0o111) return false;
  chmodSync(path, mode | 0o755);
  return true;
}

export function runSudo(args) {
  const result = spawnSync("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", ...args], { encoding: "utf8", timeout: APT_TIMEOUT_MS });
  if (result.error) throw new Error(`sudo ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`sudo ${args.join(" ")} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result;
}

export function debianVersion(version) {
  return version.replace(/-/g, "~");
}

export function installedDebVersion() {
  const result = spawnSync("dpkg-query", ["-W", "-f=${Status}\t${Version}", DEB_PACKAGE_NAME], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const [status, version] = result.stdout.split("\t");
  return status.endsWith(" installed") ? version : null;
}

export function debInstallState() {
  const helper = fileOwnership(join(DEB_INSTALL_DIR, "chrome-sandbox"));
  const setuidRoot = helper.uid === 0 && helper.mode === "4755";
  const apparmorProfile = existsSync(APPARMOR_PROFILE_PATH);
  const packageTypePath = join(DEB_INSTALL_DIR, "resources", "package-type");
  let launcherTarget = null;
  try {
    launcherTarget = lstatSync(DEB_LAUNCHER).isSymbolicLink() ? readlinkSync(DEB_LAUNCHER) : DEB_LAUNCHER;
  } catch {
    launcherTarget = null;
  }
  return {
    chromeSandbox: helper,
    chromeSandboxMechanism: setuidRoot ? "setuid-root" : apparmorProfile ? "apparmor-profile" : "user-namespaces",
    apparmorProfile: apparmorProfile ? APPARMOR_PROFILE_PATH : null,
    packageType: existsSync(packageTypePath) ? readFileSync(packageTypePath, "utf8").trim() : null,
    launcherTarget
  };
}
