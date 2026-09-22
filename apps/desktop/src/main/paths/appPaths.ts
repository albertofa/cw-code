import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expandHome, normalizeStoredDir } from "../skills/skillPaths.js";

export function cwCodeHome(home?: string, env?: NodeJS.ProcessEnv): string {
  const explicit = home?.trim();
  if (explicit) return normalizeStoredDir(expandHome(explicit));
  const raw = (env ?? process.env).CW_CODE_HOME?.trim();
  if (raw) return normalizeStoredDir(expandHome(raw));
  return normalizeStoredDir(join(homedir(), ".cw-code"));
}

export function userdataDir(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(cwCodeHome(home, env), "userdata");
}

export function attachmentsDir(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(userdataDir(home, env), "attachments");
}

export function logsDir(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(cwCodeHome(home, env), "logs");
}

export function worktreesDir(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(cwCodeHome(home, env), "worktrees");
}

export function opencodeConfigDir(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(userdataDir(home, env), "cw-opencode");
}

export function opencodeServerDir(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(userdataDir(home, env), "cw-opencode-server");
}

export function opencodeModelsCachePath(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(userdataDir(home, env), "opencode-models.json");
}

export function skillsDir(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(userdataDir(home, env), "skills");
}

export function titleGenDir(home?: string, env?: NodeJS.ProcessEnv): string {
  return join(userdataDir(home, env), "title-gen");
}

export function ensureAppDirs(
  home?: string,
  env?: NodeJS.ProcessEnv
): { home: string; userdata: string; attachments: string; logs: string; worktrees: string } {
  const resolved: { home: string; userdata: string; attachments: string; logs: string; worktrees: string } = {
    home: cwCodeHome(home, env),
    userdata: userdataDir(home, env),
    attachments: attachmentsDir(home, env),
    logs: logsDir(home, env),
    worktrees: worktreesDir(home, env)
  };
  for (const dir of [resolved.home, resolved.userdata, resolved.attachments, resolved.logs, resolved.worktrees]) {
    mkdirSync(dir, { recursive: true });
  }
  return resolved;
}

interface MigrationEntry {
  name: string;
  dest: string;
  tree: boolean;
}

export function migrateFromUserData(
  userDataDir: string,
  home?: string,
  env?: NodeJS.ProcessEnv
): { copied: string[]; skipped: string[] } {
  const userdata = userdataDir(home, env);
  const logs = logsDir(home, env);
  const entries: MigrationEntry[] = [
    { name: "cw-code.db.json", dest: join(userdata, "cw-code.db.json"), tree: false },
    { name: "cw-settings.json", dest: join(userdata, "cw-settings.json"), tree: false },
    { name: "skills.json", dest: join(userdata, "skills.json"), tree: false },
    { name: "skills", dest: join(userdata, "skills"), tree: true },
    { name: "cw-opencode", dest: join(userdata, "cw-opencode"), tree: true },
    { name: "cw-opencode-server", dest: join(userdata, "cw-opencode-server"), tree: true },
    { name: "crash.log", dest: join(logs, "crash.log"), tree: false },
    { name: "harness-trace.jsonl", dest: join(logs, "harness-trace.jsonl"), tree: false },
    { name: "harness-trace.1.jsonl", dest: join(logs, "harness-trace.1.jsonl"), tree: false }
  ];
  const copied: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(userDataDir)) return { copied, skipped: entries.map((entry) => entry.name) };
  for (const entry of entries) {
    const src = join(userDataDir, entry.name);
    if (!existsSync(src) || existsSync(entry.dest)) {
      skipped.push(entry.name);
      continue;
    }
    try {
      mkdirSync(dirname(entry.dest), { recursive: true });
      if (entry.tree) cpSync(src, entry.dest, { recursive: true });
      else copyFileSync(src, entry.dest);
      copied.push(entry.name);
    } catch {
      skipped.push(entry.name);
    }
  }
  return { copied, skipped };
}
