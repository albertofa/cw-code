import type { OpencodeMessage, OpencodeMessagePart } from "../opencodeProtocol.js";

export const V2_SUBAGENT_TOOL = "subagent";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function v2ErrorOf(error: unknown): { name: string; data: { message: string } } | undefined {
  const record = asRecord(error);
  if (!record) return undefined;
  const type = asString(record["type"]);
  const message = asString(record["message"]) || type;
  if (!type && !message) return undefined;
  const name = type === "aborted" ? "MessageAbortedError" : type || "Error";
  return { name, data: { message } };
}

export function v2ContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const entry of content) {
    const item = asRecord(entry);
    if (item?.["type"] === "text" && typeof item["text"] === "string") lines.push(item["text"]);
    else if (item?.["type"] === "file") lines.push(`[file ${asString(item["name"]) || asString(item["uri"])}]`);
  }
  return lines.join("\n");
}

export function v2ToolStatus(status: unknown): "pending" | "running" | "completed" | "error" {
  if (status === "completed" || status === "error" || status === "running") return status;
  return "pending";
}

interface SubagentOutcome {
  state: string;
  text: string;
}

function subagentOutcomes(messages: unknown[]): Map<string, SubagentOutcome> {
  const out = new Map<string, SubagentOutcome>();
  for (const entry of messages) {
    const message = asRecord(entry);
    if (message?.["type"] !== "synthetic") continue;
    const metadata = asRecord(message["metadata"]);
    if (metadata?.["source"] !== "subagent") continue;
    const child = asString(metadata["childID"]);
    if (!child) continue;
    const text = asString(message["text"]).replace(/^<subagent[^>]*>\n?/, "").replace(/\n?<\/subagent>\s*$/, "");
    out.set(child, { state: asString(metadata["state"]) || "completed", text });
  }
  return out;
}

function toolPart(tool: Record<string, unknown>, outcomes: Map<string, SubagentOutcome>): OpencodeMessagePart {
  const id = asString(tool["id"]);
  const name = asString(tool["name"]) || "tool";
  const state = asRecord(tool["state"]) ?? {};
  const time = asRecord(tool["time"]);
  const metadata = { ...(asRecord(state["metadata"]) ?? {}) };
  let status = v2ToolStatus(state["status"]);
  let output = v2ContentText(state["content"]);
  let error = status === "error" ? asString(asRecord(state["error"])?.["message"]) || output || "tool failed" : undefined;
  const child = asString(metadata["sessionID"]);
  if (name === V2_SUBAGENT_TOOL && child && metadata["status"] === "running") {
    metadata["background"] = true;
    const outcome = outcomes.get(child);
    if (!outcome) {
      status = "running";
      output = "";
    } else if (outcome.state === "completed") {
      status = "completed";
      output = outcome.text;
    } else {
      status = "error";
      error = outcome.text || `subagent ${outcome.state}`;
    }
  }
  const start = asNumber(time?.["created"]);
  const end = asNumber(time?.["completed"]);
  const timing = { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
  const input = asRecord(state["input"]) ?? {};
  return {
    id,
    callID: id,
    type: "tool",
    tool: name,
    state: {
      status,
      input,
      ...(output && status !== "error" ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      metadata,
      time: timing
    },
    time: timing
  };
}

function assistantMessage(message: Record<string, unknown>, outcomes: Map<string, SubagentOutcome>): OpencodeMessage {
  const id = asString(message["id"]);
  const model = asRecord(message["model"]);
  const time = asRecord(message["time"]);
  const parts: OpencodeMessagePart[] = [];
  const content = Array.isArray(message["content"]) ? message["content"] : [];
  content.forEach((entry, index) => {
    const item = asRecord(entry);
    if (!item) return;
    if (item["type"] === "text" && typeof item["text"] === "string") {
      parts.push({ id: `${id}:${index}`, type: "text", text: item["text"] });
    } else if (item["type"] === "reasoning" && typeof item["text"] === "string") {
      const reasoningTime = asRecord(item["time"]);
      const start = asNumber(reasoningTime?.["created"]);
      const end = asNumber(reasoningTime?.["completed"]);
      parts.push({
        id: `${id}:${index}`,
        type: "reasoning",
        text: item["text"],
        time: { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) }
      });
    } else if (item["type"] === "tool") {
      parts.push(toolPart(item, outcomes));
    }
  });
  const tokens = asRecord(message["tokens"]);
  const cache = asRecord(tokens?.["cache"]);
  const error = v2ErrorOf(message["error"]);
  const created = asNumber(time?.["created"]);
  const completed = asNumber(time?.["completed"]);
  return {
    info: {
      id,
      role: "assistant",
      ...(asString(model?.["providerID"]) ? { providerID: asString(model?.["providerID"]) } : {}),
      ...(asString(model?.["id"]) ? { modelID: asString(model?.["id"]) } : {}),
      ...(asNumber(message["cost"]) !== undefined ? { cost: asNumber(message["cost"]) } : {}),
      ...(tokens
        ? {
            tokens: {
              input: asNumber(tokens["input"]) ?? 0,
              output: asNumber(tokens["output"]) ?? 0,
              reasoning: asNumber(tokens["reasoning"]) ?? 0,
              cache: { read: asNumber(cache?.["read"]) ?? 0, write: asNumber(cache?.["write"]) ?? 0 }
            }
          }
        : {}),
      ...(asString(message["finish"]) ? { finish: asString(message["finish"]) } : {}),
      ...(error ? { error } : {}),
      time: { ...(created !== undefined ? { created } : {}), ...(completed !== undefined ? { completed } : {}) }
    },
    parts
  };
}

function userMessage(message: Record<string, unknown>): OpencodeMessage {
  const id = asString(message["id"]);
  const created = asNumber(asRecord(message["time"])?.["created"]);
  const parts: OpencodeMessagePart[] = [];
  const text = asString(message["text"]);
  if (text) parts.push({ id: `${id}:text`, type: "text", text });
  const files = Array.isArray(message["files"]) ? message["files"] : [];
  files.forEach((entry, index) => {
    const file = asRecord(entry);
    if (!file) return;
    const uri = asString(file["uri"]);
    const name = asString(file["name"]);
    const mime = asString(file["mime"]);
    parts.push({
      id: `${id}:file:${index}`,
      type: "file",
      ...(name ? { filename: name } : {}),
      ...(mime ? { mime } : {}),
      ...(uri ? { url: uri } : {})
    });
  });
  return { info: { id, role: "user", ...(created !== undefined ? { time: { created } } : {}) }, parts };
}

function compactionMessage(message: Record<string, unknown>): OpencodeMessage {
  const id = asString(message["id"]);
  const created = asNumber(asRecord(message["time"])?.["created"]);
  const model = asRecord(message["model"]);
  const error = message["status"] === "failed" ? v2ErrorOf(message["error"]) : undefined;
  const summary = asString(message["summary"]);
  return {
    info: {
      id,
      role: "assistant",
      mode: "compaction",
      summary: true,
      ...(asString(model?.["providerID"]) ? { providerID: asString(model?.["providerID"]) } : {}),
      ...(asString(model?.["id"]) ? { modelID: asString(model?.["id"]) } : {}),
      ...(error ? { error } : {}),
      ...(created !== undefined ? { time: { created, completed: created } } : {})
    },
    parts: summary ? [{ id: `${id}:summary`, type: "text", text: summary }] : []
  };
}

function idleMessage(message: Record<string, unknown>): OpencodeMessage {
  const id = asString(message["id"]);
  const created = asNumber(asRecord(message["time"])?.["created"]);
  const error = message["outcome"] === "failed" ? v2ErrorOf(message["error"]) ?? { name: "Error", data: { message: "opencode turn failed" } } : undefined;
  return {
    info: {
      id,
      role: "idle",
      finish: asString(message["outcome"]),
      ...(error ? { error } : {}),
      ...(created !== undefined ? { time: { created, completed: created } } : {})
    },
    parts: []
  };
}

/** Maps v2 messages (oldest first) into the shared `{info, parts}` shape. Bookkeeping entries are dropped; a subagent completion stays as an empty marker because it wakes the parent. */
export function mapV2Messages(raw: unknown[]): OpencodeMessage[] {
  const outcomes = subagentOutcomes(raw);
  const out: OpencodeMessage[] = [];
  for (const entry of raw) {
    const message = asRecord(entry);
    if (!message || !asString(message["id"])) continue;
    switch (message["type"]) {
      case "user":
        out.push(userMessage(message));
        break;
      case "assistant":
        out.push(assistantMessage(message, outcomes));
        break;
      case "compaction":
        out.push(compactionMessage(message));
        break;
      case "idle":
        out.push(idleMessage(message));
        break;
      case "synthetic":
        if (asRecord(message["metadata"])?.["source"] === "subagent") {
          out.push({ info: { id: asString(message["id"]), role: "synthetic" }, parts: [] });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

export function v2PendingChildren(messages: OpencodeMessage[], beforeIds: Set<string> | null): string[] {
  const pending: string[] = [];
  for (const message of messages) {
    const id = message.info?.id;
    if (beforeIds && id && beforeIds.has(id)) continue;
    for (const part of message.parts ?? []) {
      if (part.type !== "tool" || part.tool !== V2_SUBAGENT_TOOL || part.state?.status !== "running") continue;
      const child = part.state.metadata?.["sessionID"];
      if (typeof child === "string" && child) pending.push(child);
    }
  }
  return pending;
}

function lastMessage(messages: OpencodeMessage[]): OpencodeMessage | undefined {
  return messages[messages.length - 1];
}

/** The newest message is an idle marker that closes work started after `beforeIds`, with no background child left. */
export function v2TurnEnded(messages: OpencodeMessage[], beforeIds: Set<string>): boolean {
  const last = lastMessage(messages);
  const id = last?.info?.id;
  if (last?.info?.role !== "idle" || !id || beforeIds.has(id)) return false;
  const worked = messages.some((m) => m.info?.role !== "idle" && m.info?.id !== undefined && !beforeIds.has(m.info.id));
  return worked && v2PendingChildren(messages, beforeIds).length === 0;
}

export function v2Running(messages: OpencodeMessage[]): boolean {
  const last = lastMessage(messages);
  return last !== undefined && last.info?.role !== "idle";
}
