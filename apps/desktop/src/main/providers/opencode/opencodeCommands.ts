import type { CommandInvocation, CommandOption } from "@cw-code/contracts";

export type OpencodeBuiltinCommand = "compact" | "undo" | "redo";

export const OPENCODE_BUILTIN_COMMANDS: ReadonlyArray<CommandOption & { name: OpencodeBuiltinCommand }> = [
  { name: "compact", description: "Summarize the session to free context", dispatch: "native" },
  {
    name: "undo",
    description: "Revert the last message and its file changes",
    dispatch: "native",
    confirm: "This reverts the last message and the file changes it made."
  },
  {
    name: "redo",
    description: "Restore all reverted messages",
    dispatch: "native",
    confirm: "This restores all reverted messages and their file changes."
  }
];

export function opencodeBuiltinCommandOf(name: string): OpencodeBuiltinCommand | null {
  return OPENCODE_BUILTIN_COMMANDS.find((c) => c.name === name)?.name ?? null;
}

const HIDDEN_COMMANDS = new Set(["share"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function mapOpencodeCommands(raw: unknown): CommandOption[] {
  const out: CommandOption[] = OPENCODE_BUILTIN_COMMANDS.map((c) => ({ ...c }));
  const seen = new Set(out.map((c) => c.name));
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const record = asRecord(entry);
    const name = typeof record?.["name"] === "string" ? record["name"].trim() : "";
    if (!record || !name || seen.has(name) || HIDDEN_COMMANDS.has(name)) continue;
    seen.add(name);
    const description = typeof record["description"] === "string" ? record["description"].trim() : "";
    const hints = Array.isArray(record["hints"])
      ? record["hints"].filter((h): h is string => typeof h === "string" && h.trim() !== "")
      : [];
    out.push({
      name,
      description,
      dispatch: "native",
      ...(hints.length > 0 ? { argumentHint: hints.map(opencodeHintLabel).join(" ") } : {})
    });
  }
  return out;
}

function opencodeHintLabel(hint: string): string {
  const trimmed = hint.trim();
  if (trimmed === "$ARGUMENTS") return "[arguments]";
  const positional = /^\$(\d+)$/.exec(trimmed);
  return positional ? `<arg${positional[1]}>` : trimmed;
}

export interface OpencodeCommandBody {
  command: string;
  arguments: string;
  model?: string;
  variant?: string;
  parts?: Array<{ type: "file"; mime: string; url: string }>;
}

export function buildOpencodeCommandBody(
  inv: CommandInvocation,
  opts: {
    model?: { providerID: string; modelID: string } | null;
    variant?: string;
    files?: Array<{ mime: string; url: string }>;
  }
): OpencodeCommandBody {
  return {
    command: inv.name,
    arguments: inv.args,
    ...(opts.model ? { model: `${opts.model.providerID}/${opts.model.modelID}` } : {}),
    ...(opts.variant ? { variant: opts.variant } : {}),
    ...(opts.files && opts.files.length > 0
      ? { parts: opts.files.map((f) => ({ type: "file" as const, mime: f.mime, url: f.url })) }
      : {})
  };
}

export function opencodeRevertMessageId(session: unknown): string | null {
  const revert = asRecord(asRecord(session)?.["revert"]);
  const id = revert?.["messageID"];
  return typeof id === "string" && id ? id : null;
}

export function lastOpencodeUserMessageId(messages: unknown, revertMessageId: string | null): string | null {
  const container = asRecord(messages);
  const raw = Array.isArray(messages) ? messages : container?.["data"];
  if (!Array.isArray(raw)) return null;
  const infos = raw.map((entry) => asRecord(asRecord(entry)?.["info"]) ?? {});
  const revertIndex = revertMessageId ? infos.findIndex((info) => info["id"] === revertMessageId) : -1;
  const end = revertIndex >= 0 ? revertIndex : infos.length;
  for (let i = end - 1; i >= 0; i--) {
    const info = infos[i];
    if (info["role"] === "user" && typeof info["id"] === "string" && info["id"]) return info["id"];
  }
  return null;
}
