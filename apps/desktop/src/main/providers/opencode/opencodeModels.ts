import { execFile } from "node:child_process";
import type { EffortLevel, ModelOption } from "@cw-code/contracts";
import { traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

export const OPENCODE_CURATED_MODELS: ModelOption[] = [
  { id: "anthropic/claude-sonnet-4-5", label: "Sonnet 4.5", source: "curated" },
  { id: "anthropic/claude-opus-5", label: "Opus 5", source: "curated" },
  { id: "anthropic/claude-haiku-4-5", label: "Haiku 4.5", source: "curated" },
  { id: "openai/gpt-5.2", label: "GPT 5.2", source: "curated" }
];

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; models: ModelOption[] }>();

const LABEL_ACRONYMS = new Set(["gpt", "llm", "ai", "api", "mcp", "ocr", "tts"]);

export function prettyModelLabel(id: string): string {
  const slash = id.lastIndexOf("/");
  const raw = slash >= 0 ? id.slice(slash + 1) : id;
  const words = raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => {
      const low = w.toLowerCase();
      if (LABEL_ACRONYMS.has(low)) return low.toUpperCase();
      if (/^\d/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
  return words.join(" ").replace(/(\b\d) (\d\b)/g, "$1.$2");
}

export function labelForModel(id: string): string {
  const curated = OPENCODE_CURATED_MODELS.find((m) => m.id.toLowerCase() === id.toLowerCase());
  if (curated) return curated.label;
  return prettyModelLabel(id);
}

export function parseOpencodeModels(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([a-z0-9][a-z0-9-_]*)\/(\S+)$/i);
    if (!match) continue;
    const id = `${match[1]}/${match[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: labelForModel(id), source: "live" });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function mapEffortToVariant(effort: EffortLevel | string): string {
  if (effort === "low") return "minimal";
  if (effort === "medium") return "balanced";
  if (effort === "high") return "high";
  if (effort === "xhigh") return "xhigh";
  if (effort === "max") return "max";
  return "balanced";
}

function queryModels(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["models"], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

export async function listOpencodeModels(cwd: string, binary: string): Promise<ModelOption[]> {
  const key = process.platform === "win32"
    ? `${binary.toLowerCase()}\0${cwd.toLowerCase()}`
    : `${binary}\0${cwd}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.listModels",
      cwd,
      binary,
      ok: true,
      extra: { cached: true, count: hit.models.length }
    });
    return hit.models;
  }
  const start = Date.now();
  try {
    const stdout = await queryModels(binary);
    const parsed = parseOpencodeModels(stdout);
    const models = parsed.length > 0 ? parsed : OPENCODE_CURATED_MODELS;
    cache.set(key, { at: Date.now(), models });
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.listModels",
      cwd,
      binary,
      args: ["models"],
      durationMs: Date.now() - start,
      ok: true,
      extra: { count: models.length, source: parsed.length > 0 ? "live" : "curated" }
    });
    return models;
  } catch (err) {
    console.warn(`opencode models failed: ${(err as Error).message}`);
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.listModels",
      cwd,
      binary,
      args: ["models"],
      durationMs: Date.now() - start,
      ok: false,
      error: truncateError((err as Error).message),
      extra: { fallback: "curated" }
    });
    return OPENCODE_CURATED_MODELS;
  }
}

export function clearOpencodeModelsCache(): void {
  cache.clear();
}
