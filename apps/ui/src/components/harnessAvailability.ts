import type { DriverName } from "../cw.js";
import { HARNESS_IDS } from "./settingsSections.js";

export function pickableHarnesses(installed: DriverName[] | null): DriverName[] {
  return installed === null || installed.length === 0 ? HARNESS_IDS : installed;
}

export function fallbackHarness(current: DriverName, installed: DriverName[] | null): DriverName {
  if (installed === null || installed.length === 0 || installed.includes(current)) return current;
  return installed[0];
}
