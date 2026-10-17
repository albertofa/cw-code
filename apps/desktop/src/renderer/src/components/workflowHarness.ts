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

export const PERMISSION_MODES: PermissionMode[] = ["manual", "acceptEdits", "auto", "bypassPermissions"];

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

export type HarnessValueSource = "workflow" | "composer" | "fallback";

export function workflowModel(
  config: PrWorkflowHarness,
  ctx: Pick<WorkflowHarnessContext, "defaultModel" | "recentModels" | "models">
): string | undefined {
  return (config.driver && config.model) || (pickInitialModel(ctx.models, ctx.defaultModel, ctx.recentModels) ?? undefined);
}

export interface HarnessSummaryPart {
  key: "driver" | "model" | "effort" | "permission";
  label: string;
  source: HarnessValueSource;
}

function requestedValues(config: PrWorkflowHarness, pendingPrefs: ComposerPrefs): { effort: EffortLevel; permissionMode: PermissionMode } {
  return {
    effort: config.effort ?? pendingPrefs.effort ?? DEFAULT_EFFORT,
    permissionMode: config.permissionMode ?? pendingPrefs.permissionMode ?? "auto"
  };
}

function sourceOf<T>(configured: T | null, requested: T, resolved: T): HarnessValueSource {
  if (requested !== resolved) return "fallback";
  return configured === null ? "composer" : "workflow";
}

export function harnessSummary(
  config: PrWorkflowHarness,
  resolved: ResolvedWorkflowHarness,
  ctx: Pick<WorkflowHarnessContext, "models" | "permissions" | "pendingPrefs">
): { parts: HarnessSummaryPart[]; title: string } {
  const requested = requestedValues(config, ctx.pendingPrefs);
  const modelLabel = resolved.model ? (ctx.models.find((m) => m.id === resolved.model)?.label ?? resolved.model) : "default model";
  const parts: HarnessSummaryPart[] = [
    { key: "driver", label: harnessLabel(resolved.driver), source: sourceOf(config.driver, resolved.driver, resolved.driver) },
    { key: "model", label: modelLabel, source: config.driver && config.model ? "workflow" : "composer" },
    { key: "effort", label: `${effortLabel(resolved.effort)} effort`, source: sourceOf(config.effort, requested.effort, resolved.effort) },
    {
      key: "permission",
      label: ctx.permissions.find((p) => p.id === resolved.permissionMode)?.label ?? PERMISSION_LABELS[resolved.permissionMode],
      source: sourceOf(config.permissionMode, requested.permissionMode, resolved.permissionMode)
    }
  ];
  const labelsFrom = (source: HarnessValueSource) => parts.filter((part) => part.source === source).map((part) => part.label);
  const composer = labelsFrom("composer");
  const fallback = labelsFrom("fallback");
  const notes = [
    ...(composer.length > 0 ? [`Not set by this workflow, taken from your current composer choice: ${composer.join(", ")}`] : []),
    ...(fallback.length > 0 ? [`Not supported here, falling back to: ${fallback.join(", ")}`] : [])
  ];
  return { parts, title: notes.length === 0 ? "All set by this workflow" : notes.join(". ") };
}

export function fallbackPermission(wanted: PermissionMode, offered: PermissionOption[]): PermissionMode {
  if (offered.length === 0 || offered.some((p) => p.id === wanted)) return wanted;
  const offeredModes = PERMISSION_MODES.filter((mode) => offered.some((p) => p.id === mode));
  const rank = PERMISSION_MODES.indexOf(wanted);
  return offeredModes.filter((mode) => PERMISSION_MODES.indexOf(mode) < rank).at(-1) ?? offeredModes[0] ?? offered[0].id;
}

export function resolveWorkflowHarness(config: PrWorkflowHarness, ctx: WorkflowHarnessContext): ResolvedWorkflowHarness {
  const driver = workflowDriver(config, ctx.composerDriver);
  const model = workflowModel(config, ctx);
  const requested = requestedValues(config, ctx.pendingPrefs);
  const effort = fallbackEffort(requested.effort, effortOptionsFor(driver, ctx.models, model));
  const permissionMode = fallbackPermission(requested.permissionMode, ctx.permissions);
  return { driver, model, effort, permissionMode };
}
