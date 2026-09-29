import type { DriverName, EffortLevel, ModelOption, SettingsPatch } from "../cw.js";
import { formatTokensShort } from "./subagents.js";

export interface EffortOption {
  id: EffortLevel;
  label: string;
}

export interface ModelGroup {
  id: string;
  label: string;
  models: ModelOption[];
}

export interface PickerSection {
  id: string;
  label: string;
  icon: "recent" | DriverName;
  models: ModelOption[];
}

export interface ModelDetailRow {
  label: string;
  value: string;
  mono?: boolean;
}

const CONTEXT_SUFFIX = /\[1m\]$/i;

const EFFORT_RANK: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  opencode: "OpenCode"
};

export const DEFAULT_EFFORT: EffortLevel = "medium";

export function effortLabel(effort: EffortLevel): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

export const EFFORTS: EffortOption[] = EFFORT_RANK.map((id) => ({ id, label: effortLabel(id) }));

export function effortOptionsFor(driver: DriverName, models: ModelOption[], modelId?: string): EffortOption[] {
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

export function defaultModelPatch(driver: DriverName, id: string): SettingsPatch {
  if (driver === "claude") return { claudeDefaultModel: id };
  if (driver === "codex") return { codexDefaultModel: id };
  return { opencodeDefaultModel: id };
}

export function hasContextSuffix(id: string): boolean {
  return CONTEXT_SUFFIX.test(id);
}

export function stripContextSuffix(id: string): string {
  return id.replace(CONTEXT_SUFFIX, "");
}

export function withContextSuffix(id: string, oneM: boolean): string {
  const base = stripContextSuffix(id);
  return oneM ? `${base}[1m]` : base;
}

export function contextWindowLabel(oneM: boolean): string {
  return oneM ? "1M" : "200K";
}

export function pickInitialModel(models: ModelOption[], defaultId: string, recents: string[]): string | null {
  const available = new Set(models.map((m) => m.id));
  if (defaultId && available.has(defaultId)) return defaultId;
  const recent = recents.find((id) => available.has(id));
  if (recent !== undefined) return recent;
  return models[0]?.id ?? null;
}

export function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(0, slash) : "other";
}

export function providerDriver(provider: string): DriverName {
  const key = provider.toLowerCase();
  if (key === "anthropic") return "claude";
  if (key === "openai") return "codex";
  return "opencode";
}

export function providerLabel(provider: string): string {
  const known = PROVIDER_LABELS[provider.toLowerCase()];
  if (known) return known;
  return provider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function groupModels(driver: DriverName, models: ModelOption[]): ModelGroup[] {
  if (driver !== "opencode") {
    if (models.length === 0) return [];
    return [{ id: driver, label: driver === "claude" ? "Claude Code" : "Codex", models }];
  }
  const byProvider = new Map<string, ModelOption[]>();
  for (const model of models) {
    const provider = providerOf(model.id);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({ id: provider, label: providerLabel(provider), models: list }));
}

export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
}

export function pickerSections(driver: DriverName, models: ModelOption[], recents: string[], query: string): PickerSection[] {
  const searching = query.trim() !== "";
  const groups = groupModels(driver, filterModels(models, query)).map((group) => ({
    id: group.id,
    label: group.label,
    icon: driver === "opencode" ? providerDriver(group.id) : driver,
    models: group.models
  }));
  const recentModels = searching ? [] : recents.flatMap((id) => models.find((m) => m.id === id) ?? []);
  if (recentModels.length === 0) return groups;
  return [{ id: "recent", label: "Recent", icon: "recent", models: recentModels }, ...groups];
}

export function hasModelDetail(model: ModelOption): boolean {
  return model.meta !== undefined || model.contextWindow !== undefined;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function sourceLabel(model: ModelOption, harness: string): string {
  if (model.source === "live") return `Live from ${harness}`;
  return model.source === "curated" ? "Curated list" : "Custom";
}

export function modelDetailRows(model: ModelOption, harness: string): ModelDetailRow[] {
  const rows: ModelDetailRow[] = [{ label: "Model", value: model.id, mono: true }];
  if (model.contextWindow !== undefined) rows.push({ label: "Context", value: `${formatTokensShort(model.contextWindow)} tokens` });
  const meta = model.meta;
  if (meta?.capabilities?.length) rows.push({ label: "Capabilities", value: meta.capabilities.join(", ") });
  if (meta?.input?.length) rows.push({ label: "Input", value: meta.input.join(", ") });
  if (meta?.output?.length) rows.push({ label: "Output", value: meta.output.join(", ") });
  const cost = [
    meta?.costInputPerM !== undefined ? `In ${usd(meta.costInputPerM)}` : null,
    meta?.costOutputPerM !== undefined ? `Out ${usd(meta.costOutputPerM)}` : null
  ].filter((part): part is string => part !== null);
  if (cost.length > 0) rows.push({ label: "Cost ($/1M tokens)", value: cost.join(" · ") });
  if (model.variants?.length) rows.push({ label: "Variants", value: model.variants.join(" · ") });
  rows.push({ label: "Source", value: sourceLabel(model, harness) });
  return rows;
}
