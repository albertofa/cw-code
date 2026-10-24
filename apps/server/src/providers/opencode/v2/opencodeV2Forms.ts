import type { QuestionInfo, QuestionOption } from "@cw-code/contracts";
import type { OpencodeQuestionField, ParsedOpencodeQuestion } from "../opencodeQuestions.js";
import type { OpencodeEvent } from "../opencodeProtocol.js";

const GLOBAL_FORM_OWNER = "global";
import { traceHarnessCall } from "../../../debug/harnessTrace.js";

const BOOLEAN_OPTIONS: QuestionOption[] = [{ label: "Yes" }, { label: "No" }];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionsOf(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionOption[] = [];
  for (const entry of raw) {
    const option = asRecord(entry);
    const label = asString(option?.["label"]) || asString(option?.["value"]);
    if (!label) continue;
    const description = asString(option?.["description"]);
    out.push({ label, ...(description ? { description } : {}) });
  }
  return out;
}

function fieldQuestion(field: Record<string, unknown>, formTitle: string): { question: QuestionInfo; field: OpencodeQuestionField } | null {
  const key = asString(field["key"]);
  const type = field["type"];
  if (!key || (type !== "string" && type !== "multiselect" && type !== "boolean") || field["when"] !== undefined) return null;
  const title = asString(field["title"]);
  const description = asString(field["description"]);
  const question = description || title || formTitle || key;
  const options = type === "boolean" ? BOOLEAN_OPTIONS : optionsOf(field["options"]);
  const values: Record<string, string> = {};
  for (const entry of Array.isArray(field["options"]) ? field["options"] : []) {
    const option = asRecord(entry);
    const label = asString(option?.["label"]);
    const value = asString(option?.["value"]);
    if (label && value && label !== value) values[label] = value;
  }
  return {
    question: {
      question,
      ...(title && title !== question ? { header: title } : {}),
      options,
      multiSelect: type === "multiselect",
      allowCustom: type !== "boolean" && (field["custom"] === true || options.length === 0)
    },
    field: { key, type, ...(Object.keys(values).length > 0 ? { values } : {}) }
  };
}

/** A v2 form as a cw-code question; null for forms with fields the question dock cannot answer. */
export function parseV2QuestionForm(value: unknown): ParsedOpencodeQuestion | null {
  const form = asRecord(value);
  const requestId = asString(form?.["id"]);
  const sessionID = asString(form?.["sessionID"]);
  const rawFields = Array.isArray(form?.["fields"]) ? (form?.["fields"] as unknown[]) : [];
  if (!form || !requestId || !sessionID || rawFields.length === 0) return null;
  const questions: QuestionInfo[] = [];
  const fields: OpencodeQuestionField[] = [];
  for (const raw of rawFields) {
    const mapped = asRecord(raw) ? fieldQuestion(raw as Record<string, unknown>, asString(form["title"])) : null;
    if (!mapped) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.v2.form",
        resumeCursor: requestId,
        ok: false,
        error: `form field ${asString(asRecord(raw)?.["key"]) || "?"} (${asString(asRecord(raw)?.["type"]) || "?"}) cannot be answered from the question dock`
      });
      return null;
    }
    questions.push(mapped.question);
    fields.push(mapped.field);
  }
  return { requestId, sessionID, questions, fields };
}

/** A form owned by a session: a question when the dock can answer it, otherwise a form to dismiss. */
export function v2FormEvent(value: unknown): OpencodeEvent | null {
  const form = asRecord(value);
  const formId = asString(form?.["id"]);
  const sessionID = asString(form?.["sessionID"]);
  if (!formId || !sessionID || sessionID === GLOBAL_FORM_OWNER) return null;
  const question = parseV2QuestionForm(form);
  if (question) return { kind: "question.asked", question };
  return { kind: "form.unsupported", sessionID, formId, title: asString(form?.["title"]) };
}

export function parseV2PendingForms(payload: unknown): OpencodeEvent[] {
  const data = asRecord(payload)?.["data"];
  const items = Array.isArray(data) ? data : Array.isArray(payload) ? payload : [];
  return items.map(v2FormEvent).filter((event): event is OpencodeEvent => event !== null);
}

export function v2FormAnswer(
  question: Pick<ParsedOpencodeQuestion, "questions" | "fields">,
  answers: Record<string, string>
): Record<string, string | boolean | string[]> {
  const answer: Record<string, string | boolean | string[]> = {};
  question.questions.forEach((q, index) => {
    const field = question.fields?.[index] ?? { key: `q${index}`, type: q.multiSelect ? "multiselect" : "string" };
    const raw = (answers[q.question] ?? "").trim();
    if (!raw) return;
    const valueOf = (label: string): string => field.values?.[label] ?? label;
    if (field.type === "multiselect") {
      answer[field.key] = raw.split(", ").map((part) => valueOf(part.trim())).filter(Boolean);
    } else if (field.type === "boolean") {
      answer[field.key] = raw.toLowerCase() === "yes";
    } else {
      answer[field.key] = valueOf(raw);
    }
  });
  return answer;
}
