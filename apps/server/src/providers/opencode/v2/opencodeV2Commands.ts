import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { mapOpencodeCommands } from "../opencodeCommands.js";
import type { CommandOption } from "@cw-code/contracts";

const BUILTIN_HINTS: Record<string, string[]> = {
  init: ["$ARGUMENTS"],
  review: ["$ARGUMENTS"]
};

const COMMAND_SUBDIRS = ["command", "commands"];
const MAX_COMMAND_FILES = 500;

export interface V2CatalogEntry {
  name: string;
  description: string;
  skill?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dataList(payload: unknown): unknown[] {
  const data = asRecord(payload)?.["data"];
  if (Array.isArray(data)) return data;
  return Array.isArray(payload) ? payload : [];
}

export function templateHints(template: string): string[] {
  const result: string[] = [];
  const numbered = template.match(/\$\d+/g);
  if (numbered) result.push(...[...new Set(numbered)].sort());
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS");
  return result;
}

export function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^﻿/, "");
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(normalized);
  return frontmatter ? normalized.slice(frontmatter[0].length) : normalized;
}

export function commandNameOf(root: string, file: string): string {
  return relative(root, file)
    .replaceAll("\\", "/")
    .replace(/^(command|commands)\//, "")
    .replace(/\.md$/, "");
}

export function v2CommandEntries(commands: unknown, skills: unknown): V2CatalogEntry[] {
  const out: V2CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of dataList(commands)) {
    const record = asRecord(entry);
    const name = asString(record?.["name"]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: asString(record?.["description"]) });
  }
  for (const entry of dataList(skills)) {
    const record = asRecord(entry);
    const id = asString(record?.["id"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ name: id, description: asString(record?.["description"]), skill: id });
  }
  return out;
}

export function v2SkillIds(skills: unknown, names: readonly string[]): Array<{ id: string }> {
  const entries = dataList(skills).map(asRecord).filter((entry) => entry !== null);
  const out: Array<{ id: string }> = [];
  for (const name of names) {
    const match =
      entries.find((entry) => asString(entry["id"]) === name) ?? entries.find((entry) => asString(entry["name"]) === name);
    const id = asString(match?.["id"]);
    if (id && !out.some((skill) => skill.id === id)) out.push({ id });
  }
  return out;
}

export interface V2ConfigCommandSources {
  templates: Map<string, string>;
  directories: string[];
}

export function v2ConfigCommandSources(config: unknown): V2ConfigCommandSources {
  const templates = new Map<string, string>();
  const directories: string[] = [];
  const entries = Array.isArray(config) ? config : dataList(config);
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry?.["type"] === "directory") {
      const path = asString(entry["path"]);
      if (path) directories.push(path);
      continue;
    }
    const commands = asRecord(asRecord(entry?.["info"])?.["commands"]);
    for (const [name, value] of Object.entries(commands ?? {})) {
      const template = asRecord(value)?.["template"];
      if (typeof template === "string") templates.set(name, template);
    }
  }
  return { templates, directories };
}

async function markdownFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_COMMAND_FILES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await markdownFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
}

export async function directoryCommandTemplates(root: string): Promise<Map<string, string>> {
  const templates = new Map<string, string>();
  for (const sub of COMMAND_SUBDIRS) {
    const files: string[] = [];
    await markdownFiles(join(root, sub), files);
    for (const file of files) {
      const content = await readFile(file, "utf8").catch(() => undefined);
      if (content !== undefined) templates.set(commandNameOf(root, file), stripFrontmatter(content));
    }
  }
  return templates;
}

export function buildV2CommandOptions(entries: V2CatalogEntry[], templates: Map<string, string>): CommandOption[] {
  return mapOpencodeCommands(
    entries.map((entry) => {
      const template = templates.get(entry.name);
      const hints = template !== undefined ? templateHints(template) : BUILTIN_HINTS[entry.name] ?? [];
      return { name: entry.name, description: entry.description, hints, ...(entry.skill ? { source: "skill" } : {}) };
    })
  );
}
