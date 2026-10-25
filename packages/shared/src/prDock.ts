import type { PrDockEntry } from "@cw-code/contracts";
import { prRefLabel } from "./prRef.js";

export function combinedPrompt(entries: Pick<PrDockEntry, "ref" | "prompt">[]): string | null {
  if (entries.length === 0) return null;
  return entries.map((entry) => `## ${prRefLabel(entry.ref)}\n\n${entry.prompt ?? ""}`).join("\n\n");
}
