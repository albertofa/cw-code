import { normalize } from "node:path";
import type { AppSettings, ModelOption } from "@cw-code/contracts";

export type CliBinary = "claude" | "opencode" | "codex";

export function defaultCliBinaryPath(binary: CliBinary, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${binary}.exe` : binary;
}

export function configuredCliBinaryPath(
  binary: CliBinary,
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  return normalizeBinaryPath(value) || defaultCliBinaryPath(binary, platform);
}

export function normalizeBinaryPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  if (trimmed.includes("/") || trimmed.includes("\\")) return normalize(trimmed);
  return trimmed;
}

export function parseExtraArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  const push = (): void => {
    if (current) {
      args.push(current);
      current = "";
    }
  };
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      current += ch;
    }
  }
  push();
  return args;
}

export function resolveClaudeModels(
  settings: Pick<AppSettings, "claudeEnabledModels" | "claudeCustomModel">,
  curated: { id: string; label: string }[]
): ModelOption[] {
  const enabled = new Set(
    (settings.claudeEnabledModels ?? []).map((id) => id.trim()).filter(Boolean)
  );
  const resolved: ModelOption[] = [];
  for (const entry of curated) {
    if (enabled.has(entry.id)) resolved.push({ id: entry.id, label: entry.label, source: "curated" });
  }
  const customId = (settings.claudeCustomModel?.id ?? "").trim();
  const customName = (settings.claudeCustomModel?.name ?? "").trim();
  if (customId && !resolved.some((m) => m.id === customId)) {
    resolved.push({ id: customId, label: customName || customId, source: "custom" });
  }
  return resolved;
}
