import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["CLAUDE_CONFIG_DIR"] || homedir(), ".claude.json");
}

export function readClaudeChromeDefault(configPath = claudeGlobalConfigPath()): boolean {
  try {
    const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof config === "object" && config !== null && (config as Record<string, unknown>)["claudeInChromeDefaultEnabled"] === true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`claude config unreadable, Claude in Chrome setting left off: ${(err as Error).message}`);
    }
    return false;
  }
}
