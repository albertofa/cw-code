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
    if (line.startsWith("{") || line.startsWith("}")) continue;
    const match = line.match(/^([a-z0-9][a-z0-9-_]*)\/(\S+)$/i);
    if (!match) continue;
    const id = `${match[1]}/${match[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: labelForModel(id), source: "live" });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const MODEL_ID_LINE_RE = /^([a-z0-9][a-z0-9-_]*\/\S+)$/i;

export function parseOpencodeVerboseModels(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  const lines = stdout.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const idMatch = MODEL_ID_LINE_RE.exec(line);
    if (!idMatch) {
      i += 1;
      continue;
    }
    const id = idMatch[1];
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;
    if (j >= lines.length || !lines[j].trimStart().startsWith("{")) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, label: labelForModel(id), source: "live" });
      }
      i = j;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let k = j; k < lines.length; k += 1) {
      for (const ch of lines[k]) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      if (depth === 0) {
        end = k;
        break;
      }
      if (depth < 0) break;
    }
    if (end === -1) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, label: labelForModel(id), source: "live" });
      }
      i = j + 1;
      continue;
    }
    let variants: string[] | undefined;
    try {
      const parsed = JSON.parse(lines.slice(j, end + 1).join("\n")) as { variants?: unknown };
      if (parsed.variants && typeof parsed.variants === "object" && !Array.isArray(parsed.variants)) {
        variants = Object.keys(parsed.variants as Record<string, unknown>);
      } else if (Array.isArray(parsed.variants)) {
        variants = (parsed.variants as unknown[])
          .map((v) => (typeof v === "string" ? v : (v as { id?: unknown }).id))
          .filter((v): v is string => typeof v === "string" && v.length > 0);
      }
    } catch {
      variants = undefined;
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push({
        id,
        label: labelForModel(id),
        source: "live",
        ...(variants !== undefined ? { variants } : {})
      });
    }
    i = end + 1;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const EFFORT_RANK = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function normalizeEffort(effort: string): string {
  const low = effort.trim().toLowerCase();
  if (low === "balanced") return "medium";
  return low;
}

function rankOf(variant: string): number {
  return EFFORT_RANK.indexOf(variant.trim().toLowerCase() as (typeof EFFORT_RANK)[number]);
}

function nearestRankedVariant(desired: string, available: string[]): string | undefined {
  const ranked = available
    .map((v) => ({ original: v, rank: rankOf(v) }))
    .filter((v) => v.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0) return undefined;
  const want = rankOf(desired);
  if (want < 0) return undefined;
  if (want <= ranked[0].rank) return ranked[0].original;
  if (want >= ranked[ranked.length - 1].rank) return ranked[ranked.length - 1].original;
  let best = ranked[0];
  for (const candidate of ranked) {
    if (Math.abs(candidate.rank - want) < Math.abs(best.rank - want)) best = candidate;
  }
  return best.original;
}

export function mapEffortToVariant(effort: EffortLevel | string, availableVariants?: string[]): string | undefined {
  const desired = normalizeEffort(effort);
  if (!desired) return undefined;
  if (availableVariants !== undefined) {
    const match = availableVariants.find((v) => v.toLowerCase() === desired);
    if (match) return match;
    return nearestRankedVariant(desired, availableVariants);
  }
  if ((EFFORT_RANK as readonly string[]).includes(desired)) return desired;
  return undefined;
}

export function resolveOpencodeVariant(
  modelVariants: string[] | undefined,
  effort: EffortLevel | string | undefined,
  explicitVariant?: string
): string | undefined {
  if (explicitVariant?.trim()) {
    if (modelVariants === undefined) return explicitVariant;
    const match = modelVariants.find((v) => v.toLowerCase() === explicitVariant.trim().toLowerCase());
    if (match) return match;
  }
  if (!effort) return undefined;
  return mapEffortToVariant(effort, modelVariants);
}

function queryModels(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
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
    let parsed: ModelOption[] = [];
    try {
      parsed = parseOpencodeVerboseModels(await queryModels(binary, ["models", "--verbose"]));
    } catch {
      parsed = [];
    }
    if (parsed.length === 0) {
      parsed = parseOpencodeModels(await queryModels(binary, ["models"]));
    }
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
