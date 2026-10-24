import { readFileSync, writeFileSync } from "node:fs";
import type { CliVersionCheck, NodePtyProbeOutcome, ServerPackageProbe, StartupState } from "@cw-code/contracts";

export interface PackageProbeNodePtyResult {
  loaded: boolean;
  spawned: boolean;
  exitCode: number | null;
  error: string | null;
}

export type PackageProbeStartupMode = StartupState["mode"];

export interface PackageProbeSandbox {
  noSandboxSwitch: boolean;
  apparmorLabel: string | null;
}

export interface PackageProbeResult {
  appVersion: string;
  startupMode: PackageProbeStartupMode;
  electron: string;
  platform: string;
  arch: string;
  nodePty: PackageProbeNodePtyResult;
  rendererLoaded: boolean;
  rendererFailures: string[];
  cliChecks: CliVersionCheck[];
  sandbox: PackageProbeSandbox | null;
  durationMs: number;
}

const APPARMOR_LABEL_PATHS = ["/proc/self/attr/apparmor/current", "/proc/self/attr/current"];

export function readApparmorLabel(readFile: (path: string) => string): string | null {
  for (const path of APPARMOR_LABEL_PATHS) {
    let raw: string;
    try {
      raw = readFile(path);
    } catch {
      continue;
    }
    const label = raw.replace(/\0/g, "").trim();
    return label === "" ? null : label;
  }
  return null;
}

export function probeSandbox(platform: string, noSandboxSwitch: boolean, readFile: (path: string) => string): PackageProbeSandbox | null {
  if (platform !== "linux") return null;
  return { noSandboxSwitch, apparmorLabel: readApparmorLabel(readFile) };
}

export interface RendererProbeState {
  loadCompleted: boolean;
  failures: string[];
}

export class RendererProbeTracker {
  private loadCompleted = false;
  private readonly failures: string[] = [];

  markLoaded(): void {
    this.loadCompleted = true;
  }

  markFailed(reason: string): void {
    this.failures.push(reason);
  }

  snapshot(): RendererProbeState {
    return { loadCompleted: this.loadCompleted, failures: [...this.failures] };
  }
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
  startupMode: PackageProbeStartupMode;
  electronVersion: string;
  platform: string;
  arch: string;
  nodePty: NodePtyProbeOutcome;
  renderer: RendererProbeState;
  cliChecks: CliVersionCheck[];
  sandbox: PackageProbeSandbox | null;
  durationMs: number;
}): PackageProbeResult {
  return {
    appVersion: opts.appVersion,
    startupMode: opts.startupMode,
    electron: opts.electronVersion,
    platform: opts.platform,
    arch: opts.arch,
    nodePty: shapeNodePtyResult(opts.nodePty),
    rendererLoaded: opts.renderer.loadCompleted && opts.renderer.failures.length === 0,
    rendererFailures: [...opts.renderer.failures],
    cliChecks: opts.cliChecks,
    sandbox: opts.sandbox,
    durationMs: opts.durationMs
  };
}

export function failedServerProbe(error: string): ServerPackageProbe {
  return { nodePty: { status: "load-failed", error }, cliChecks: [] };
}

export async function runPackageProbe(opts: {
  outPath: string;
  appVersion: string;
  startupMode: PackageProbeStartupMode;
  electronVersion: string;
  noSandboxSwitch: boolean;
  renderer: RendererProbeTracker;
  probeServer: () => Promise<ServerPackageProbe>;
}): Promise<PackageProbeResult> {
  const start = Date.now();
  const { nodePty, cliChecks } = await opts.probeServer();
  const result = buildProbeResult({
    appVersion: opts.appVersion,
    startupMode: opts.startupMode,
    electronVersion: opts.electronVersion,
    platform: process.platform,
    arch: process.arch,
    nodePty,
    renderer: opts.renderer.snapshot(),
    cliChecks,
    sandbox: probeSandbox(process.platform, opts.noSandboxSwitch, (path) => readFileSync(path, "utf8")),
    durationMs: Date.now() - start
  });
  writeFileSync(opts.outPath, JSON.stringify(result, null, 2), "utf8");
  return result;
}
