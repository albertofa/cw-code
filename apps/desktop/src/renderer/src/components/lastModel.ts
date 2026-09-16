import type { DriverName, ModelOption } from "../cw.js";

export function getLastModel(driver: DriverName): string | null {
  try {
    return window.localStorage.getItem(`cw:lastModel:${driver}`);
  } catch {
    return null;
  }
}

export function setLastModel(driver: DriverName, id: string): void {
  try {
    window.localStorage.setItem(`cw:lastModel:${driver}`, id);
  } catch {
  }
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
