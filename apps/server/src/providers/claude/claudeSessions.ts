import { openSync, readSync, closeSync, existsSync, readdirSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NativeSession, SessionMeta } from "@cw-code/contracts";
import { mapLimit } from "../../fs/GitService.js";
import { claudeCommandText } from "./claudeCommands.js";

export function claudeProjectSlug(rootPath: string): string {
  return rootPath
    .replace(/[\\/]+$/, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .slice(0, 200);
}

const relocatedTranscripts = new Map<string, string>();

export function claudeTranscriptProjectDir(
  rootPath: string,
  resumeCursor: string,
  projectsDir = join(homedir(), ".claude", "projects")
): string {
  const direct = join(projectsDir, claudeProjectSlug(rootPath));
  const fileName = `${resumeCursor}.jsonl`;
  if (existsSync(join(direct, fileName))) return direct;
  const known = relocatedTranscripts.get(resumeCursor);
  if (known && existsSync(join(known, fileName))) return known;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return direct;
  }
  for (const entry of entries) {
    const dir = join(projectsDir, entry);
    if (existsSync(join(dir, fileName))) {
      relocatedTranscripts.set(resumeCursor, dir);
      return dir;
    }
  }
  return direct;
}

interface ClaudeTranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
  cwd?: unknown;
  gitBranch?: unknown;
  timestamp?: unknown;
  aiTitle?: unknown;
  customTitle?: unknown;
}

function parseEntry(line: string): ClaudeTranscriptEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ClaudeTranscriptEntry) : null;
  } catch {
    return null;
  }
}

function userPromptTitle(entry: ClaudeTranscriptEntry): string | null {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  const text = typeof content === "string" ? content : "";
  if (!text.trim() || text.includes("<local-command-caveat>")) return null;
  const title = claudeCommandText(text) ?? text.trim();
  return title.slice(0, 60).replace(/\s+/g, " ");
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface ClaudeTranscriptSummary {
  cwd: string;
  title: string | null;
  gitBranch?: string;
  createdAt?: number;
}

/** Best-effort summary from the start and end of a transcript; null when it holds no resumable conversation. */
export function summarizeClaudeTranscript(head: string, tail: string): ClaudeTranscriptSummary | null {
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let createdAt: number | undefined;
  let prompt: string | null = null;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let hasUser = false;
  for (const line of [...head.split("\n"), ...tail.split("\n")]) {
    const entry = parseEntry(line);
    if (!entry || entry.isSidechain) continue;
    cwd ??= nonEmpty(entry.cwd);
    const branch = nonEmpty(entry.gitBranch);
    if (branch && branch !== "HEAD") gitBranch = branch;
    if (createdAt === undefined && typeof entry.timestamp === "string") {
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at)) createdAt = at;
    }
    if (entry.type === "user" && !entry.isMeta) hasUser = true;
    prompt ??= userPromptTitle(entry);
    if (entry.type === "ai-title") aiTitle = nonEmpty(entry.aiTitle) ?? aiTitle;
    if (entry.type === "custom-title") customTitle = nonEmpty(entry.customTitle) ?? customTitle;
  }
  if (!cwd || !hasUser) return null;
  return {
    cwd,
    title: customTitle ?? aiTitle ?? prompt,
    ...(gitBranch ? { gitBranch } : {}),
    ...(createdAt !== undefined ? { createdAt } : {})
  };
}

export function peekClaudeTitle(file: string): string | null {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(131072);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.toString("utf8", 0, bytes).split("\n").slice(0, 200);
    for (const line of lines) {
      const entry = parseEntry(line);
      const title = entry ? userPromptTitle(entry) : null;
      if (title) return title;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
export async function listClaudeSessions(projectId: string, rootPath: string): Promise<SessionMeta[]> {
  const dir = join(homedir(), ".claude", "projects", claudeProjectSlug(rootPath));
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const id = file.slice(0, -".jsonl".length);
    let updatedAt = Date.now();
    try {
      updatedAt = (await stat(join(dir, file))).mtimeMs;
    } catch {
      continue;
    }
    out.push({
      id: `claude:${id}`,
      projectId,
      driver: "claude",
      title: peekClaudeTitle(join(dir, file)) ?? id.slice(0, 8),
      status: "idle",
      resumeCursor: id,
      createdAt: updatedAt,
      updatedAt
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

const SUMMARY_HEAD_BYTES = 65536;
const SUMMARY_TAIL_BYTES = 65536;
const SUMMARY_CONCURRENCY = 16;

async function readHeadAndTail(file: string): Promise<{ head: string; tail: string; mtimeMs: number }> {
  const handle = await open(file, "r");
  try {
    const { size, mtimeMs } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, SUMMARY_HEAD_BYTES));
    await handle.read(head, 0, head.length, 0);
    const tailStart = Math.max(head.length, size - SUMMARY_TAIL_BYTES);
    const tail = Buffer.alloc(size - tailStart);
    if (tail.length > 0) await handle.read(tail, 0, tail.length, tailStart);
    return { head: head.toString("utf8"), tail: tail.toString("utf8"), mtimeMs };
  } finally {
    await handle.close();
  }
}

async function summarizeTranscriptFile(file: string, resumeCursor: string): Promise<NativeSession | null> {
  try {
    const { head, tail, mtimeMs } = await readHeadAndTail(file);
    const summary = summarizeClaudeTranscript(head, tail);
    if (!summary) return null;
    return {
      driver: "claude",
      resumeCursor,
      title: summary.title ?? resumeCursor.slice(0, 8),
      cwd: summary.cwd,
      createdAt: summary.createdAt ?? mtimeMs,
      updatedAt: mtimeMs,
      ...(summary.gitBranch ? { gitBranch: summary.gitBranch } : {})
    };
  } catch {
    return null;
  }
}

export async function listNativeClaudeSessions(projectsDir = join(homedir(), ".claude", "projects")): Promise<NativeSession[]> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: Array<{ path: string; resumeCursor: string }> = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(join(projectsDir, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl") || entry.startsWith("agent-")) continue;
      files.push({ path: join(projectsDir, dir, entry), resumeCursor: entry.slice(0, -".jsonl".length) });
    }
  }
  const summaries = await mapLimit(files, SUMMARY_CONCURRENCY, (file) => summarizeTranscriptFile(file.path, file.resumeCursor));
  return summaries.filter((session): session is NativeSession => session !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}
