import type { PrWorkflowHarness } from "@cw-code/contracts";
import type { ComposerPrefs, DriverName, EffortLevel, ModelOption, PermissionMode, PermissionOption } from "../cw.js";
import { DEFAULT_EFFORT, effortLabel, effortOptionsFor, fallbackEffort, pickInitialModel } from "./modelMenus.js";
import { harnessLabel } from "./toolTabs.js";

export const INHERITED_HARNESS: PrWorkflowHarness = { driver: null, model: "", effort: null, permissionMode: null };

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  manual: "Supervised",
  acceptEdits: "Auto-accept edits",
  auto: "Auto",
  bypassPermissions: "Full Access"
};

export const PERMISSION_MODES = Object.keys(PERMISSION_LABELS) as PermissionMode[];

export interface WorkflowHarnessContext {
  composerDriver: DriverName;
  pendingPrefs: ComposerPrefs;
  defaultModel: string;
  recentModels: string[];
  models: ModelOption[];
  permissions: PermissionOption[];
}

export interface ResolvedWorkflowHarness {
  driver: DriverName;
  model: string | undefined;
  effort: EffortLevel;
  permissionMode: PermissionMode;
}

export function workflowDriver(config: PrWorkflowHarness, composerDriver: DriverName): DriverName {
  return config.driver ?? composerDriver;
}

export interface HarnessSummaryPart {
  key: "driver" | "model" | "effort" | "permission";
  label: string;
  inherited: boolean;
}

export function harnessSummary(
  config: PrWorkflowHarness,
  resolved: ResolvedWorkflowHarness,
  lists: { models: ModelOption[]; permissions: PermissionOption[] }
): { parts: HarnessSummaryPart[]; title: string } {
  const modelLabel = resolved.model ? (lists.models.find((m) => m.id === resolved.model)?.label ?? resolved.model) : "default model";
  const parts: HarnessSummaryPart[] = [
    { key: "driver", label: harnessLabel(resolved.driver), inherited: config.driver === null },
    { key: "model", label: modelLabel, inherited: !(config.driver && config.model) },
    { key: "effort", label: `${effortLabel(resolved.effort)} effort`, inherited: config.effort === null },
    {
      key: "permission",
      label: lists.permissions.find((p) => p.id === resolved.permissionMode)?.label ?? PERMISSION_LABELS[resolved.permissionMode],
      inherited: config.permissionMode === null
    }
  ];
  const inherited = parts.filter((part) => part.inherited).map((part) => part.label);
  const title =
    inherited.length === 0
      ? "All set by this workflow"
      : `Not set by this workflow, taken from your current composer choice: ${inherited.join(", ")}`;
  return { parts, title };
}

export function resolveWorkflowHarness(config: PrWorkflowHarness, ctx: WorkflowHarnessContext): ResolvedWorkflowHarness {
  const driver = workflowDriver(config, ctx.composerDriver);
  const model = (config.driver && config.model) || (pickInitialModel(ctx.models, ctx.defaultModel, ctx.recentModels) ?? undefined);
  const effort = fallbackEffort(config.effort ?? ctx.pendingPrefs.effort ?? DEFAULT_EFFORT, effortOptionsFor(driver, ctx.models, model));
  const wanted = config.permissionMode ?? ctx.pendingPrefs.permissionMode ?? "auto";
  const permissionMode = ctx.permissions.length === 0 || ctx.permissions.some((p) => p.id === wanted) ? wanted : ctx.permissions[0].id;
  return { driver, model, effort, permissionMode };
}
