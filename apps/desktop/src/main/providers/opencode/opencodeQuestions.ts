import type { QuestionInfo, QuestionOption, QuestionRequest } from "@cw-code/contracts";

interface OpencodeQuestionPayload {
  id?: string;
  requestID?: string;
  sessionID?: string;
  questions?: unknown;
}

function optionOf(entry: unknown): QuestionOption | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const args = entry as Record<string, unknown>;
  if (typeof args["label"] !== "string" || !args["label"]) return null;
  const description = args["description"];
  return {
    label: args["label"],
    ...(typeof description === "string" && description ? { description } : {})
  };
}

function questionOf(entry: unknown): QuestionInfo | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const args = entry as Record<string, unknown>;
  if (typeof args["question"] !== "string" || !args["question"]) return null;
  const rawOptions = Array.isArray(args["options"]) ? args["options"] : [];
  const options = rawOptions.map(optionOf).filter((o): o is QuestionOption => o !== null);
  return {
    question: args["question"],
    ...(typeof args["header"] === "string" && args["header"] ? { header: args["header"] } : {}),
    options,
    multiSelect: args["multiple"] === true,
    allowCustom: args["custom"] !== false
  };
}

export interface ParsedOpencodeQuestion {
  requestId: string;
  sessionID: string;
  questions: QuestionInfo[];
}

export function parseOpencodeQuestionAsked(event: unknown): ParsedOpencodeQuestion | null {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const args = event as Record<string, unknown>;
  if (args["type"] !== "question.asked") return null;
  const props = args["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props)) return null;
  const p = props as Record<string, unknown>;
  const requestId = typeof p["id"] === "string" ? p.id : typeof p["requestID"] === "string" ? p["requestID"] : "";
  const sessionID = typeof p["sessionID"] === "string" ? p.sessionID : "";
  if (!requestId || !sessionID) return null;
  const raw = p["questions"];
  const questions = (Array.isArray(raw) ? raw : [])
    .map(questionOf)
    .filter((q): q is QuestionInfo => q !== null);
  if (questions.length === 0) return null;
  return { requestId, sessionID, questions };
}

export function parseOpencodeQuestionReplied(event: unknown): { requestID: string; sessionID: string } | null {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const args = event as Record<string, unknown>;
  if (args["type"] !== "question.replied" && args["type"] !== "question.rejected") return null;
  const p = args["properties"] as Record<string, unknown> | undefined;
  const requestID = p ? (typeof p["requestID"] === "string" ? p["requestID"] : typeof p["id"] === "string" ? p.id : "") : "";
  const sessionID = p && typeof p["sessionID"] === "string" ? p.sessionID : "";
  if (!requestID) return null;
  return { requestID, sessionID };
}

export function questionRequestOf(parsed: ParsedOpencodeQuestion, turnId: string): QuestionRequest {
  return {
    requestId: parsed.requestId,
    turnId,
    questions: parsed.questions
  };
}

export function opencodeSseEvent(line: string): unknown {
  const data = line.startsWith("data: ") ? line.slice(6) : line.trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

export function opencodeReplyPayload(
  questions: QuestionInfo[],
  answers: Record<string, string>
): { answers: string[][] } {
  return {
    answers: questions.map((q) => {
      const raw = answers[q.question] ?? "";
      return raw
        .split(", ")
        .map((part) => part.trim())
        .filter(Boolean);
    })
  };
}
