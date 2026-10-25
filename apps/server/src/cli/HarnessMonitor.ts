import type { CliVersionCheck, HarnessAvailability } from "@cw-code/contracts";
import { checkCliVersions } from "../cliVersions.js";
import { harnessIssues, installedHarnesses, isHarnessSkipped } from "./harnessAvailability.js";

export type HarnessCheckTrigger = HarnessAvailability["trigger"];

export interface HarnessBinaries {
  claudeBinary: string;
  opencodeBinary: string;
  codexBinary: string;
}

export interface HarnessMonitorDeps {
  binaries(): HarnessBinaries;
  current(): HarnessAvailability;
  publish(availability: HarnessAvailability): void;
  checkCliVersions?(binaries: HarnessBinaries): Promise<CliVersionCheck[]>;
  now?(): number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HarnessMonitor {
  private latestRun = 0;

  constructor(private readonly deps: HarnessMonitorDeps) {}

  async check(trigger: HarnessCheckTrigger): Promise<void> {
    const run = ++this.latestRun;
    const probe = this.deps.checkCliVersions ?? checkCliVersions;
    const now = this.deps.now ?? Date.now;
    try {
      const checks = await probe(this.deps.binaries());
      if (run !== this.latestRun) return;
      this.deps.publish({
        checks: checks.map((check) => ({ ...check, skipped: isHarnessSkipped(check) })),
        installed: installedHarnesses(checks),
        issues: harnessIssues(checks),
        checkedAt: now(),
        trigger,
        error: null
      });
    } catch (error) {
      if (run !== this.latestRun) return;
      this.deps.publish({ ...this.deps.current(), trigger, error: errorMessage(error) });
    }
  }
}
