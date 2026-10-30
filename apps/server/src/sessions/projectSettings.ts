import type { DriverKind, EffortLevel, ProjectSettings } from "@cw-code/contracts";
import { PERMISSION_MODES } from "../providers/permissions.js";

export const MAX_PROJECT_SCRIPT_CHARS = 20_000;
export const MAX_PROJECT_INSTRUCTION_CHARS = 4_000;

const DRIVERS: readonly DriverKind[] = ["claude", "opencode", "codex"];
const EFFORTS: readonly EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function sanitizeProjectSettings(raw: unknown): ProjectSettings {
  if (typeof raw !== "object" || raw === null) return {};
  const input = raw as Record<string, unknown>;
  const defaultDriver = oneOf(input.defaultDriver, DRIVERS);
  const candidates: ProjectSettings = {
    defaultDriver,
    defaultModel: defaultDriver ? text(input.defaultModel, 200) : undefined,
    defaultEffort: oneOf(input.defaultEffort, EFFORTS),
    defaultPermissionMode: oneOf(input.defaultPermissionMode, PERMISSION_MODES),
    setupScript: text(input.setupScript, MAX_PROJECT_SCRIPT_CHARS),
    destroyScript: text(input.destroyScript, MAX_PROJECT_SCRIPT_CHARS),
    titleInstructions: text(input.titleInstructions, MAX_PROJECT_INSTRUCTION_CHARS),
    branchInstructions: text(input.branchInstructions, MAX_PROJECT_INSTRUCTION_CHARS)
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) => value !== undefined)) as ProjectSettings;
}
