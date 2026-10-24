import type { OpencodeEvent, OpencodeEventDecoder, OpencodeToolUpdate } from "../opencodeProtocol.js";
import { parseOpencodePermissionEntry } from "../opencodePermissions.js";
import { v2FormEvent } from "./opencodeV2Forms.js";
import { V2_SUBAGENT_TOOL, v2ContentText } from "./opencodeV2Messages.js";

const TOOL_NAME_LIMIT = 512;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class OpencodeV2EventDecoder implements OpencodeEventDecoder {
  private toolNames = new Map<string, string>();

  decode(event: unknown): OpencodeEvent[] {
    const envelope = asRecord(event);
    const type = asString(envelope?.["type"]);
    const data = asRecord(envelope?.["data"]);
    if (!type || !data) return [];
    const sessionID = asString(data["sessionID"]);
    switch (type) {
      case "session.text.delta":
      case "session.reasoning.delta": {
        const text = asString(data["delta"]);
        const messageID = asString(data["assistantMessageID"]);
        if (!sessionID || !text) return [];
        const field = type === "session.text.delta" ? "text" : "reasoning";
        return [{ kind: "delta", sessionID, messageID, partID: `${messageID}:${String(data["ordinal"] ?? 0)}:${field}`, field, text }];
      }
      case "session.tool.input.started":
        return this.tool(data, "pending");
      case "session.tool.called":
        return this.tool(data, "running", { input: asRecord(data["input"]) ?? {} });
      case "session.tool.progress":
        return this.tool(data, "running", { metadata: asRecord(data["metadata"]) ?? {} });
      case "session.tool.success": {
        const metadata = asRecord(data["metadata"]) ?? {};
        const background = this.toolNames.get(asString(data["id"])) === V2_SUBAGENT_TOOL && metadata["status"] === "running";
        return this.tool(data, background ? "running" : "completed", {
          metadata,
          ...(background ? {} : { output: v2ContentText(data["content"]) })
        });
      }
      case "session.tool.failed":
        return this.tool(data, "error", {
          output: asString(asRecord(data["error"])?.["message"]) || v2ContentText(data["content"]) || "tool failed"
        });
      case "session.execution.succeeded":
        return sessionID ? [{ kind: "turn.ended", sessionID, reason: "completed" }] : [];
      case "session.execution.failed": {
        const error = asRecord(data["error"]);
        const message = asString(error?.["message"]) || asString(error?.["type"]) || "opencode turn failed";
        return sessionID ? [{ kind: "turn.ended", sessionID, reason: "failed", error: message }] : [];
      }
      case "session.execution.interrupted":
        return sessionID ? [{ kind: "turn.ended", sessionID, reason: "interrupted" }] : [];
      case "session.retry.scheduled": {
        const message = asString(asRecord(data["error"])?.["message"]);
        if (!sessionID || !message) return [];
        const attempt = typeof data["attempt"] === "number" && data["attempt"] > 0 ? Math.floor(data["attempt"]) : 0;
        const retryAt = typeof data["at"] === "number" && Number.isFinite(data["at"]) ? data["at"] : 0;
        return [{ kind: "retry", retry: { sessionID, attempt, message, retryAt } }];
      }
      case "session.created": {
        const parentID = asString(data["parentID"]);
        return sessionID && parentID ? [{ kind: "session.parent", sessionID, parentID }] : [];
      }
      case "permission.asked":
        return [{ kind: "permission.asked", permission: parseOpencodePermissionEntry(data) }];
      case "permission.replied": {
        const requestId = asString(data["requestID"]) || asString(data["id"]);
        return requestId ? [{ kind: "permission.replied", requestId }] : [];
      }
      case "form.created": {
        const form = v2FormEvent(data["form"]);
        return form ? [form] : [];
      }
      case "session.inbox.delivered": {
        const inboxID = asString(data["inboxID"]);
        return sessionID && inboxID ? [{ kind: "input.delivered", sessionID, inboxID }] : [];
      }
      case "form.replied":
      case "form.cancelled": {
        const requestId = asString(data["id"]);
        return requestId ? [{ kind: "question.resolved", requestId }] : [];
      }
      default:
        return [];
    }
  }

  private tool(
    data: Record<string, unknown>,
    status: OpencodeToolUpdate["status"],
    extra: Partial<Pick<OpencodeToolUpdate, "input" | "output" | "metadata">> = {}
  ): OpencodeEvent[] {
    const sessionID = asString(data["sessionID"]);
    const callId = asString(data["id"]);
    if (!sessionID || !callId) return [];
    const announced = asString(data["name"]);
    if (announced) this.rememberTool(callId, announced);
    const name = this.toolNames.get(callId) ?? "tool";
    return [
      {
        kind: "tool",
        tool: { sessionID, messageID: asString(data["assistantMessageID"]), callId, name, status, ...extra }
      }
    ];
  }

  private rememberTool(callId: string, name: string): void {
    this.toolNames.delete(callId);
    if (this.toolNames.size >= TOOL_NAME_LIMIT) {
      const oldest = this.toolNames.keys().next();
      if (!oldest.done) this.toolNames.delete(oldest.value);
    }
    this.toolNames.set(callId, name);
  }
}
