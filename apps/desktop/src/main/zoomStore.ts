import { join } from "node:path";

export const ZOOM_FILE = "window-zoom.json";
export const ZOOM_MIN = -5;
export const ZOOM_MAX = 5;

export interface ZoomFs {
  read(path: string): string | null;
  write(path: string, data: string): void;
}

export function clampZoom(level: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
}

export function parseZoom(raw: string | null): number {
  if (raw === null) return 0;
  try {
    const level = (JSON.parse(raw) as { level?: unknown } | null)?.level;
    return typeof level === "number" && Number.isFinite(level) ? clampZoom(level) : 0;
  } catch {
    return 0;
  }
}

/**
 * Chromium keeps the zoom of a `file://` page under its full path, and an AppImage mounts at
 * a new random path on every launch, so the shell stores the level itself.
 */
export class ZoomStore {
  private readonly path: string;
  private saved: number | null = null;

  constructor(
    userDataDir: string,
    private readonly fs: ZoomFs
  ) {
    this.path = join(userDataDir, ZOOM_FILE);
  }

  get level(): number {
    this.saved ??= parseZoom(this.fs.read(this.path));
    return this.saved;
  }

  save(level: number): void {
    const next = clampZoom(level);
    if (next === this.level) return;
    this.saved = next;
    this.fs.write(this.path, `${JSON.stringify({ level: next })}\n`);
  }
}
