import {
  KIND_VALUES,
  ME,
  QUALIFIER_RE,
  definitionOf,
  qualifiersFor,
  quoteIfNeeded,
  tokenize,
  uniqueBy,
  type QualifierDef,
  type QueryToken
} from "@cw-code/shared/githubQueryDsl";
import type { GitHubKind } from "../cw.js";

export interface SuggestionSource {
  viewer: string | null;
  people: string[];
  repos: string[];
  orgs: string[];
  labels: string[];
  milestones: string[];
  workflows: string[];
  branches: string[];
}

export interface AutocompleteItem {
  kind: "key" | "value" | "exclude";
  key: string;
  neg: boolean;
  value?: string;
  label: string;
  description: string;
  local: boolean;
  avatarLogin?: string;
  labelColor?: string;
}

export interface AutocompleteResult {
  tokenStart: number;
  tokenEnd: number;
  heading: string | null;
  items: AutocompleteItem[];
  empty: string | null;
  invalid: boolean;
}

const KIND_NOUN: Record<GitHubKind, string> = { pr: "pull requests", issue: "issues", run: "workflow runs" };

function queryLogin(login: string): string {
  return login.endsWith("[bot]") ? `app/${login.slice(0, -"[bot]".length)}` : login;
}

function hueOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function labelColorOf(label: string): string {
  return `hsl(${hueOf(label)},55%,58%)`;
}

interface ValueOption {
  value: string;
  description: string;
  local?: boolean;
  avatarLogin?: string;
  labelColor?: string;
}

function peopleOptions(source: SuggestionSource): ValueOption[] {
  const viewer = source.viewer;
  const others = uniqueBy(
    source.people.filter((login) => login && login.toLowerCase() !== viewer?.toLowerCase()),
    (login) => login,
  ).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const me: ValueOption = { value: ME, description: "you", ...(viewer ? { avatarLogin: viewer } : {}) };
  return [
    me,
    ...others.map((login) => ({
      value: queryLogin(login),
      description: login.endsWith("[bot]") ? "app" : "",
      avatarLogin: login,
    })),
  ];
}

function plainOptions(values: string[]): ValueOption[] {
  return uniqueBy(values.filter(Boolean), (v) => v)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((value) => ({ value, description: "" }));
}

function valueOptions(def: QualifierDef, source: SuggestionSource): ValueOption[] {
  if (def.enumValues) {
    return def.enumValues.map((o) => ({
      value: o.value,
      description: o.description,
      local: o.local ?? def.local,
      ...(o.value === ME && source.viewer ? { avatarLogin: source.viewer } : {}),
    }));
  }
  switch (def.valueSource) {
    case "people":
      return peopleOptions(source);
    case "repo":
      return plainOptions(source.repos);
    case "org":
      return plainOptions(source.orgs);
    case "label":
      return plainOptions(source.labels).map((o) => ({ ...o, labelColor: labelColorOf(o.value) }));
    case "milestone":
      return plainOptions(source.milestones);
    case "workflow":
      return plainOptions(source.workflows);
    case "branch":
      return plainOptions(source.branches);
    default:
      return [];
  }
}

function tokenAtCaret(q: string, caret: number): QueryToken {
  const found = tokenize(q).find((t) => t.kind !== "space" && t.start < caret && caret <= t.end);
  return found ?? { kind: "text", text: "", start: caret, end: caret, value: "" };
}

export function autocomplete(kind: GitHubKind, q: string, caret: number, source: SuggestionSource): AutocompleteResult {
  const token = tokenAtCaret(q, caret);
  const typed = q.slice(token.start, caret);
  const qualifier = QUALIFIER_RE.exec(typed);
  const editsKeyOnly = !qualifier && token.kind === "qual";
  const keyEnd = token.start + (token.neg ? 1 : 0) + (token.rawKey?.length ?? 0) + 1;
  const base = { tokenStart: token.start, tokenEnd: editsKeyOnly ? keyEnd : token.end };

  if (qualifier) {
    const neg = qualifier[1] === "-";
    const key = qualifier[2].toLowerCase();
    const partial = qualifier[3].replace(/^"/, "").toLowerCase();
    const def = definitionOf(kind, key);
    if (!def) {
      return { ...base, heading: null, items: [], empty: `Unknown qualifier “${key}:” for ${KIND_NOUN[kind]}`, invalid: true };
    }
    const items: AutocompleteItem[] = [];
    if (def.excludeLabel && !neg && !partial) {
      items.push({ kind: "exclude", key, neg: false, label: def.excludeLabel, description: "", local: false });
    }
    for (const option of valueOptions(def, source)) {
      if (!option.value.toLowerCase().includes(partial)) continue;
      items.push({
        kind: "value",
        key,
        neg,
        value: option.value,
        label: option.value,
        description: option.description,
        local: option.local ?? false,
        ...(option.avatarLogin ? { avatarLogin: option.avatarLogin } : {}),
        ...(option.labelColor ? { labelColor: option.labelColor } : {}),
      });
    }
    const empty = items.length > 0 ? null : partial ? `No values match “${partial}”` : `No suggestions for ${key}:`;
    return { ...base, heading: `${neg ? "exclude " : ""}${key}`, items, empty, invalid: false };
  }

  const neg = typed.startsWith("-");
  const partial = typed.replace(/^-/, "").toLowerCase();
  const items: AutocompleteItem[] = qualifiersFor(kind)
    .filter((def) => def.key.startsWith(partial))
    .map((def) => ({
      kind: "key" as const,
      key: def.key,
      neg,
      label: `${neg ? "-" : ""}${def.key}:`,
      description: def.description,
      local: def.local,
    }));
  if (partial && items.length === 0) {
    return { ...base, heading: null, items, empty: `Searching titles for “${typed}”`, invalid: false };
  }
  return { ...base, heading: partial ? null : "Qualifiers", items, empty: null, invalid: false };
}

export function applyAutocomplete(
  q: string,
  result: AutocompleteResult,
  item: AutocompleteItem,
  currentKind: GitHubKind,
): { query: string; caret: number; reopen: boolean; switchKind: GitHubKind | null } {
  const before = q.slice(0, result.tokenStart);
  const after = q.slice(result.tokenEnd);
  const prefix = item.neg ? "-" : "";
  let replacement: string;
  let reopen = false;
  const gluesToNext = result.tokenStart === result.tokenEnd && after !== "" && !/^\s/.test(after);
  if (item.kind === "key") {
    replacement = `${prefix}${item.key}:`;
    reopen = true;
  } else if (item.kind === "exclude") {
    replacement = `-${item.key}:`;
    reopen = true;
  } else {
    const trailing = /^\s/.test(after) ? "" : " ";
    replacement = `${prefix}${item.key}:${quoteIfNeeded(item.value ?? "")}${trailing}`;
  }
  const value = item.value ?? "";
  const switchKind =
    item.kind === "value" && item.key === "is" && !item.neg && KIND_VALUES.has(value) && value !== currentKind
      ? (value as GitHubKind)
      : null;
  const separator = reopen && gluesToNext ? " " : "";
  return {
    query: before + replacement + separator + after,
    caret: (before + replacement).length,
    reopen: reopen && switchKind === null,
    switchKind,
  };
}
