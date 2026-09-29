import type { DriverName, ModelOption } from "../cw.js";
import { stripContextSuffix } from "./modelMenus.js";

const RECENT_MODELS_MAX = 3;

function recentKey(driver: DriverName): string {
  return `cw:recentModels:${driver}`;
}

function recentId(driver: DriverName, id: string): string {
  return driver === "claude" ? stripContextSuffix(id) : id;
}

function readStoredRecents(driver: DriverName): string[] {
  const raw = window.localStorage.getItem(recentKey(driver));
  if (raw === null) {
    const legacy = window.localStorage.getItem(`cw:lastModel:${driver}`);
    return legacy ? [recentId(driver, legacy)] : [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const ids = parsed
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => recentId(driver, id));
  return [...new Set(ids)].slice(0, RECENT_MODELS_MAX);
}

export function getRecentModels(driver: DriverName): string[] {
  try {
    return readStoredRecents(driver);
  } catch {
    return [];
  }
}

export function pushRecentModel(driver: DriverName, id: string): void {
  const normalized = recentId(driver, id);
  if (!normalized) return;
  try {
    const next = [normalized, ...getRecentModels(driver).filter((existing) => existing !== normalized)].slice(0, RECENT_MODELS_MAX);
    window.localStorage.setItem(recentKey(driver), JSON.stringify(next));
  } catch {
  }
}

export function getLastModel(driver: DriverName): string | null {
  return getRecentModels(driver)[0] ?? null;
}

export function setLastModel(driver: DriverName, id: string): void {
  pushRecentModel(driver, id);
}

export function firstDisplayedModelId(driver: DriverName, models: ModelOption[]): string | undefined {
  if (models.length === 0) return undefined;
  if (driver !== "opencode") return models[0].id;
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const slash = m.id.indexOf("/");
    const provider = slash >= 0 ? m.id.slice(0, slash) : "other";
    const list = groups.get(provider) ?? [];
    list.push(m);
    groups.set(provider, list);
  }
  for (const [, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length > 0) return list[0].id;
  }
  return models[0].id;
}
