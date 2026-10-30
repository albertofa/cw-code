import type {
  ComposerPrefs,
  DriverKind,
  EffortLevel,
  HarnessSummaryPart,
  ModelOption,
  PermissionMode,
  PermissionOption,
  PrWorkflowHarness,
  ResolvedWorkflowHarness
} from "@cw-code/contracts";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import { PERMISSION_MODES } from "../providers/permissions.js";

export interface EffortOption {
  id: EffortLevel;
  label: string;
}

const EFFORT_RANK: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const DEFAULT_EFFORT: EffortLevel = "medium";

export function effortLabel(effort: EffortLevel): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

const EFFORTS: EffortOption[] = EFFORT_RANK.map((id) => ({ id, label: effortLabel(id) }));

export function effortOptionsFor(driver: DriverKind, models: ModelOption[], modelId?: string): EffortOption[] {
  if (driver !== "opencode") return EFFORTS;
  if (!modelId) return EFFORTS;
  const model = models.find((m) => m.id === modelId) ?? models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
  if (!model || model.variants === undefined) return EFFORTS;
  if (model.variants.length === 0) return EFFORTS.filter((e) => e.id === "high");
  const available = new Set(model.variants.map((v) => v.toLowerCase()));
  return EFFORTS.filter((e) => available.has(e.id) || (e.id === "medium" && available.has("balanced")));
}

export function fallbackEffort(current: EffortLevel, available: EffortOption[]): EffortLevel {
  if (available.length === 0 || available.some((o) => o.id === current)) return current;
  const want = EFFORT_RANK.indexOf(current);
  const below = available.filter((o) => EFFORT_RANK.indexOf(o.id) <= want).sort((a, b) => EFFORT_RANK.indexOf(b.id) - EFFORT_RANK.indexOf(a.id));
  if (below.length > 0) return below[0].id;
  return available[0].id;
}

export function pickInitialModel(models: ModelOption[], defaultId: string, recents: string[]): string | null {
  const available = new Set(models.map((m) => m.id));
  if (defaultId && available.has(defaultId)) return defaultId;
  const recent = recents.find((id) => available.has(id));
  if (recent !== undefined) return recent;
  return models[0]?.id ?? null;
}

export const INHERITED_HARNESS: PrWorkflowHarness = { driver: null, model: "", effort: null, permissionMode: null };

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  manual: "Supervised",
  acceptEdits: "Auto-accept edits",
  auto: "Auto",
  bypassPermissions: "Full Access"
};

export interface WorkflowHarnessContext {
  composerDriver: DriverKind;
  pendingPrefs: ComposerPrefs;
  defaultModel: string;
  recentModels: string[];
  models: ModelOption[];
  permissions: PermissionOption[];
}

export type { HarnessSummaryPart, ResolvedWorkflowHarness };

export function workflowDriver(config: PrWorkflowHarness, composerDriver: DriverKind): DriverKind {
  return config.driver ?? composerDriver;
}

export type HarnessValueSource = "workflow" | "composer" | "fallback";

export function workflowModel(
  config: PrWorkflowHarness,
  ctx: Pick<WorkflowHarnessContext, "defaultModel" | "recentModels" | "models">
): string | undefined {
  return (config.driver && config.model) || (pickInitialModel(ctx.models, ctx.defaultModel, ctx.recentModels) ?? undefined);
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
