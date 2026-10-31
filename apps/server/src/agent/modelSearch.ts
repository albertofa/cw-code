import type { DriverKind, EffortLevel, ModelOption } from "@cw-code/contracts";

export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
export const MODEL_MATCH_LIMIT = 10;

const HARNESS_WORDS: readonly DriverKind[] = ["claude", "codex", "opencode"];
const XHIGH_PREFIXES: ReadonlySet<string> = new Set(["x", "extra"]);

export interface ModelQuery {
  terms: string[];
  harnesses: DriverKind[];
  effort?: EffortLevel;
}

export function modelSearchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function harnessOf(token: string): DriverKind | undefined {
  return HARNESS_WORDS.find((harness) => harness === token);
}

export function parseModelQuery(query: string): ModelQuery {
  const tokens = modelSearchTokens(query);
  const terms: string[] = [];
  const harnesses: DriverKind[] = [];
  let effort: EffortLevel | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (XHIGH_PREFIXES.has(token) && tokens[index + 1] === "high") {
      effort = "xhigh";
      index += 1;
      continue;
    }
    const level = EFFORT_LEVELS.find((candidate) => candidate === token);
    if (level !== undefined) {
      effort = level;
      continue;
    }
    const harness = harnessOf(token);
    if (harness !== undefined && !harnesses.includes(harness)) harnesses.push(harness);
    terms.push(token);
  }
  return { terms, harnesses, ...(effort !== undefined ? { effort } : {}) };
}

const PREFIX = 1;
const SUBSTRING = 2;

function termMatch(term: string, tokens: readonly string[]): number | null {
  if (/^\d+$/.test(term)) return tokens.includes(term) ? PREFIX : null;
  if (tokens.some((token) => token.startsWith(term))) return PREFIX;
  return tokens.some((token) => token.includes(term)) ? SUBSTRING : null;
}

interface Scored<T> {
  model: T;
  tier: number;
  harnessHits: number;
  index: number;
}

function scoreModel<T extends Pick<ModelOption, "id" | "label">>(model: T, index: number, query: ModelQuery): Scored<T> | null {
  const idTokens = modelSearchTokens(model.id);
  const labelTokens = modelSearchTokens(model.label);
  const tokens = [...idTokens, ...labelTokens];
  const required = query.terms.filter((term) => harnessOf(term) === undefined);
  let tier = PREFIX;
  for (const term of required) {
    const match = termMatch(term, tokens);
    if (match === null) return null;
    tier = Math.max(tier, match);
  }
  const harnessHits = query.terms.filter((term) => harnessOf(term) !== undefined && termMatch(term, tokens) !== null).length;
  const phrases = new Set([query.terms.join(" "), required.join(" ")]);
  const names = [idTokens, labelTokens, modelSearchTokens(model.id.split("/").at(-1) ?? "")].map((name) => name.join(" "));
  if (names.some((name) => phrases.has(name))) tier = 0;
  return { model, tier, harnessHits, index };
}

export function rankModelMatches<T extends Pick<ModelOption, "id" | "label">>(models: readonly T[], query: string): T[] {
  const parsed = parseModelQuery(query);
  return models
    .map((model, index) => scoreModel(model, index, parsed))
    .filter((scored): scored is Scored<T> => scored !== null)
    .sort((a, b) => a.tier - b.tier || b.harnessHits - a.harnessHits || a.index - b.index)
    .slice(0, MODEL_MATCH_LIMIT)
    .map((scored) => scored.model);
}
