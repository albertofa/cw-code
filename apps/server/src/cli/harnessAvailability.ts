import type { CliVersionCheck, DriverKind, HarnessIssue } from "@cw-code/contracts";

export interface HarnessPresence {
  binary: DriverKind;
  configured: boolean;
  found: boolean;
}

const HARNESS_IDS: readonly DriverKind[] = ["claude", "opencode", "codex"];

export function isHarnessSkipped(check: HarnessPresence): boolean {
  return !check.found && !check.configured;
}

export function installedHarnesses(checks: HarnessPresence[]): DriverKind[] {
  const skipped = new Set(checks.filter(isHarnessSkipped).map((check) => check.binary));
  return HARNESS_IDS.filter((id) => !skipped.has(id));
}

export function harnessIssues(checks: CliVersionCheck[]): HarnessIssue[] {
  const installed = installedHarnesses(checks);
  const missing = checks.filter((c) => !c.available && !isHarnessSkipped(c));
  const failed = checks.filter((c) => c.available && c.actual === null);
  const outdated = checks.filter((c) => c.actual !== null && !c.ok);
  const issues: HarnessIssue[] = [];

  if (installed.length === 0) {
    issues.push({
      id: "cli-binaries",
      level: "error",
      title: "No harness installed",
      message: "Install Claude Code, OpenCode or Codex, or point cw-code at its executable in Settings.",
      binaries: []
    });
  } else if (missing.length > 0) {
    issues.push({
      id: "cli-binaries",
      level: "error",
      title: "CLI binary unavailable",
      message: missing.map((c) => `${c.binary}: could not run '${c.binaryPath}'. Change its executable in Settings.`).join("\n"),
      binaries: missing.map((c) => c.binary)
    });
  }

  if (failed.length > 0 || outdated.length > 0) {
    issues.push({
      id: "cli-versions",
      level: "warning",
      title: failed.length > 0 ? "CLI version check failed" : "CLI out of date",
      message: [
        ...failed.map((c) => `${c.binary}: could not read the version from '${c.binaryPath}'`),
        ...outdated.map((c) => `${c.binary}: needs >= ${c.minimum}, found ${c.actual}`)
      ].join("\n"),
      binaries: [...failed, ...outdated].map((c) => c.binary)
    });
  }
  return issues;
}
