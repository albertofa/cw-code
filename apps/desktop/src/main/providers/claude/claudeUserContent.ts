import { readFileSync } from "node:fs";
import { join } from "node:path";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
};

export function buildClaudeUserContent(cwd: string, prompt: string, attachments: string[] | undefined): string | unknown[] {
  const blocks: unknown[] = [];
  if (prompt.trim()) {
    blocks.push({ type: "text", text: prompt });
  }
  for (const rel of attachments ?? []) {
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) continue;
    try {
      const data = readFileSync(join(cwd, rel));
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: data.toString("base64") }
      });
    } catch {
      console.warn(`image attachment unreadable, skipped: ${rel}`);
    }
  }
  if (blocks.length === 1 && blocks[0] && (blocks[0] as { type: string }).type === "text") {
    return prompt;
  }
  if (blocks.length === 0) return prompt;
  return blocks;
}
