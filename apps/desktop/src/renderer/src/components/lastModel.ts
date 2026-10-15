import type { DriverName } from "../cw.js";
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

