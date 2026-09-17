import { execCliFile } from "./cli/spawnCli.js";
import { traceHarnessCall } from "./debug/harnessTrace.js";

export const MINIMUM_VERSIONS = {
  claude: "2.1.260",
  opencode: "1.18.23",
  codex: "0.153.4"
} as const;

export interface CliVersionCheck {
  binary: "claude" | "opencode" | "codex";
  binaryPath: string;
  minimum: string;
  actual: string | null;
  available: boolean;
  error: string | null;
  ok: boolean;
}

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

export function meetsMinimum(actual: string | null, minimum: string): boolean {
  if (actual == null) return false;
  const a = actual.match(SEMVER_RE);
  const m = minimum.match(SEMVER_RE);
  if (!a || !m) return actual === minimum;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(m[i]);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export function isBinaryUnavailableError(error: { code?: string | number | null }): boolean {
  return error.code === "ENOENT" || error.code === "EACCES" || error.code === "EINVAL" || error.code === "EPERM";
}

async function queryVersion(binaryPath: string): Promise<{ actual: string | null; available: boolean; error: string | null }> {
  const fail = (error: unknown): { actual: string | null; available: boolean; error: string | null } => {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: string | number | null }).code
      : undefined;
    return {
      actual: null,
      available: !isBinaryUnavailableError({ code }),
      error: error instanceof Error ? error.message : String(error)
    };
  };
  try {
    const { stdout } = await execCliFile(binaryPath, ["--version"], { timeout: 15000 });
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return { actual: match ? match[1] : stdout.trim().slice(0, 32), available: true, error: null };
  } catch (error) {
    return fail(error);
  }
}

export async function checkCliVersions(opts: {
  claudeBinary: string;
  opencodeBinary: string;
  codexBinary: string;
}): Promise<CliVersionCheck[]> {
  const binaries: Record<"claude" | "opencode" | "codex", string> = {
    claude: opts.claudeBinary,
    opencode: opts.opencodeBinary,
    codex: opts.codexBinary
  };
  const entries = (Object.keys(MINIMUM_VERSIONS) as Array<"claude" | "opencode" | "codex">).map((binary) =>
    checkCliVersion(binary, binaries[binary])
  );
  return Promise.all(entries);
}

export async function checkCliVersion(
  binary: "claude" | "opencode" | "codex",
  binaryPath: string
): Promise<CliVersionCheck> {
  const start = Date.now();
  const { actual, available, error } = await queryVersion(binaryPath);
  const minimum = MINIMUM_VERSIONS[binary];
  const ok = meetsMinimum(actual, minimum);
  traceHarnessCall({
    harness: binary,
    operation: "cli.checkVersions",
    binary: binaryPath,
    args: ["--version"],
    durationMs: Date.now() - start,
    ok,
    extra: { actual, minimum }
  });
  return { binary, binaryPath, minimum, actual, available, error, ok };
}
