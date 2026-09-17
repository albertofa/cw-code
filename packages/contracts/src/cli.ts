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
}

export type CliDiscoverResult = Record<CliBinary, CliDiscoveredCandidate[]>;
