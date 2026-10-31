import type { DriverKind } from "@cw-code/contracts";

export const DRIVER_KINDS: readonly DriverKind[] = ["claude", "opencode", "codex"];

export function isDriverKind(value: unknown): value is DriverKind {
  return DRIVER_KINDS.some((kind) => kind === value);
}
