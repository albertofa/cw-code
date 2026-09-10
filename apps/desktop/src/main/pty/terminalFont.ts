import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fontFace(profile: unknown): string | null {
  if (!isRecord(profile)) return null;
  const font = profile["font"];
  if (!isRecord(font)) return null;
  const face = font["face"];
  return typeof face === "string" && face.trim() ? face.trim() : null;
}

export function extractTerminalFontFace(settings: unknown): string | null {
  if (!isRecord(settings)) return null;
  const profiles = settings["profiles"];
  if (!isRecord(profiles)) return null;

  const fromDefaults = fontFace(profiles["defaults"]);
  if (fromDefaults) return fromDefaults;

  const list = profiles["list"];
  if (!Array.isArray(list)) return null;

  const defaultProfile = profiles["defaultProfile"];
  if (typeof defaultProfile === "string") {
    const match = list.find(
      (p) => isRecord(p) && (p["guid"] === defaultProfile || p["name"] === defaultProfile)
    );
    const face = match ? fontFace(match) : null;
    if (face) return face;
  }

  for (const p of list) {
    const face = fontFace(p);
    if (face) return face;
  }
  return null;
}

export function readWindowsTerminalFontFace(localAppData?: string): string | null {
  if (process.platform !== "win32") return null;
  const base = localAppData ?? process.env["LOCALAPPDATA"];
  if (!base) return null;
  const candidates = [
    join(base, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(base, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(base, "Microsoft", "Windows Terminal", "settings.json")
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const face = extractTerminalFontFace(JSON.parse(readFileSync(file, "utf8")));
      if (face) return face;
    } catch {
      continue;
    }
  }
  return null;
}
