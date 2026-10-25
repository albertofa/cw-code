import type { PrWorkflowHarness } from "@cw-code/contracts";
import type { PermissionMode } from "../cw.js";

export const INHERITED_HARNESS: PrWorkflowHarness = { driver: null, model: "", effort: null, permissionMode: null };

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  manual: "Supervised",
  acceptEdits: "Auto-accept edits",
  auto: "Auto",
  bypassPermissions: "Full Access"
};

export const PERMISSION_MODES: PermissionMode[] = ["manual", "acceptEdits", "auto", "bypassPermissions"];
