import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nodePtyProblem, runPackageProbe, startupModeProblem } from "./package-probe.mjs";

export const DEB_INSTALL_DIR = "/opt/cw-code";
export const DEB_LAUNCHER = "/usr/bin/cw-code";
export const DEB_PACKAGE_NAME = "cw-code";
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/cw-code";
export const DEB_SANDBOX_HELPER = join(DEB_INSTALL_DIR, "chrome-sandbox");
const EXECUTABLE_NAME = "cw-code";
const LINUX_PROBE_TIMEOUT_MS = 90_000;
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

export function unprivilegedUsernsUsable() {
  return spawnSync("unshare", ["-Ur", "true"], { stdio: "ignore" }).status === 0;
}

function hostSandboxEvidence(sandboxHelperPath) {
  return {
    apparmorRestrictUnprivilegedUserns: readUsernsRestriction(),
    unprivilegedUsernsUsable: unprivilegedUsernsUsable(),
    sandboxHelper: sandboxHelperPath
      ? fileOwnership(sandboxHelperPath)
      : { path: null, note: "inside the AppImage: a user FUSE mount or extraction never honours setuid" }
  };
}

export function sandboxDecision(app, host, { appImage }) {
  const label = app.apparmorLabel;
  const underAppProfile = label !== null && label.startsWith(`${EXECUTABLE_NAME} `);
  const setuidHelper = host.sandboxHelper.uid === 0 && host.sandboxHelper.mode === "4755";
  const usernsRestricted = host.apparmorRestrictUnprivilegedUserns === "1";
  const wrapperAddsNoSandbox = !underAppProfile && !setuidHelper && usernsRestricted;
  const appRunAddsNoSandbox = appImage && !host.unprivilegedUsernsUsable;
  const expectNoSandbox = wrapperAddsNoSandbox || appRunAddsNoSandbox;
  const reasons = [
    ...(appRunAddsNoSandbox ? ["AppRun: 'unshare -Ur true' failed"] : []),
    ...(wrapperAddsNoSandbox ? ["wrapper: user namespaces restricted by AppArmor, no app profile, no setuid helper"] : [])
  ];
  const verdict = app.noSandboxSwitch
    ? `disabled: --no-sandbox (${reasons.join("; ") || "no launcher rule explains it"})`
    : underAppProfile
      ? `enabled: user namespaces under the AppArmor profile '${label}'`
      : setuidHelper
        ? "enabled: setuid-root chrome-sandbox"
        : "enabled: unprivileged user namespaces";
  return {
    underAppProfile,
    setuidHelper,
    usernsRestricted,
    wrapperAddsNoSandbox,
    appRunAddsNoSandbox,
    expectNoSandbox,
    consistent: expectNoSandbox === app.noSandboxSwitch,
    verdict
  };
}

export function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

export async function runLinuxProbe(launchPath, { env = {}, appImage = false, sandboxHelperPath = null } = {}) {
  const host = hostSandboxEvidence(sandboxHelperPath);
  const { exitCode, probe, processGroupExited } = await runPackageProbe(launchPath, {
    env,
    launcher: ["xvfb-run", ...XVFB_ARGS],
    timeoutMs: LINUX_PROBE_TIMEOUT_MS,
    captureOutput: true
  });
  const sandbox = probe.sandbox ? { app: probe.sandbox, host, decision: sandboxDecision(probe.sandbox, host, { appImage }) } : { app: null, host, decision: null };
  return { exitCode, probe, processGroupExited, sandbox };
}

export function linuxProbeProblems(label, result, expectedVersion) {
  const { probe, sandbox } = result;
  const problems = [];
  if (result.exitCode !== 0) problems.push(`${label}: app exited with code ${result.exitCode}`);
  if (result.processGroupExited === false) problems.push(`${label}: processes from the app's process group were still running after SIGKILL`);
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
  if (!sandbox.decision) {
    problems.push(`${label}: the packaged app reported no sandbox evidence (probe.sandbox is ${JSON.stringify(probe.sandbox)})`);
  } else if (!sandbox.decision.consistent) {
    problems.push(
      `${label}: sandbox decision disagrees with the launcher rules (--no-sandbox ${sandbox.app.noSandboxSwitch ? "present" : "absent"}, ` +
        `label=${sandbox.app.apparmorLabel ?? "none"}, chrome-sandbox ${sandbox.host.sandboxHelper.uid ?? "?"}:${sandbox.host.sandboxHelper.mode ?? "?"}, ` +
        `apparmor_restrict_unprivileged_userns=${sandbox.host.apparmorRestrictUnprivilegedUserns ?? "absent"}, ` +
        `unprivileged userns usable=${sandbox.host.unprivilegedUsernsUsable})`
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
  const helper = fileOwnership(DEB_SANDBOX_HELPER);
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
