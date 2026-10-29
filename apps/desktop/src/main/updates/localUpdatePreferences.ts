import { join } from "node:path";
import type { AppSettings } from "@cw-code/contracts";
import { isUpdateChannel } from "./updateState.js";

export const UPDATE_PREFERENCES_FILE = "update-preferences.json";

export type StoredUpdatePreferences = Pick<AppSettings, "updateChannel" | "updateBackgroundDownload">;

export const DEFAULT_UPDATE_PREFERENCES: StoredUpdatePreferences = { updateChannel: null, updateBackgroundDownload: true };

export interface UpdatePreferencesFs {
  read(path: string): string | null;
  write(path: string, data: string): void;
}

export function parseUpdatePreferences(text: string | null): StoredUpdatePreferences {
  if (text === null) return DEFAULT_UPDATE_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return DEFAULT_UPDATE_PREFERENCES;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_UPDATE_PREFERENCES;
  const record = parsed as Record<string, unknown>;
  return {
    updateChannel: isUpdateChannel(record.updateChannel) ? record.updateChannel : null,
    updateBackgroundDownload:
      typeof record.updateBackgroundDownload === "boolean" ? record.updateBackgroundDownload : DEFAULT_UPDATE_PREFERENCES.updateBackgroundDownload
  };
}

export class LocalUpdatePreferences {
  private readonly path: string;
  private current: StoredUpdatePreferences | null = null;

  constructor(
    userDataDir: string,
    private readonly fs: UpdatePreferencesFs
  ) {
    this.path = join(userDataDir, UPDATE_PREFERENCES_FILE);
  }

  get(): StoredUpdatePreferences {
    if (!this.current) {
      try {
        this.current = parseUpdatePreferences(this.fs.read(this.path));
      } catch (error) {
        console.warn(`[updates] could not read ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
        this.current = DEFAULT_UPDATE_PREFERENCES;
      }
    }
    return this.current;
  }

  set(patch: Partial<StoredUpdatePreferences>): StoredUpdatePreferences {
    const next = { ...this.get(), ...patch };
    this.fs.write(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.current = next;
    return next;
  }
}
