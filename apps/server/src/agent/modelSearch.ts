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

function effortOf(token: string): EffortLevel | undefined {
  return EFFORT_LEVELS.find((level) => level === token);
}

export function parseModelQuery(query: string): ModelQuery {
  const tokens = query
    .split(/\s+/)
    .flatMap((chunk) => modelSearchTokens(chunk).map((text) => ({ text, inModelPath: chunk.includes("/") })));
  const terms: string[] = [];
  const harnesses: DriverKind[] = [];
  let effort: EffortLevel | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (XHIGH_PREFIXES.has(token.text) && tokens[index + 1]?.text === "high") {
      effort = "xhigh";
      index += 1;
      continue;
    }
    effort = effortOf(token.text) ?? effort;
    const harness = harnessOf(token.text);
    if (harness !== undefined && !token.inModelPath && !harnesses.includes(harness)) harnesses.push(harness);
    terms.push(token.text);
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

function isOptionalTerm(term: string): boolean {
  return harnessOf(term) !== undefined || effortOf(term) !== undefined;
}

function inOrder(needles: readonly string[], haystack: readonly string[]): boolean {
  let position = 0;
  for (const token of haystack) {
    if (token === needles[position]) position += 1;
  }
  return position === needles.length;
}

interface Scored<T> {
  model: T;
  tier: number;
  ordered: boolean;
  optionalHits: number;
  index: number;
}

function scoreModel<T extends Pick<ModelOption, "id" | "label">>(model: T, index: number, terms: readonly string[]): Scored<T> | null {
  const idTokens = modelSearchTokens(model.id);
  const labelTokens = modelSearchTokens(model.label);
  const tokens = [...idTokens, ...labelTokens];
  const required = terms.filter((term) => !isOptionalTerm(term));
  let tier = PREFIX;
  for (const term of required) {
    const match = termMatch(term, tokens);
    if (match === null) return null;
    tier = Math.max(tier, match);
  }
  const optionalHits = terms.filter((term) => isOptionalTerm(term) && termMatch(term, tokens) !== null).length;
  const phrases = new Set(
    [
      terms,
      required,
      terms.filter((term) => effortOf(term) === undefined),
      terms.filter((term) => harnessOf(term) === undefined)
    ].map((phrase) => phrase.join(" "))
  );
  const names = [idTokens, labelTokens, modelSearchTokens(model.id.split("/").at(-1) ?? "")].map((name) => name.join(" "));
  if (names.some((name) => phrases.has(name))) tier = 0;
  const digits = required.filter((term) => /^\d+$/.test(term));
  const ordered = inOrder(digits, idTokens) || inOrder(digits, labelTokens);
  return { model, tier, ordered, optionalHits, index };
}

export function rankModelMatches<T extends Pick<ModelOption, "id" | "label">>(models: readonly T[], query: string): T[] {
  const { terms } = parseModelQuery(query);
  return models
    .map((model, index) => scoreModel(model, index, terms))
    .filter((scored): scored is Scored<T> => scored !== null)
    .sort((a, b) => a.tier - b.tier || Number(b.ordered) - Number(a.ordered) || b.optionalHits - a.optionalHits || a.index - b.index)
    .slice(0, MODEL_MATCH_LIMIT)
    .map((scored) => scored.model);
}
