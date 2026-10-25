import type { GitHubKind } from "@cw-code/contracts";
import { MAX_QUERY_LENGTH } from "./githubViews.js";

export const APP_TOPIC = "app";
export const SIDEBAR_TOPIC = "sidebar";
export const PRS_TOPIC = "prs";
export const USAGE_TOPIC = "usage";
export const GITHUB_RUNS_TOPIC = "github/runs";
export const GITHUB_META_TOPIC = "github/meta";
export const MAX_TOPICS_PER_CALL = 1000;
export const MAX_TOPICS_PER_CLIENT = 5000;

export type TopicPrefix = "session/" | "git/" | "files/" | "pty/" | "github/";

const EXACT_TOPICS: ReadonlySet<string> = new Set([APP_TOPIC, SIDEBAR_TOPIC, PRS_TOPIC, USAGE_TOPIC]);
const PREFIXES: readonly TopicPrefix[] = ["session/", "git/", "files/", "pty/", "github/"];
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const GITHUB_VIEW_PATTERN = /^[a-z0-9-]{1,64}$/;
const GITHUB_VIEW_PREFIX = "github/view:";
const GITHUB_KINDS: Record<GitHubKind, true> = { pr: true, issue: true, run: true };
const ENCODED_QUERY_PATTERN = /^[A-Za-z0-9_.!~*()%'-]*$/;
const MAX_ENCODED_CHARS_PER_QUERY_CHAR = 9;
const MAX_ENCODED_QUERY_LENGTH = MAX_QUERY_LENGTH * MAX_ENCODED_CHARS_PER_QUERY_CHAR;

export function sessionTopic(sessionId: string): string {
  return `session/${sessionId}`;
}

export function gitTopic(sessionId: string): string {
  return `git/${sessionId}`;
}

export function filesTopic(sessionId: string): string {
  return `files/${sessionId}`;
}

export function ptyTopic(ptyId: string): string {
  return `pty/${ptyId}`;
}

export function topicId(topic: string, prefix: TopicPrefix): string | null {
  if (!topic.startsWith(prefix)) return null;
  const id = topic.slice(prefix.length);
  return id.length > 0 ? id : null;
}

export function topicSessionId(topic: string, prefix: "session/" | "git/" | "files/"): string | null {
  return topicId(topic, prefix);
}

export function githubViewTopic(kind: GitHubKind, query: string): string {
  return `${GITHUB_VIEW_PREFIX}${kind}:${encodeURIComponent(query)}`;
}

export function parseGithubViewTopic(topic: string): { kind: GitHubKind; query: string } | null {
  if (!topic.startsWith(GITHUB_VIEW_PREFIX)) return null;
  const rest = topic.slice(GITHUB_VIEW_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  const kind = rest.slice(0, separator);
  const encoded = rest.slice(separator + 1);
  if (!Object.hasOwn(GITHUB_KINDS, kind)) return null;
  if (encoded.length > MAX_ENCODED_QUERY_LENGTH || !ENCODED_QUERY_PATTERN.test(encoded)) return null;
  try {
    return { kind: kind as GitHubKind, query: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

export function isValidTopic(topic: unknown): topic is string {
  if (typeof topic !== "string") return false;
  if (EXACT_TOPICS.has(topic)) return true;
  if (topic.startsWith(GITHUB_VIEW_PREFIX)) return parseGithubViewTopic(topic) !== null;
  for (const prefix of PREFIXES) {
    const id = topicId(topic, prefix);
    if (id === null) continue;
    return (prefix === "github/" ? GITHUB_VIEW_PATTERN : ID_PATTERN).test(id);
  }
  return false;
}
