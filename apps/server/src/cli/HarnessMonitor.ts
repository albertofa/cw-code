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
  private newest: Promise<HarnessAvailability> | null = null;

  constructor(private readonly deps: HarnessMonitorDeps) {}

  async check(trigger: HarnessCheckTrigger): Promise<HarnessAvailability> {
    const run = ++this.latestRun;
    const own = this.execute(run, trigger);
    this.newest = own;
    let current = own;
    let result = await current;
    while (this.newest !== null && this.newest !== current) {
      current = this.newest;
      result = await current;
    }
    return result;
  }

  private async execute(run: number, trigger: HarnessCheckTrigger): Promise<HarnessAvailability> {
    const probe = this.deps.checkCliVersions ?? checkCliVersions;
    const now = this.deps.now ?? Date.now;
    let availability: HarnessAvailability;
    try {
      const checks = await probe(this.deps.binaries());
      availability = {
        checks: checks.map((check) => ({ ...check, skipped: isHarnessSkipped(check) })),
        installed: installedHarnesses(checks),
        issues: harnessIssues(checks),
        checkedAt: now(),
        trigger,
        error: null
      };
    } catch (error) {
      availability = { ...this.deps.current(), trigger, error: errorMessage(error) };
    }
    if (run === this.latestRun) this.deps.publish(availability);
    return availability;
  }
}
