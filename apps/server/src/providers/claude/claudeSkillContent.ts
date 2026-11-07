/**
 * The Claude CLI answers a `Skill` tool call with a one-line `tool_result` ("Launching skill: x") and then
 * injects the skill body as a separate user message the model reads. The stream marks that message
 * `isSynthetic` with no link to the call; the transcript marks it `isMeta` with `sourceToolUseID`.
 * cw-code shows the body as the Skill call's output. Display only: a shape the CLI drops yields null.
 */

export const CLAUDE_SKILL_CONTENT_LIMIT = 8000;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "tool_result") return "";
    if (record["type"] === "text" && typeof record["text"] === "string") parts.push(record["text"]);
  }
  return parts.join("\n\n");
}

function parseObject(line: string): Record<string, unknown> | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function messageContent(msg: Record<string, unknown>): unknown {
  const message = msg["message"];
  return message !== null && typeof message === "object" ? (message as Record<string, unknown>)["content"] : undefined;
}

/** Text of a top-level synthetic user message on the stream, the carrier of a skill body. */
export function parseClaudeSyntheticUserText(line: string): string | null {
  if (!line.includes('"isSynthetic"')) return null;
  const msg = parseObject(line);
  if (!msg || msg["type"] !== "user" || msg["isSynthetic"] !== true || msg["parent_tool_use_id"]) return null;
  const text = contentText(messageContent(msg));
  return text.trim() ? text.slice(0, CLAUDE_SKILL_CONTENT_LIMIT) : null;
}

/** The skill body a transcript `isMeta` line carries for a tool call, keyed by that call's id. */
export function claudeTranscriptToolContent(line: {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  sourceToolUseID?: unknown;
  message?: { content?: unknown };
}): { toolUseId: string; text: string } | null {
  if (line.type !== "user" || line.isMeta !== true || line.isSidechain === true) return null;
  const toolUseId = line.sourceToolUseID;
  if (typeof toolUseId !== "string" || !toolUseId) return null;
  const text = contentText(line.message?.content);
  return text.trim() ? { toolUseId, text: text.slice(0, CLAUDE_SKILL_CONTENT_LIMIT) } : null;
}

export function isClaudeSkillTool(name: string | undefined): boolean {
  return name?.toLowerCase() === "skill";
}
