import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["CLAUDE_CONFIG_DIR"] || homedir(), ".claude.json");
}

export function readClaudeChromeDefault(configPath = claudeGlobalConfigPath()): boolean {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  try {
    const config: unknown = JSON.parse(raw);
    return typeof config === "object" && config !== null && (config as Record<string, unknown>)["claudeInChromeDefaultEnabled"] === true;
  } catch (err) {
    console.warn(`claude config unreadable, Claude in Chrome setting left off: ${(err as Error).message}`);
    return false;
  }
}
