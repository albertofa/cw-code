import type { DriverName } from "../cw.js";
import { HARNESS_IDS } from "./settingsSections.js";

export interface HarnessPresence {
  binary: DriverName;
  configured: boolean;
  available: boolean;
}

export function isHarnessSkipped(check: HarnessPresence): boolean {
  return !check.available && !check.configured;
}

export function installedHarnesses(checks: HarnessPresence[]): DriverName[] {
  const skipped = new Set(checks.filter(isHarnessSkipped).map((check) => check.binary));
  return HARNESS_IDS.filter((id) => !skipped.has(id));
}

export function pickableHarnesses(installed: DriverName[] | null): DriverName[] {
  return installed === null || installed.length === 0 ? HARNESS_IDS : installed;
}

export function fallbackHarness(current: DriverName, installed: DriverName[] | null): DriverName {
  if (installed === null || installed.length === 0 || installed.includes(current)) return current;
  return installed[0];
}
