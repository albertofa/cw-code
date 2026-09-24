import { openSync, readSync, closeSync, existsSync, readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMeta } from "@cw-code/contracts";
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

export function peekClaudeTitle(file: string): string | null {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(131072);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.toString("utf8", 0, bytes).split("\n").slice(0, 200);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          isMeta?: boolean;
          isSidechain?: boolean;
          message?: { content?: unknown };
        };
        if (parsed.type !== "user" || parsed.isMeta || parsed.isSidechain) continue;
        const content = parsed.message?.content;
        const text = typeof content === "string" ? content : "";
        if (text.trim() && !text.includes("<local-command-caveat>")) {
          const title = claudeCommandText(text) ?? text.trim();
          return title.slice(0, 60).replace(/\s+/g, " ");
        }
      } catch {
        continue;
      }
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
