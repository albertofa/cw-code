import type { DriverKind } from "@cw-code/contracts";

export const HARNESS_LABELS: Record<DriverKind, string> = {
  claude: "Claude",
  opencode: "OpenCode",
  codex: "Codex"
};

export function harnessLabel(driver: DriverKind): string {
  return HARNESS_LABELS[driver];
}
