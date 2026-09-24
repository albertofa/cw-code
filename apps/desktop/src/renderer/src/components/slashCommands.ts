import type { CommandOption } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";

export interface CommandAvailability {
  newSession: boolean;
  rename: boolean;
  terminal: boolean;
}

const NEEDS: Partial<Record<string, keyof CommandAvailability>> = { new: "newSession", clear: "newSession", rename: "rename" };

export const APP_COMMANDS: ReadonlyArray<CommandOption & { harnesses?: DriverName[] }> = [
  { name: "new", description: "Start a new session", dispatch: "app" },
  { name: "clear", description: "Start a new session with empty context", dispatch: "app", harnesses: ["claude"] },
  { name: "model", description: "Switch the model", argumentHint: "<model>", dispatch: "app" },
  { name: "effort", description: "Set the reasoning effort", argumentHint: "<level>", dispatch: "app" },
  { name: "rename", description: "Rename this session", argumentHint: "<title>", dispatch: "app" }
];

export function mergeCommands(
  driver: DriverName,
  fromDriver: CommandOption[],
  available: CommandAvailability
): CommandOption[] {
  const out: CommandOption[] = [];
  const seen = new Set<string>();
  for (const { harnesses, ...command } of APP_COMMANDS) {
    if (harnesses && !harnesses.includes(driver)) continue;
    const need = NEEDS[command.name];
    if (need && !available[need]) continue;
    out.push(command);
    seen.add(command.name);
  }
  for (const command of fromDriver) {
    if (seen.has(command.name)) continue;
    if (command.dispatch === "terminal" && !available.terminal) continue;
    out.push(command);
    seen.add(command.name);
  }
  return out;
}

function matchRank(text: string, query: string): number {
  const value = text.toLowerCase();
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  if (value.includes(query)) return 2;
  return -1;
}

export function rankByQuery<T>(items: readonly T[], query: string, texts: (item: T) => string[]): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const ranked: Array<{ item: T; rank: number }> = [];
  for (const item of items) {
    const ranks = texts(item).map((text) => matchRank(text, q)).filter((rank) => rank >= 0);
    if (ranks.length > 0) ranked.push({ item, rank: Math.min(...ranks) });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.item);
}

export function filterCommands(list: CommandOption[], query: string): CommandOption[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return list;
  const byName = rankByQuery(list, q, (command) => [command.name]);
  const matched = new Set(byName);
  const byDescription = list.filter((command) => !matched.has(command) && command.description.toLowerCase().includes(q));
  return [...byName, ...byDescription];
}

export function parseSlashInput(draft: string, list: CommandOption[]): { command: CommandOption; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  if (!match) return null;
  const command = list.find((c) => c.name === match[1]);
  if (!command) return null;
  return { command, args: (match[2] ?? "").trim() };
}

export function commandDisplay(name: string, args: string): string {
  return args ? `/${name} ${args}` : `/${name}`;
}
