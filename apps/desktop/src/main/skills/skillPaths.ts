import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { HarnessId } from "@cw-code/contracts";

export const SKILL_FILENAME = "SKILL.md";

export const HARNESSES: readonly HarnessId[] = ["claude", "opencode", "codex"];

const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

export function assertValidSkillName(name: string): string {
  if (!isValidSkillName(name)) throw new Error(`invalid skill name: ${name}`);
  return name;
}

export function defaultHomeDir(): string {
  return homedir();
}

export function expandHome(input: string, homeDir: string = defaultHomeDir()): string {
  if (input === "~") return normalize(homeDir);
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return normalize(join(homeDir, input.slice(2)));
  }
  return normalize(input);
}

export function normalizeStoredDir(p: string): string {
  const normalized = normalize(p.trim());
  const stripped = normalized.replace(/[\\/]+$/, "");
  return stripped || normalized;
}

export interface HarnessScanRoot {
  harness: HarnessId;
  dir: string;
}

export function harnessSkillRoot(harness: HarnessId, homeDir: string): string {
  const home = normalizeStoredDir(homeDir);
  if (harness === "claude") return join(home, ".claude", "skills");
  if (harness === "opencode") return join(home, ".config", "opencode", "skills");
  return join(home, ".agents", "skills");
}

export function codexSkillRoots(homeDir: string): { current: string; legacy: string } {
  const home = normalizeStoredDir(homeDir);
  return { current: join(home, ".agents", "skills"), legacy: join(home, ".codex", "skills") };
}

export function selectCodexRoot(
  homeDir: string,
  exists: (p: string) => boolean = existsSync
): string {
  const { current, legacy } = codexSkillRoots(homeDir);
  if (exists(current)) return current;
  if (exists(legacy)) return legacy;
  return current;
}

export function getScanRoots(homeDir: string): HarnessScanRoot[] {
  const { current, legacy } = codexSkillRoots(homeDir);
  const home = normalizeStoredDir(homeDir);
  return [
    { harness: "claude", dir: join(home, ".claude", "skills") },
    { harness: "codex", dir: current },
    { harness: "codex", dir: legacy },
    { harness: "opencode", dir: join(home, ".config", "opencode", "skills") }
  ];
}

export function resolveSkillDir(root: string, name: string): string {
  assertValidSkillName(name);
  const base = resolve(root);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`skill path escapes its root: ${name}`);
  }
  return target;
}

export function skillFileForDir(dir: string): string {
  return join(dir, SKILL_FILENAME);
}

export function canonicalRoot(userDataDir: string): string {
  return join(normalizeStoredDir(userDataDir), "skills");
}

export function canonicalSkillDir(userDataDir: string, name: string): string {
  return resolveSkillDir(canonicalRoot(userDataDir), name);
}
