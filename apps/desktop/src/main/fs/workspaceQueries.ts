import { spawn } from "node:child_process";
import type { GitDecorations, GitFileDecoration, GitFileState, TextSearchMatch, TextSearchQuery, TextSearchResult, GitBaseline } from "@cw-code/contracts";
import { sanitizedChildEnv } from "../shellEnvironment.js";
import { execWithStatus } from "./GitService.js";

const DECORATIONS_TIMEOUT_MS = 15_000;
const BASELINE_TIMEOUT_MS = 15_000;
const LIST_FILES_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_LISTED_FILES = 50_000;
const DEFAULT_MAX_RESULTS = 2000;
const DEFAULT_PREVIEW_MAX = 400;
export const MAX_MATCH_SCAN_CHARS = 4096;
const PREVIEW_LEAD_CHARS = 40;
const MAX_STDERR_CHARS = 64 * 1024;
const PCRE_UNSUPPORTED = /PCRE|-P\b/;
const UNSAFE_GLOB_ERROR = "include/exclude patterns must be relative to the workspace";
const SEARCH_TIMEOUT_ERROR = "search timed out";

export interface GrepLine {
  path: string;
  line: number;
  text: string;
}

interface GrepRun {
  lines: GrepLine[];
  truncated: boolean;
  timedOut: boolean;
  code: number | null;
  stderr: string;
}

function readOnlyGit(args: string[]): string[] {
  return ["--no-optional-locks", ...args];
}

function nonInteractiveEnv(): NodeJS.ProcessEnv {
  const env = sanitizedChildEnv(process.env, process.platform);
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GCM_INTERACTIVE"] = "never";
  env["GIT_ASKPASS"] = "";
  env["SSH_ASKPASS"] = "";
  return env;
}

function nthSpaceIndex(record: string, count: number): number {
  let index = -1;
  for (let i = 0; i < count; i++) {
    index = record.indexOf(" ", index + 1);
    if (index < 0) return -1;
  }
  return index;
}

function stateFromXy(xy: string): GitFileState {
  if (xy.includes("U")) return "conflict";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("A")) return "added";
  return "modified";
}

function toDecoration(repoPath: string, state: GitFileState, prefix: string): GitFileDecoration | null {
  if (!repoPath.startsWith(prefix)) return null;
  const relative = repoPath.slice(prefix.length);
  const isDir = relative.endsWith("/");
  const path = isDir ? relative.slice(0, -1) : relative;
  if (!path) return null;
  return { path, state, isDir };
}

export function parseGitDecorations(stdout: string, prefix: string): GitFileDecoration[] {
  const records = stdout.split("\0");
  const entries: GitFileDecoration[] = [];
  const push = (repoPath: string, state: GitFileState): void => {
    const entry = toDecoration(repoPath, state, prefix);
    if (entry) entries.push(entry);
  };
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    const kind = record[0];
    if (kind === "?") push(record.slice(2), "untracked");
    else if (kind === "!") push(record.slice(2), "ignored");
    else if (kind === "1" || kind === "2" || kind === "u") {
      const pathStart = nthSpaceIndex(record, kind === "1" ? 8 : kind === "2" ? 9 : 10);
      if (pathStart < 0) continue;
      const state = kind === "u" ? "conflict" : stateFromXy(record.slice(2, 4));
      push(record.slice(pathStart + 1), state);
      if (kind === "2") i++;
    }
  }
  return entries;
}

export function buildStatusArgs(): string[] {
  return readOnlyGit(["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignored=matching"]);
}

export async function gitDecorations(git: string, root: string): Promise<GitDecorations> {
  let probe;
  try {
    probe = await execWithStatus(git, readOnlyGit(["rev-parse", "--is-inside-work-tree", "--show-prefix"]), root, DECORATIONS_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`could not run git to read workspace status: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [inside = "", showPrefix = ""] = probe.stdout.split("\n");
  if (probe.code !== 0 || inside.trim() !== "true") return { available: false, entries: [] };
  const status = await execWithStatus(git, buildStatusArgs(), root, DECORATIONS_TIMEOUT_MS);
  if (status.code !== 0) throw new Error(status.stderr.trim() || `git status exited with code ${status.code}`);
  return { available: true, entries: parseGitDecorations(status.stdout, showPrefix.trim()) };
}

export async function gitBaseline(git: string, root: string, path: string): Promise<GitBaseline> {
  const rel = path.replace(/\\/g, "/");
  const shown = await execWithStatus(git, readOnlyGit(["show", `HEAD:./${rel}`]), root, BASELINE_TIMEOUT_MS);
  if (shown.code === 0) return { kind: "tracked", content: shown.stdout.replace(/^\uFEFF/, "") };
  if (!(await isInsideWorkTree(git, root))) return { kind: "none" };
  const ignored = await execWithStatus(git, readOnlyGit(["check-ignore", "-q", "--", rel]), root, BASELINE_TIMEOUT_MS);
  return ignored.code === 0 ? { kind: "none" } : { kind: "untracked" };
}

export function parseNulList(stdout: string): string[] {
  return stdout.split("\0").filter((item) => item.length > 0);
}

async function listDeletedFiles(git: string, root: string): Promise<Set<string>> {
  try {
    const result = await execWithStatus(git, readOnlyGit(["ls-files", "-z", "--deleted"]), root, LIST_FILES_TIMEOUT_MS);
    return result.code === 0 ? new Set(parseNulList(result.stdout)) : new Set();
  } catch {
    return new Set();
  }
}

export async function listWorkspaceFiles(git: string, root: string, fallback: () => string[]): Promise<string[]> {
  try {
    const [result, deleted] = await Promise.all([
      execWithStatus(git, readOnlyGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]), root, LIST_FILES_TIMEOUT_MS),
      listDeletedFiles(git, root)
    ]);
    if (result.code !== 0) return fallback().slice(0, MAX_LISTED_FILES);
    const present = parseNulList(result.stdout).filter((path) => !deleted.has(path));
    return [...new Set(present)].slice(0, MAX_LISTED_FILES);
  } catch {
    return fallback().slice(0, MAX_LISTED_FILES);
  }
}

function splitGlobs(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
}

function isUnsafeGlob(glob: string): boolean {
  return /^[\\/]/.test(glob) || /^[A-Za-z]:/.test(glob) || glob.split(/[\\/]/).includes("..");
}

function hasUnsafeGlobs(q: TextSearchQuery): boolean {
  return [...splitGlobs(q.include), ...splitGlobs(q.exclude)].some(isUnsafeGlob);
}

function globPathspecs(glob: string, magic: string): string[] {
  const trimmed = glob.replace(/\/+$/, "");
  const pattern = trimmed.includes("/") ? trimmed : `**/${trimmed}`;
  const specs = [`:(${magic})${pattern}`];
  if (!pattern.endsWith("**")) specs.push(`:(${magic})${pattern}/**`);
  return specs;
}

export function buildGrepArgs(q: TextSearchQuery, isRepo: boolean, pcre: boolean): string[] {
  const args = ["--no-optional-locks", "grep", "-n", "-z", "-I", "--no-color", "--no-column", "--no-full-name"];
  args.push(...(isRepo ? ["--untracked"] : ["--no-index", "--exclude-standard"]));
  if (!q.matchCase) args.push("-i");
  if (q.wholeWord) args.push("-w");
  if (!q.isRegex) args.push("-F");
  else args.push(pcre ? "-P" : "-E");
  args.push("-e", q.query, "--");
  const includes = splitGlobs(q.include).flatMap((glob) => globPathspecs(glob, "glob"));
  const excludes = splitGlobs(q.exclude).flatMap((glob) => globPathspecs(glob, "exclude,glob"));
  if (includes.length === 0 && excludes.length > 0) args.push(".");
  args.push(...includes, ...excludes);
  return args;
}

function parseGrepRecord(record: string): GrepLine | null {
  const pathEnd = record.indexOf("\0");
  const lineEnd = pathEnd < 0 ? -1 : record.indexOf("\0", pathEnd + 1);
  if (lineEnd < 0) return null;
  const line = Number.parseInt(record.slice(pathEnd + 1, lineEnd), 10);
  const path = record.slice(0, pathEnd);
  if (!Number.isFinite(line) || path.startsWith("../")) return null;
  return { path, line, text: record.slice(lineEnd + 1).replace(/\r$/, "") };
}

export function parseGrepOutput(stdout: string, limit: number): { lines: GrepLine[]; truncated: boolean } {
  const lines: GrepLine[] = [];
  let cursor = 0;
  while (cursor < stdout.length) {
    let end = stdout.indexOf("\n", cursor);
    if (end < 0) end = stdout.length;
    const parsed = parseGrepRecord(stdout.slice(cursor, end));
    cursor = end + 1;
    if (!parsed) continue;
    if (lines.length >= limit) return { lines, truncated: true };
    lines.push(parsed);
  }
  return { lines, truncated: false };
}

function runGrep(git: string, args: string[], cwd: string, limit: number): Promise<GrepRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(git, args, { cwd, windowsHide: true, env: nonInteractiveEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const lines: GrepLine[] = [];
    let pending = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let stopped = false;

    const stop = (): void => {
      stopped = true;
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, SEARCH_TIMEOUT_MS);

    const consume = (record: string): void => {
      const parsed = parseGrepRecord(record);
      if (!parsed) return;
      if (lines.length >= limit) {
        truncated = true;
        stop();
        return;
      }
      lines.push(parsed);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0 && !stopped) {
        const record = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        consume(record);
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stopped && pending) consume(pending);
      resolvePromise({ lines, truncated, timedOut, code, stderr });
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileMatcher(q: TextSearchQuery): RegExp | null {
  if (!q.query) return null;
  const source = q.isRegex ? q.query : escapeRegExp(q.query);
  try {
    return new RegExp(q.wholeWord ? `\\b(?:${source})\\b` : source, q.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

function rangesFor(text: string, pattern: RegExp | null): Array<[number, number]> {
  if (!pattern) return [];
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export function matchRanges(text: string, q: TextSearchQuery): Array<[number, number]> {
  return rangesFor(text, compileMatcher(q));
}

export function trimPreview(
  text: string,
  ranges: Array<[number, number]>,
  max = DEFAULT_PREVIEW_MAX
): { preview: string; ranges: Array<[number, number]> } {
  if (text.length <= max) return { preview: text, ranges };
  const first = ranges[0];
  const windowStart = first ? Math.max(0, first[0] - PREVIEW_LEAD_CHARS) : 0;
  const windowEnd = windowStart + max;
  const shifted: Array<[number, number]> = [];
  for (const [from, to] of ranges) {
    if (from < windowStart || from >= windowEnd) continue;
    shifted.push([from - windowStart, Math.min(to, windowEnd) - windowStart]);
  }
  return { preview: text.slice(windowStart, windowEnd), ranges: shifted };
}

async function isInsideWorkTree(git: string, root: string): Promise<boolean> {
  try {
    const result = await execWithStatus(git, readOnlyGit(["rev-parse", "--is-inside-work-tree"]), root, DECORATIONS_TIMEOUT_MS);
    return result.code === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export function toMatch(line: GrepLine, pattern: RegExp | null): TextSearchMatch {
  const scanned = line.text.length > MAX_MATCH_SCAN_CHARS ? line.text.slice(0, MAX_MATCH_SCAN_CHARS) : line.text;
  const { preview, ranges } = trimPreview(scanned, rangesFor(scanned, pattern));
  return { path: line.path, line: line.line, preview, ranges };
}

function toResult(run: GrepRun, q: TextSearchQuery): TextSearchResult {
  const pattern = compileMatcher(q);
  const matches = run.lines.map((line) => toMatch(line, pattern));
  if (run.truncated) return { matches, truncated: true, error: null };
  if (run.timedOut) {
    return matches.length > 0 ? { matches, truncated: true, error: null } : { matches, truncated: false, error: SEARCH_TIMEOUT_ERROR };
  }
  if (run.code === 1 && matches.length === 0) return { matches, truncated: false, error: null };
  if (run.code === 0) return { matches, truncated: false, error: null };
  const detail = run.stderr.trim() || (run.code === null ? "git grep was terminated" : `git grep exited with code ${run.code}`);
  return { matches: [], truncated: false, error: detail };
}

export async function searchText(git: string, root: string, q: TextSearchQuery): Promise<TextSearchResult> {
  if (!q.query) return { matches: [], truncated: false, error: null };
  if (hasUnsafeGlobs(q)) return { matches: [], truncated: false, error: UNSAFE_GLOB_ERROR };
  const limit = q.maxResults ?? DEFAULT_MAX_RESULTS;
  try {
    const isRepo = await isInsideWorkTree(git, root);
    let run = await runGrep(git, buildGrepArgs(q, isRepo, true), root, limit);
    if (q.isRegex && !run.truncated && !run.timedOut && (run.code ?? 0) >= 2 && PCRE_UNSUPPORTED.test(run.stderr)) {
      run = await runGrep(git, buildGrepArgs(q, isRepo, false), root, limit);
    }
    return toResult(run, q);
  } catch (error) {
    return { matches: [], truncated: false, error: error instanceof Error ? error.message : String(error) };
  }
}
