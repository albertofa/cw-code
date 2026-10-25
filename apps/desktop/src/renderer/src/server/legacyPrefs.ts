import type { LegacyPreferences, SidebarOrderPrefs } from "@cw-code/contracts";
import type { CwApi, DriverName } from "../cw.js";

const MIGRATED_KEY = "cw-code:prefs-migrated";
const ORDER_KEY = "cw:order:all";
const COMPOSER_KEY_PREFIX = "cw:composer:";
const MAX_ENTRY_LENGTH = 200;
const MAX_LIST_ENTRIES = 10_000;
const DRIVERS: readonly DriverName[] = ["claude", "opencode", "codex"];

function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function readSidebarOrder(storage: Storage): SidebarOrderPrefs | undefined {
  const parsed = parseJson(storage.getItem(ORDER_KEY));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const order = parsed as Record<string, unknown>;
  if (!Array.isArray(order.main) || !Array.isArray(order.resolved)) return undefined;
  return { main: stringList(order.main), resolved: stringList(order.resolved), pinned: stringList(order.pinned) };
}

function readRecentModels(storage: Storage, driver: DriverName): string[] {
  const parsed = parseJson(storage.getItem(`cw:recentModels:${driver}`));
  if (Array.isArray(parsed)) return stringList(parsed);
  const lastModel = storage.getItem(`cw:lastModel:${driver}`);
  return lastModel ? [lastModel] : [];
}

function readLegacyPreferences(storage: Storage): LegacyPreferences {
  const legacy: LegacyPreferences = {};
  const sidebarOrder = readSidebarOrder(storage);
  if (sidebarOrder) legacy.sidebarOrder = sidebarOrder;
  const recentModels: NonNullable<LegacyPreferences["recentModels"]> = {};
  for (const driver of DRIVERS) {
    const models = readRecentModels(storage, driver);
    if (models.length > 0) recentModels[driver] = models;
  }
  if (Object.keys(recentModels).length > 0) legacy.recentModels = recentModels;
  return legacy;
}

function storageKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null);
}

function removeMigratedKeys(storage: Storage): void {
  for (const driver of DRIVERS) {
    storage.removeItem(`cw:recentModels:${driver}`);
    storage.removeItem(`cw:lastModel:${driver}`);
  }
  for (const key of storageKeys(storage)) {
    if (key.startsWith(COMPOSER_KEY_PREFIX)) storage.removeItem(key);
  }
}

function boundedList(list: readonly string[]): string[] {
  return list.filter((item) => item.length <= MAX_ENTRY_LENGTH).slice(0, MAX_LIST_ENTRIES);
}

function sanitizeLegacyPreferences(legacy: LegacyPreferences): LegacyPreferences {
  const sanitized: LegacyPreferences = {};
  if (legacy.sidebarOrder) {
    const { main, resolved, pinned } = legacy.sidebarOrder;
    sanitized.sidebarOrder = { main: boundedList(main), resolved: boundedList(resolved), pinned: boundedList(pinned) };
  }
  if (legacy.recentModels) {
    const recentModels: NonNullable<LegacyPreferences["recentModels"]> = {};
    for (const driver of DRIVERS) {
      const models = boundedList(legacy.recentModels[driver] ?? []);
      if (models.length > 0) recentModels[driver] = models;
    }
    sanitized.recentModels = recentModels;
  }
  return sanitized;
}

async function importWithSanitizedRetry(api: Pick<CwApi, "importLegacyPrefs">, legacy: LegacyPreferences): Promise<void> {
  try {
    await api.importLegacyPrefs(legacy);
  } catch (err) {
    console.warn("[cw-code] legacy preference import was rejected; retrying with sanitized values", err);
    await api.importLegacyPrefs(sanitizeLegacyPreferences(legacy));
  }
}

export async function migrateLegacyPreferences(api: Pick<CwApi, "importLegacyPrefs">): Promise<void> {
  const storage = window.localStorage;
  try {
    if (storage.getItem(MIGRATED_KEY) !== null) return;
    await importWithSanitizedRetry(api, readLegacyPreferences(storage));
    removeMigratedKeys(storage);
    storage.setItem(MIGRATED_KEY, "1");
  } catch (err) {
    console.warn("[cw-code] legacy preference migration failed; will retry on next start", err);
  }
}
