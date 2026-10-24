import type { OpencodeEvent, OpencodeEventDecoder } from "../opencodeProtocol.js";
import { parseOpencodeQuestionAsked, parseOpencodeQuestionReplied } from "../opencodeQuestions.js";
import { parseOpencodePermissionAsked, parseOpencodePermissionReplied } from "../opencodePermissions.js";
import {
  parseOpencodeSessionError,
  parseOpencodeSessionParent,
  parseOpencodeStatusRetry,
  parseOpencodeTodosUpdated
} from "../opencodeEvents.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function propsOf(event: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(event["properties"]) ?? asRecord(event["data"]);
}

function isIdleStatus(props: Record<string, unknown> | null): boolean {
  const status = props?.["status"];
  if (typeof status === "string") return status === "idle";
  return asRecord(status)?.["type"] === "idle";
}

function decodeV1Event(event: unknown): OpencodeEvent[] {
  const envelope = asRecord(event);
  if (!envelope) return [];
  const type = envelope["type"];
  if (type === "question.asked") {
    const question = parseOpencodeQuestionAsked(event);
    return question ? [{ kind: "question.asked", question }] : [];
  }
  if (type === "question.replied" || type === "question.rejected") {
    const parsed = parseOpencodeQuestionReplied(event);
    return parsed ? [{ kind: "question.resolved", requestId: parsed.requestID }] : [];
  }
  if (type === "session.created" || type === "session.updated") {
    const lineage = parseOpencodeSessionParent(event);
    return lineage ? [{ kind: "session.parent", ...lineage }] : [];
  }
  if (type === "permission.asked" || type === "permission.v2.asked") {
    return [{ kind: "permission.asked", permission: parseOpencodePermissionAsked(event) }];
  }
  if (type === "permission.replied" || type === "permission.v2.replied" || type === "permission.updated") {
    const parsed = parseOpencodePermissionReplied(event);
    return parsed ? [{ kind: "permission.replied", requestId: parsed.requestID }] : [];
  }
  if (type === "todo.updated") {
    const parsed = parseOpencodeTodosUpdated(event);
    return parsed ? [{ kind: "todos", ...parsed }] : [];
  }
  const props = propsOf(envelope);
  const sessionID = typeof props?.["sessionID"] === "string" ? props["sessionID"] : "";
  if (type === "message.updated") {
    const info = asRecord(props?.["info"]);
    const id = info?.["id"];
    if (!sessionID || typeof id !== "string" || !id) return [];
    return info?.["summary"] === true || info?.["mode"] === "compaction"
      ? [{ kind: "message.compaction", sessionID, messageID: id }]
      : [];
  }
  if (type === "message.part.updated") {
    const part = asRecord(props?.["part"]);
    const id = part?.["id"];
    const partType = part?.["type"];
    if (!sessionID || typeof id !== "string" || !id || typeof partType !== "string" || !partType) return [];
    return [{ kind: "part.type", sessionID, partID: id, partType }];
  }
  if (type === "message.part.delta") {
    const field = props?.["field"];
    const text = props?.["delta"];
    if (!sessionID || typeof field !== "string" || !field || typeof text !== "string" || !text) return [];
    const partID = typeof props?.["partID"] === "string" ? props["partID"] : "";
    const messageID = typeof props?.["messageID"] === "string" ? props["messageID"] : "";
    return [{ kind: "delta", sessionID, messageID, partID, field, text }];
  }
  if (type === "session.status") {
    const retry = parseOpencodeStatusRetry(event);
    if (retry) return [{ kind: "retry", retry }];
  }
  if (type === "session.error") {
    const parsed = parseOpencodeSessionError(event);
    if (!parsed || parsed.name === "ContextOverflowError") return [];
    return [{ kind: "turn.ended", sessionID: parsed.sessionID, reason: "failed", error: parsed.message }];
  }
  if (type === "session.idle" || (type === "session.status" && isIdleStatus(props))) {
    return sessionID ? [{ kind: "turn.ended", sessionID, reason: "completed" }] : [];
  }
  return [];
}

export const opencodeV1EventDecoder: OpencodeEventDecoder = { decode: decodeV1Event };
