import { shortenHome } from "./pathDisplay.js";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

const cache = new Map<string, Promise<string>>();

export interface ImageTarget {
  sessionId?: string;
  projectId?: string;
}

export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

export function displayImagePath(path: string, homeDir?: string): string {
  return shortenHome(path, homeDir);
}

export function imageDataUrl(target: ImageTarget, path: string): Promise<string> {
  const key = `${target.sessionId ?? ""}|${target.projectId ?? ""}|${path}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = window.cw
    .readImage({ ...target, path })
    .then((img) => `data:${img.mime};base64,${img.base64}`);
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

export type MessageSegment = { kind: "text"; value: string } | { kind: "image"; path: string };

export function splitImageMentions(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) {
      segments.push({ kind: "text", value: lines.join("\n") });
      lines = [];
    }
  };
  for (const line of text.split("\n")) {
    const match = line.match(/^@(\S+\.(?:png|jpe?g|webp|gif))\s*$/i);
    if (match && isImagePath(match[1])) {
      flush();
      segments.push({ kind: "image", path: match[1] });
      continue;
    }
    lines.push(line);
  }
  flush();
  if (segments.length === 0) segments.push({ kind: "text", value: "" });
  return segments;
}
