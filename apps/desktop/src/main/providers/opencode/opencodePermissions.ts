import type { ApprovalDecision, ApprovalKind, ApprovalRequest, ThreadEvent } from "@cw-code/contracts";

export interface OpencodePermissionTool {
  messageID: string;
  callID: string;
}

export interface ParsedOpencodePermission {
  requestId: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: OpencodePermissionTool;
}

export interface ParsedOpencodePermissionReply {
  requestID: string;
  sessionID: string;
  reply?: string;
}

export type OpencodePermissionReply = "once" | "always" | "reject";

export const OPENCODE_APPROVAL_DECISIONS: ApprovalDecision[] = ["accept", "acceptForSession", "acceptGlobal", "decline"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (typeof value === "string" && value) return [value];
  return [];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function toolOf(container: Record<string, unknown>): OpencodePermissionTool | undefined {
  const direct = asRecord(container["tool"]);
  const toolRecord = direct ?? (asString(asRecord(container["source"])?.["type"]) === "tool" ? asRecord(container["source"]) : null);
  if (toolRecord) {
    const messageID = asString(toolRecord["messageID"]) || asString(toolRecord["messageId"]);
    const callID = asString(toolRecord["callID"]) || asString(toolRecord["callId"]);
    if (messageID && callID) return { messageID, callID };
  }
  const flatMessageID = asString(container["messageID"]) || asString(container["messageId"]);
  const flatCallID = asString(container["callID"]) || asString(container["callId"]);
  if (flatMessageID && flatCallID) return { messageID: flatMessageID, callID: flatCallID };
  return undefined;
}

export function parseOpencodePermissionEntry(value: unknown): ParsedOpencodePermission | null {
  const p = asRecord(value);
  if (!p) return null;
  const requestId = asString(p["id"]) || asString(p["requestID"]) || asString(p["requestId"]);
  const sessionID = asString(p["sessionID"]) || asString(p["sessionId"]);
  const permission = asString(p["permission"]) || asString(p["action"]) || asString(p["type"]);
  if (!requestId || !sessionID || !permission) return null;
  const metadata = asRecord(p["metadata"]) ?? {};
  const parsed: ParsedOpencodePermission = {
    requestId,
    sessionID,
    permission,
    patterns: asStringArray(p["patterns"] ?? p["resources"] ?? p["pattern"]),
    metadata,
    always: asStringArray(p["always"] ?? p["save"])
  };
  const tool = toolOf(p);
  if (tool) parsed.tool = tool;
  return parsed;
}

export function parseOpencodePermissionAsked(event: unknown): ParsedOpencodePermission | null {
  const envelope = asRecord(event);
  if (!envelope) return null;
  if (envelope["type"] !== "permission.asked" && envelope["type"] !== "permission.v2.asked") return null;
  return parseOpencodePermissionEntry(envelope["properties"] ?? envelope["data"]);
}

export function parseOpencodePermissionReplied(event: unknown): ParsedOpencodePermissionReply | null {
  const envelope = asRecord(event);
  if (!envelope) return null;
  const type = envelope["type"];
  if (type !== "permission.replied" && type !== "permission.v2.replied" && type !== "permission.updated") return null;
  const p = asRecord(envelope["properties"] ?? envelope["data"]) ?? {};
  const requestID =
    asString(p["requestID"]) || asString(p["requestId"]) || asString(p["id"]) || asString(p["permissionID"]);
  if (!requestID) return null;
  const reply = asString(p["reply"]) || asString(p["response"]);
  return {
    requestID,
    sessionID: asString(p["sessionID"]) || asString(p["sessionId"]),
    ...(reply ? { reply } : {})
  };
}

export function parseOpencodePermissionList(payload: unknown): ParsedOpencodePermission[] {
  const container = asRecord(payload);
  const rawItems: unknown = Array.isArray(payload) ? payload : container?.["data"];
  if (!Array.isArray(rawItems)) return [];
  const parsed: ParsedOpencodePermission[] = [];
  for (const item of rawItems) {
    const entry = parseOpencodePermissionEntry(item);
    if (entry) parsed.push(entry);
  }
  return parsed;
}

function approvalKindOf(permission: string): ApprovalKind {
  const name = permission.toLowerCase();
  if (name.startsWith("bash") || name.startsWith("shell") || name.startsWith("command")) return "command";
  if (name.startsWith("edit") || name.startsWith("write") || name.startsWith("patch")) return "fileChange";
  return "permissions";
}

export function permissionApprovalOf(parsed: ParsedOpencodePermission, turnId: string, cwd = ""): ThreadEvent {
  const head = parsed.patterns[0];
  const title = head
    ? `${parsed.permission}: ${head}${parsed.patterns.length > 1 ? ` (+${parsed.patterns.length - 1} more)` : ""}`
    : `${parsed.permission} permission requested`;
  const detailsParts = [`permission: ${parsed.permission}`];
  detailsParts.push(parsed.patterns.length > 0 ? `patterns:\n${parsed.patterns.map((p) => `- ${p}`).join("\n")}` : "patterns: (none)");
  if (parsed.always.length > 0) {
    detailsParts.push(`Always would allow:\n${parsed.always.map((a) => `- ${a}`).join("\n")}`);
  }
  const metadataKeys = Object.keys(parsed.metadata);
  if (metadataKeys.length > 0) {
    detailsParts.push(`metadata: ${truncate(JSON.stringify(parsed.metadata), 500)}`);
  }
  const request: ApprovalRequest = {
    requestId: parsed.requestId,
    kind: approvalKindOf(parsed.permission),
    title,
    reason: `opencode session ${parsed.sessionID} needs permission`,
    details: detailsParts.join("\n"),
    decisions: [...OPENCODE_APPROVAL_DECISIONS],
    permission: parsed.permission,
    patterns: [...parsed.patterns],
    always: [...parsed.always],
    toolName: parsed.permission,
    ...(cwd ? { cwd } : {})
  };
  return { type: "approval.request", turnId, request };
}

export function opencodePermissionReply(decision: ApprovalDecision): OpencodePermissionReply {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "once";
    case "acceptGlobal":
      return "always";
    case "decline":
    case "cancel":
      return "reject";
    default:
      return "reject";
  }
}
