import { join } from "node:path";

export const ZOOM_FILE = "window-zoom.json";
export const ZOOM_MIN = -5;
export const ZOOM_MAX = 5;

export interface ZoomFs {
  read(path: string): string | null;
  write(path: string, data: string): void;
}

/**
 * Next level for a shortcut step, kept inside the shortcut range. A level already outside it
 * (set through the default menu roles) never moves against the direction of the step.
 */
export function stepZoom(current: number, delta: number): number {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current + delta));
  return delta >= 0 ? Math.max(current, next) : Math.min(current, next);
}

export function parseZoom(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const level = (JSON.parse(raw) as { level?: unknown } | null)?.level;
    return typeof level === "number" && Number.isFinite(level) ? level : null;
  } catch {
    return null;
  }
}

/**
 * Chromium keeps the zoom of a `file://` page under its full path, and an AppImage mounts at
 * a new random path on every launch, so the shell stores the level itself.
 */
export class ZoomStore {
  private readonly path: string;
  private loaded = false;
  private saved: number | null = null;

  constructor(
    userDataDir: string,
    private readonly fs: ZoomFs,
    private readonly warn: (message: string) => void = () => {}
  ) {
    this.path = join(userDataDir, ZOOM_FILE);
  }

  /** The stored level, or null when none was ever saved or the file cannot be read. */
  get level(): number | null {
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.saved = parseZoom(this.fs.read(this.path));
      } catch (error) {
        this.warn(`zoom level not read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.saved;
  }

  save(level: number): void {
    if (!Number.isFinite(level) || level === this.level) return;
    this.saved = level;
    this.fs.write(this.path, `${JSON.stringify({ level })}\n`);
  }
}
