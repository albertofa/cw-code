import { writeFileSync } from "node:fs";
import { checkCliVersions, type CliVersionCheck } from "../cliVersions.js";
import { defaultCliBinaryPath } from "../settings/settingsUtils.js";
import type { PtyModule } from "../pty/PtyPool.js";

export interface PackageProbeNodePtyResult {
  loaded: boolean;
  spawned: boolean;
  exitCode: number | null;
  error: string | null;
}

export type NodePtyProbeOutcome =
  | { status: "loaded-spawned"; exitCode: number }
  | { status: "loaded-timeout" }
  | { status: "load-failed"; error: string }
  | { status: "spawn-failed"; error: string };

export interface PackageProbeResult {
  appVersion: string;
  electron: string;
  platform: string;
  arch: string;
  nodePty: PackageProbeNodePtyResult;
  rendererLoaded: boolean;
  cliChecks: CliVersionCheck[];
  durationMs: number;
}

export function shapeNodePtyResult(outcome: NodePtyProbeOutcome): PackageProbeNodePtyResult {
  switch (outcome.status) {
    case "loaded-spawned":
      return { loaded: true, spawned: true, exitCode: outcome.exitCode, error: null };
    case "loaded-timeout":
      return { loaded: true, spawned: true, exitCode: null, error: "pty did not exit within timeout" };
    case "load-failed":
      return { loaded: false, spawned: false, exitCode: null, error: outcome.error };
    case "spawn-failed":
      return { loaded: true, spawned: false, exitCode: null, error: outcome.error };
  }
}

export function buildProbeResult(opts: {
  appVersion: string;
  electronVersion: string;
  platform: string;
  arch: string;
  nodePty: NodePtyProbeOutcome;
  rendererLoaded: boolean;
  cliChecks: CliVersionCheck[];
  durationMs: number;
}): PackageProbeResult {
  return {
    appVersion: opts.appVersion,
    electron: opts.electronVersion,
    platform: opts.platform,
    arch: opts.arch,
    nodePty: shapeNodePtyResult(opts.nodePty),
    rendererLoaded: opts.rendererLoaded,
    cliChecks: opts.cliChecks,
    durationMs: opts.durationMs
  };
}

const NODE_PTY_SPAWN_TIMEOUT_MS = 10_000;

async function probeNodePty(): Promise<NodePtyProbeOutcome> {
  let pty: PtyModule;
  try {
    pty = (await import("node-pty")) as unknown as PtyModule;
  } catch (err) {
    return { status: "load-failed", error: (err as Error).message };
  }
  try {
    const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "exit 0"]] : ["/bin/sh", ["-c", "exit 0"]];
    const proc = pty.spawn(file, args, { name: "xterm-color", cols: 80, rows: 24, cwd: process.cwd() });
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

export async function runPackageProbe(opts: {
  outPath: string;
  appVersion: string;
  electronVersion: string;
  rendererLoaded: boolean;
}): Promise<PackageProbeResult> {
  const start = Date.now();
  const nodePty = await probeNodePty();
  const cliChecks = await checkCliVersions({
    claudeBinary: defaultCliBinaryPath("claude"),
    opencodeBinary: defaultCliBinaryPath("opencode"),
    codexBinary: defaultCliBinaryPath("codex")
  });
  const result = buildProbeResult({
    appVersion: opts.appVersion,
    electronVersion: opts.electronVersion,
    platform: process.platform,
    arch: process.arch,
    nodePty,
    rendererLoaded: opts.rendererLoaded,
    cliChecks,
    durationMs: Date.now() - start
  });
  writeFileSync(opts.outPath, JSON.stringify(result, null, 2), "utf8");
  return result;
}
