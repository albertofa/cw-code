export type CliBinary = "claude" | "opencode" | "codex" | "git" | "gh";

export type BinarySource = "path" | "common" | "configured";

export interface CliDiscoveredCandidate {
  binary: CliBinary;
  path: string;
  source: BinarySource;
  version: string | null;
  available: boolean;
  error: string | null;
  ok: boolean;
  minimum: string | null;
}

export type CliDiscoverResult = Record<CliBinary, CliDiscoveredCandidate[]>;

export interface CliVersionCheck {
  binary: "claude" | "opencode" | "codex";
  binaryPath: string;
  minimum: string;
  actual: string | null;
  configured: boolean;
  found: boolean;
  available: boolean;
  error: string | null;
  ok: boolean;
}

export type NodePtyProbeOutcome =
  | { status: "loaded-spawned"; exitCode: number }
  | { status: "loaded-timeout" }
  | { status: "load-failed"; error: string }
  | { status: "spawn-failed"; error: string };

export interface ServerPackageProbe {
  nodePty: NodePtyProbeOutcome;
  cliChecks: CliVersionCheck[];
}
