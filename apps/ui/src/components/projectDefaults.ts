import type { ComposerPrefs, DriverName, ProjectSettings } from "../cw.js";

export function projectDriver(settings: ProjectSettings | undefined, fallback: DriverName): DriverName {
  return settings?.defaultDriver ?? fallback;
}

export function withProjectPrefs(prefs: ComposerPrefs, settings: ProjectSettings | undefined, driver: DriverName, driverChanged: boolean): ComposerPrefs {
  const projectModel = settings?.defaultDriver === driver ? settings.defaultModel : undefined;
  return {
    ...prefs,
    model: projectModel ?? (driverChanged ? undefined : prefs.model),
    ...(settings?.defaultEffort ? { effort: settings.defaultEffort } : {}),
    ...(settings?.defaultPermissionMode ? { permissionMode: settings.defaultPermissionMode } : {})
  };
}
