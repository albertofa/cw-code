import { app } from "electron";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  HarnessId,
  SkillDetail,
  SkillMeta,
  SkillsListResult,
  SkillSaveInput,
  SkillSource
} from "@cw-code/contracts";
import { parseSkillFile, serializeSkillFile } from "./skillParser.js";
import {
  HARNESSES,
  assertValidSkillName,
  canonicalRoot,
  canonicalSkillDir,
  codexSkillRoots,
  defaultHomeDir,
  getScanRoots,
  isValidSkillName,
  normalizeStoredDir,
  resolveSkillDir,
  skillFileForDir
} from "./skillPaths.js";

export interface SkillsStoreOptions {
  userDataDir?: string;
  homeDir?: string;
}

type StoredSource = `imported:${HarnessId}` | "created";

interface StoredSkill {
  enabled: Record<HarnessId, boolean>;
  source: StoredSource;
  updatedAt: number;
}

type StoredShape = Record<string, StoredSkill>;

function disabledEnabled(): Record<HarnessId, boolean> {
  return { claude: false, opencode: false, codex: false };
}

function sanitizeEnabled(value: unknown): Record<HarnessId, boolean> {
  const out = disabledEnabled();
  if (value && typeof value === "object") {
    const raw = value as Partial<Record<HarnessId, unknown>>;
    for (const harness of HARNESSES) out[harness] = raw[harness] === true;
  }
  return out;
}

function sourceHarnessFor(source: StoredSource | undefined): SkillSource | null {
  if (!source) return null;
  if (source === "created") return "created";
  if (source.startsWith("imported:")) return source.slice("imported:".length) as HarnessId;
  return null;
}

function copySkillDir(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

export class SkillsStore {
  private readonly userDataDir: string;
  private readonly homeDir: string;
  private readonly metadataPath: string;
  private data: StoredShape;
  private hadMetadataFile: boolean;
  private initialized = false;

  constructor(opts: SkillsStoreOptions = {}) {
    this.userDataDir = normalizeStoredDir(opts.userDataDir ?? app.getPath("userData"));
    this.homeDir = normalizeStoredDir(opts.homeDir ?? defaultHomeDir());
    this.metadataPath = join(this.userDataDir, "skills.json");
    mkdirSync(dirname(this.metadataPath), { recursive: true });
    this.hadMetadataFile = existsSync(this.metadataPath);
    this.data = this.load();
  }

  private load(): StoredShape {
    if (!existsSync(this.metadataPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.metadataPath, "utf8")) as Record<string, StoredSkill>;
      const out: StoredShape = {};
      for (const [name, entry] of Object.entries(parsed)) {
        if (!isValidSkillName(name) || !entry || typeof entry !== "object") continue;
        out[name] = {
          enabled: sanitizeEnabled(entry.enabled),
          source: entry.source === "created" || (typeof entry.source === "string" && entry.source.startsWith("imported:"))
            ? (entry.source as StoredSource)
            : "created",
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now()
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  private persist(): void {
    const tmp = `${this.metadataPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    renameSync(tmp, this.metadataPath);
    this.hadMetadataFile = true;
  }

  private canonicalDir(name: string): string {
    return canonicalSkillDir(this.userDataDir, name);
  }

  private harnessRoot(harness: HarnessId): string {
    if (harness === "claude") return join(this.homeDir, ".claude", "skills");
    if (harness === "opencode") return join(this.homeDir, ".config", "opencode", "skills");
    return codexSkillRoots(this.homeDir).current;
  }

  private harnessSearchDirs(harness: HarnessId): string[] {
    if (harness !== "codex") return [this.harnessRoot(harness)];
    const { current, legacy } = codexSkillRoots(this.homeDir);
    return current === legacy ? [current] : [current, legacy];
  }

  private removeHarnessCopy(harness: HarnessId, name: string): void {
    for (const root of this.harnessSearchDirs(harness)) {
      rmSync(resolveSkillDir(root, name), { recursive: true, force: true });
    }
  }

  private harnessPresent(harness: HarnessId, name: string): boolean {
    try {
      return this.harnessSearchDirs(harness).some((root) =>
        existsSync(skillFileForDir(resolveSkillDir(root, name)))
      );
    } catch {
      return false;
    }
  }

  private presence(name: string): Record<HarnessId, boolean> {
    return {
      claude: this.harnessPresent("claude", name),
      opencode: this.harnessPresent("opencode", name),
      codex: this.harnessPresent("codex", name)
    };
  }

  private ensureEntry(name: string): StoredSkill {
    let entry = this.data[name];
    if (!entry) {
      entry = { enabled: disabledEnabled(), source: "created", updatedAt: Date.now() };
      this.data[name] = entry;
    }
    return entry;
  }

  private toMeta(name: string): SkillMeta {
    const canonicalFile = skillFileForDir(this.canonicalDir(name));
    let description = "";
    let hasBody = false;
    if (existsSync(canonicalFile)) {
      try {
        const parsed = parseSkillFile(readFileSync(canonicalFile, "utf8"), name);
        description = parsed.description;
        hasBody = parsed.body.trim().length > 0;
      } catch {
        description = "";
      }
    }
    const stored = this.data[name];
    const present = this.presence(name);
    const enabled = stored ? sanitizeEnabled(stored.enabled) : disabledEnabled();
    for (const harness of HARNESSES) enabled[harness] = enabled[harness] && present[harness];
    let updatedAt = stored?.updatedAt ?? 0;
    if (!stored) {
      try {
        updatedAt = Math.round(statSync(canonicalFile).mtimeMs);
      } catch {
        updatedAt = Date.now();
      }
    }
    return {
      name,
      description,
      enabled,
      sourceHarness: sourceHarnessFor(stored?.source),
      hasBody,
      updatedAt
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.hadMetadataFile) await this.importSkills();
  }

  async listSkills(): Promise<SkillsListResult> {
    await this.ensureInitialized();
    const names = new Set<string>(Object.keys(this.data));
    try {
      mkdirSync(canonicalRoot(this.userDataDir), { recursive: true });
      for (const entry of readdirSync(canonicalRoot(this.userDataDir), { withFileTypes: true })) {
        if (entry.isDirectory() && isValidSkillName(entry.name)) names.add(entry.name);
      }
    } catch {
    }
    const skills = [...names].sort((a, b) => a.localeCompare(b)).map((name) => this.toMeta(name));
    return { skills };
  }

  async getSkill(name: string): Promise<SkillDetail> {
    assertValidSkillName(name);
    await this.ensureInitialized();
    const canonicalFile = skillFileForDir(this.canonicalDir(name));
    if (!existsSync(canonicalFile) && !this.data[name]) throw new Error(`unknown skill ${name}`);
    let body = "";
    let frontmatter: Record<string, string> = {};
    if (existsSync(canonicalFile)) {
      const parsed = parseSkillFile(readFileSync(canonicalFile, "utf8"), name);
      body = parsed.body;
      frontmatter = parsed.frontmatter;
    }
    return { ...this.toMeta(name), body, frontmatter };
  }

  async saveSkill(input: SkillSaveInput): Promise<SkillDetail> {
    assertValidSkillName(input.name);
    await this.ensureInitialized();
    const name = input.name;
    const description = (input.description ?? "").trim().slice(0, 1024);
    const body = (input.body ?? "").replace(/\r\n/g, "\n");
    const enabled = sanitizeEnabled(input.enabled);
    const dir = this.canonicalDir(name);
    mkdirSync(dir, { recursive: true });
    const tmp = `${skillFileForDir(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeSkillFile({ name, description }, body), "utf8");
    renameSync(tmp, skillFileForDir(dir));
    const entry = this.ensureEntry(name);
    const previous = sanitizeEnabled(entry.enabled);
    entry.enabled = enabled;
    entry.updatedAt = Date.now();
    this.persist();
    for (const harness of HARNESSES) {
      if (enabled[harness]) copySkillDir(dir, resolveSkillDir(this.harnessRoot(harness), name));
      else if (previous[harness]) this.removeHarnessCopy(harness, name);
    }
    return this.getSkill(name);
  }

  async setSkillEnabled(name: string, harness: HarnessId, on: boolean): Promise<SkillMeta> {
    assertValidSkillName(name);
    if (!HARNESSES.includes(harness)) throw new Error(`unknown harness ${harness}`);
    await this.ensureInitialized();
    const dir = this.canonicalDir(name);
    if (!existsSync(skillFileForDir(dir)) && !this.data[name]) throw new Error(`unknown skill ${name}`);
    if (on) {
      if (!existsSync(skillFileForDir(dir))) throw new Error(`cannot enable ${name}: canonical copy is missing`);
      copySkillDir(dir, resolveSkillDir(this.harnessRoot(harness), name));
    } else {
      this.removeHarnessCopy(harness, name);
    }
    const entry = this.ensureEntry(name);
    entry.enabled[harness] = on;
    entry.updatedAt = Date.now();
    this.persist();
    return this.toMeta(name);
  }

  async importSkills(): Promise<SkillsListResult> {
    this.initialized = true;
    const seen = new Set<string>();
    for (const root of getScanRoots(this.homeDir)) {
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = readdirSync(root.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const ordered = entries
        .filter((e) => e.isDirectory() && isValidSkillName(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of ordered) {
        const name = entry.name;
        const skillFile = skillFileForDir(join(root.dir, entry.name));
        if (!existsSync(skillFile)) continue;
        const known = this.data[name] !== undefined;
        if (seen.has(name)) continue;
        seen.add(name);
        if (!known) {
          const canonicalFile = skillFileForDir(this.canonicalDir(name));
          if (!existsSync(canonicalFile)) {
            try {
              copySkillDir(join(root.dir, entry.name), this.canonicalDir(name));
            } catch (err) {
              console.warn(`skill import failed for '${name}': ${(err as Error).message}`);
              continue;
            }
          }
          const enabled = disabledEnabled();
          enabled[root.harness] = true;
          this.data[name] = { enabled, source: `imported:${root.harness}`, updatedAt: Date.now() };
        } else if (!existsSync(skillFileForDir(this.canonicalDir(name)))) {
          try {
            copySkillDir(join(root.dir, entry.name), this.canonicalDir(name));
          } catch (err) {
            console.warn(`skill import failed for '${name}': ${(err as Error).message}`);
          }
        }
      }
    }
    this.persist();
    return this.listSkills();
  }
}
