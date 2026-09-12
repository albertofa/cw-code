export type OpencodeMessagePartInput = { type: "text"; text: string } | { type: "file"; mime: string; url: string };

export interface OpencodeMessageBody {
  parts: OpencodeMessagePartInput[];
  model?: { providerID: string; modelID: string };
  variant?: string;
}

export function splitOpencodeModel(id: string | undefined): { providerID: string; modelID: string } | null {
  if (!id) return null;
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

const ATTACHMENT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
  json: "text/plain",
  csv: "text/plain",
  yaml: "text/plain",
  yml: "text/plain"
};

export function mimeForOpencodeAttachment(rel: string): string | null {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  return ATTACHMENT_MIME[ext] ?? null;
}

export function buildOpencodeMessageBody(
  prompt: string,
  opts: {
    model?: { providerID: string; modelID: string } | null;
    variant?: string;
    files?: Array<{ mime: string; url: string }>;
  } = {}
): OpencodeMessageBody {
  const parts: OpencodeMessagePartInput[] = [];
  if (prompt.trim()) parts.push({ type: "text", text: prompt });
  for (const file of opts.files ?? []) parts.push({ type: "file", mime: file.mime, url: file.url });
  const body: OpencodeMessageBody = { parts };
  if (opts.model) body.model = opts.model;
  if (opts.variant) body.variant = opts.variant;
  return body;
}

export interface OpencodeTurnMessage {
  id: string;
  role?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  text: string;
}

export interface OpencodeTurnSummary {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function turnMessagesOf(payload: unknown): OpencodeTurnMessage[] {
  const container = asRecord(payload);
  const raw = Array.isArray(payload) ? payload : container?.["data"];
  if (!Array.isArray(raw)) return [];
  const out: OpencodeTurnMessage[] = [];
  for (const entry of raw) {
    const msg = asRecord(entry);
    const info = asRecord(msg?.["info"]) ?? {};
    const id = typeof info["id"] === "string" ? info["id"] : "";
    if (!id) continue;
    const role = typeof info["role"] === "string" ? info["role"] : "";
    const tokens = asRecord(info["tokens"]);
    const cache = asRecord(tokens?.["cache"]);
    const texts: string[] = [];
    const parts = Array.isArray(msg?.["parts"]) ? (msg?.["parts"] as unknown[]) : [];
    for (const partEntry of parts) {
      const part = asRecord(partEntry);
      if (part?.["type"] === "text" && typeof part["text"] === "string" && part["text"]) {
        texts.push(part["text"]);
      }
    }
    out.push({
      id,
      ...(role ? { role } : {}),
      cost: asNumber(info["cost"]),
      tokens: tokens
        ? {
            input: asNumber(tokens["input"]),
            output: asNumber(tokens["output"]),
            reasoning: asNumber(tokens["reasoning"]),
            cache: cache ? { read: asNumber(cache["read"]), write: asNumber(cache["write"]) } : undefined
          }
        : undefined,
      text: texts.join("\n")
    });
  }
  return out;
}

export function summarizeOpencodeTurn(messages: OpencodeTurnMessage[], beforeIds: Set<string> | null): OpencodeTurnSummary {
  const fresh = beforeIds === null ? [] : messages.filter((m) => !beforeIds.has(m.id));
  const scoped = beforeIds === null ? [] : fresh.filter((m) => m.role === "assistant");
  const summary: OpencodeTurnSummary = { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const m of scoped) {
    if (m.text) summary.text += (summary.text ? "\n" : "") + m.text;
    summary.inputTokens += (m.tokens?.input ?? 0) + (m.tokens?.cache?.read ?? 0) + (m.tokens?.cache?.write ?? 0);
    summary.outputTokens += (m.tokens?.output ?? 0) + (m.tokens?.reasoning ?? 0);
    summary.costUsd += m.cost ?? 0;
  }
  return summary;
}

export function assistantDeltaOf(event: unknown, sessionID: string): string | null {
  const envelope = asRecord(event);
  if (!envelope || envelope["type"] !== "message.part.delta") return null;
  const props = asRecord(envelope["properties"] ?? envelope["data"]);
  if (!props || props["sessionID"] !== sessionID) return null;
  if (props["field"] !== "text") return null;
  const delta = props["delta"];
  return typeof delta === "string" && delta ? delta : null;
}
