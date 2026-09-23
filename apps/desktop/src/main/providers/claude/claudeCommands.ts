import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, normalize } from "node:path";
import type { CommandOption } from "@cw-code/contracts";
import { killProcessTree } from "../../processTree.js";
import { describeClaudeExit } from "./claudeExit.js";
import { traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

export const CLAUDE_COMMANDS_PROBE_ARGS = [
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--input-format", "stream-json"
];

export const CLAUDE_COMMANDS_CACHE_TTL_MS = 30 * 60_000;
export const CLAUDE_COMMANDS_PROBE_TIMEOUT_MS = 30_000;
export const CLAUDE_COMMANDS_CACHE_PRUNE_MS = 7 * 24 * 60 * 60_000;

const OWNED_COMMAND_NAMES = new Set(["model", "effort", "rename", "clear"]);

export function mapClaudeCommands(raw: unknown, terminal: ReadonlySet<string>): CommandOption[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || OWNED_COMMAND_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    const description = typeof record.description === "string" ? record.description : "";
    const argumentHint = typeof record.argumentHint === "string" && record.argumentHint ? record.argumentHint : undefined;
    out.push({
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      dispatch: terminal.has(name) ? "terminal" : "prompt"
    });
  }
  return out;
}

const COMMAND_NAME_RE = /^\s*<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

export function claudeCommandText(text: string): string | null {
  const nameMatch = COMMAND_NAME_RE.exec(text);
  const rawName = nameMatch?.[1]?.trim();
  if (!rawName) return null;
  const name = `/${rawName.replace(/^\/+/, "")}`;
  const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim() ?? "";
  return args ? `${name} ${args}` : name;
}

interface ClaudeCommandsCacheEntry {
  at: number;
  raw: unknown[];
  terminal: string[];
}

const cache = new Map<string, ClaudeCommandsCacheEntry>();
const inflight = new Map<string, Promise<ClaudeCommandsCacheEntry>>();
let cacheFile: string | null = null;

function cacheKey(binary: string, cwd: string): string {
  const normCwd = normalize(cwd);
  return process.platform === "win32" ? `${binary.toLowerCase()}::${normCwd.toLowerCase()}` : `${binary}::${normCwd}`;
}

export function decodeClaudeCommandsCache(
  raw: string
): Array<{ key: string; at: number; raw: unknown[]; terminal: string[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const entries = (parsed as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object") return [];
  const out: Array<{ key: string; at: number; raw: unknown[]; terminal: string[] }> = [];
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!key.trim() || value === null || typeof value !== "object") continue;
    const entry = value as { at?: unknown; raw?: unknown; terminal?: unknown };
    if (typeof entry.at !== "number" || !Array.isArray(entry.raw)) continue;
    const terminal = Array.isArray(entry.terminal)
      ? entry.terminal.filter((t): t is string => typeof t === "string")
      : [];
    out.push({ key, at: entry.at, raw: entry.raw, terminal });
  }
  return out;
}

export function initClaudeCommandsCache(filePath: string): void {
  cacheFile = filePath;
  try {
    if (!existsSync(filePath)) return;
    const entries = decodeClaudeCommandsCache(readFileSync(filePath, "utf8"));
    const now = Date.now();
    for (const entry of entries) {
      if (entry.at === 0) continue;
      if (now - entry.at >= CLAUDE_COMMANDS_CACHE_PRUNE_MS) continue;
      const existing = cache.get(entry.key);
      if (!existing || existing.at < entry.at) {
        cache.set(entry.key, { at: entry.at, raw: entry.raw, terminal: entry.terminal });
      }
    }
  } catch (err) {
    console.warn(`claude commands cache read failed: ${(err as Error).message}`);
  }
}

function persistCache(): void {
  if (!cacheFile) return;
  const entries: Record<string, ClaudeCommandsCacheEntry> = {};
  for (const [key, entry] of cache) entries[key] = entry;
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }), "utf8");
    renameSync(tmp, cacheFile);
  } catch (err) {
    console.warn(`claude commands cache write failed: ${(err as Error).message}`);
  }
}

function sameTerminalSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export function recordClaudeTerminalCommands(binary: string, cwd: string, terminal: readonly string[]): void {
  const key = cacheKey(binary, cwd);
  const existing = cache.get(key);
  const merged = [...new Set(terminal)];
  if (sameTerminalSet(existing?.terminal ?? [], merged)) return;
  cache.set(key, { at: existing?.at ?? 0, raw: existing?.raw ?? [], terminal: merged });
  persistCache();
}

const CLAUDE_NO_COMMAND_LIST_MESSAGE = "claude returned no command list";

interface ProbeControlResponse {
  type?: unknown;
  response?: {
    request_id?: unknown;
    subtype?: unknown;
    error?: unknown;
    response?: {
      commands?: unknown;
    };
  };
}

type ProbeOutcome = { ok: true; commands: unknown[] } | { ok: false; error: string };

function parseProbeControlResponse(line: string, requestId: string): ProbeOutcome | null {
  if (!line.trim().startsWith("{")) return null;
  let msg: ProbeControlResponse;
  try {
    msg = JSON.parse(line) as ProbeControlResponse;
  } catch {
    return null;
  }
  if (msg.type !== "control_response" || msg.response?.request_id !== requestId) return null;
  if (msg.response?.subtype === "error") {
    const error = typeof msg.response.error === "string" && msg.response.error ? msg.response.error : CLAUDE_NO_COMMAND_LIST_MESSAGE;
    return { ok: false, error };
  }
  const commands = msg.response?.response?.commands;
  if (!Array.isArray(commands)) return { ok: false, error: CLAUDE_NO_COMMAND_LIST_MESSAGE };
  return { ok: true, commands };
}

export function probeClaudeCommands(
  binary: string,
  args: string[],
  cwd: string,
  spawnFn: typeof spawn = spawn,
  killFn: (proc: ChildProcess | undefined) => void = killProcessTree
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const child = spawnFn(binary, args, { cwd, windowsHide: true }) as ChildProcessWithoutNullStreams;
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`claude commands probe timed out after ${CLAUDE_COMMANDS_PROBE_TIMEOUT_MS}ms`)));
    }, CLAUDE_COMMANDS_PROBE_TIMEOUT_MS);
    timer.unref?.();

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killFn(child);
      action();
    }

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const outcome = parseProbeControlResponse(line, requestId);
      if (outcome === null) return;
      if (outcome.ok) settle(() => resolve(outcome.commands));
      else settle(() => reject(new Error(outcome.error)));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      settle(() => reject(new Error(`failed to spawn ${binary}: ${err.message}`)));
    });
    child.on("close", (code) => {
      settle(() => reject(new Error(describeClaudeExit(stderr, code, "listing commands"))));
    });
    child.stdin?.on("error", (err: Error) => {
      settle(() => reject(new Error(`failed to write to claude stdin: ${err.message}`)));
    });
    child.stdin?.write(
      `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`
    );
  });
}

export type ClaudeCommandsQuery = (binary: string, args: string[], cwd: string) => Promise<unknown[]>;

function defaultClaudeCommandsQuery(binary: string, args: string[], cwd: string): Promise<unknown[]> {
  return probeClaudeCommands(binary, args, cwd);
}

async function fetchClaudeCommands(
  key: string,
  cwd: string,
  binary: string,
  args: string[],
  query: ClaudeCommandsQuery
): Promise<ClaudeCommandsCacheEntry> {
  const start = Date.now();
  try {
    const raw = await query(binary, args, cwd);
    const terminal = cache.get(key)?.terminal ?? [];
    const entry: ClaudeCommandsCacheEntry = { at: Date.now(), raw, terminal };
    cache.set(key, entry);
    persistCache();
    traceHarnessCall({
      harness: "claude",
      operation: "claude.listCommands",
      cwd,
      binary,
      args,
      durationMs: Date.now() - start,
      ok: true,
      extra: { count: raw.length }
    });
    return entry;
  } catch (err) {
    traceHarnessCall({
      harness: "claude",
      operation: "claude.listCommands",
      cwd,
      binary,
      args,
      durationMs: Date.now() - start,
      ok: false,
      error: truncateError((err as Error).message)
    });
    throw err;
  }
}

function refreshClaudeCommands(
  key: string,
  cwd: string,
  binary: string,
  args: string[],
  query: ClaudeCommandsQuery
): Promise<ClaudeCommandsCacheEntry> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = fetchClaudeCommands(key, cwd, binary, args, query).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

export async function listClaudeCommands(
  cwd: string,
  binary: string,
  args: string[],
  query: ClaudeCommandsQuery = defaultClaudeCommandsQuery
): Promise<CommandOption[]> {
  const key = cacheKey(binary, cwd);
  const hit = cache.get(key);
  if (hit && hit.at > 0) {
    const stale = Date.now() - hit.at >= CLAUDE_COMMANDS_CACHE_TTL_MS;
    if (stale) {
      void refreshClaudeCommands(key, cwd, binary, args, query).catch((err) => {
        console.warn(`claude commands refresh failed: ${(err as Error).message}`);
      });
    }
    return mapClaudeCommands(hit.raw, new Set(hit.terminal));
  }
  const fresh = await refreshClaudeCommands(key, cwd, binary, args, query);
  return mapClaudeCommands(fresh.raw, new Set(fresh.terminal));
}

export function clearClaudeCommandsCache(): void {
  cache.clear();
  inflight.clear();
  cacheFile = null;
}
