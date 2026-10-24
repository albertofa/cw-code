import type { CliVersionCheck, NodePtyProbeOutcome, ServerPackageProbe } from "@cw-code/contracts";
import { checkCliVersions } from "../cliVersions.js";
import { loadPty, type PtyModule } from "../pty/PtyPool.js";
import { defaultCliBinaryPath } from "../settings/settingsUtils.js";
import { sanitizedChildEnv } from "../shellEnvironment.js";

const NODE_PTY_SPAWN_TIMEOUT_MS = 10_000;

export async function probeNodePty(load: () => Promise<PtyModule> = loadPty): Promise<NodePtyProbeOutcome> {
  let pty: PtyModule;
  try {
    pty = await load();
  } catch (err) {
    return { status: "load-failed", error: (err as Error).message };
  }
  try {
    const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "exit 0"]] : ["/bin/sh", ["-c", "exit 0"]];
    const proc = pty.spawn(file, args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: sanitizedChildEnv(process.env, process.platform)
    });
    return await new Promise<NodePtyProbeOutcome>((resolvePromise) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolvePromise({ status: "loaded-timeout" });
      }, NODE_PTY_SPAWN_TIMEOUT_MS);
      proc.onExit((e) => {
        clearTimeout(timer);
        resolvePromise({ status: "loaded-spawned", exitCode: e.exitCode });
      });
    });
  } catch (err) {
    return { status: "spawn-failed", error: (err as Error).message };
  }
}

export async function runServerPackageProbe(): Promise<ServerPackageProbe> {
  const nodePty = await probeNodePty();
  const cliChecks = await checkCliVersions({
    claudeBinary: defaultCliBinaryPath("claude"),
    opencodeBinary: defaultCliBinaryPath("opencode"),
    codexBinary: defaultCliBinaryPath("codex")
  });
  return { nodePty, cliChecks };
}
