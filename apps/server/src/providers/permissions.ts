import type { PermissionMode, PermissionOption } from "@cw-code/contracts";

export const PERMISSION_DETAILS: Record<PermissionMode, { label: string; description: string }> = {
  manual: { label: "Supervised", description: "Ask before commands and file changes." },
  acceptEdits: { label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions." },
  auto: { label: "Auto", description: "Supported providers approve routine actions; others still ask." },
  bypassPermissions: { label: "Full Access", description: "Allow commands and edits without prompts." }
};

export const SYNTHETIC_FULL_ACCESS_DESCRIPTION =
  "No native bypass; cw-code auto-accepts prompts in the background.";

export function permissionOption(id: PermissionMode, native: boolean): PermissionOption {
  const details = PERMISSION_DETAILS[id];
  return {
    id,
    label: details.label,
    description: native ? details.description : SYNTHETIC_FULL_ACCESS_DESCRIPTION,
    native
  };
}

export function withSyntheticFullAccess(options: PermissionOption[]): PermissionOption[] {
  if (options.some((o) => o.id === "bypassPermissions")) return options;
  return [...options, permissionOption("bypassPermissions", false)];
}

export function isFullAccessMode(mode: PermissionMode | string | undefined): boolean {
  return mode === "bypassPermissions";
}
