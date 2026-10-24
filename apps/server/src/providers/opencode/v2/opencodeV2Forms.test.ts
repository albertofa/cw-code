import { describe, expect, it } from "bun:test";
import { parseV2PendingForms, parseV2QuestionForm, v2FormAnswer } from "./opencodeV2Forms.js";

const QUESTION_FORM = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    { key: "q0", title: "Color", description: "Favourite color?", type: "string", options: [{ value: "Red", label: "Red" }], custom: true },
    {
      key: "q1",
      title: "Pets",
      description: "Which pets?",
      type: "multiselect",
      options: [{ value: "cat", label: "Cat" }, { value: "dog", label: "Dog" }]
    }
  ]
};

describe("v2 forms", () => {
  it("keeps the field keys parallel to the questions", () => {
    const parsed = parseV2QuestionForm(QUESTION_FORM);
    expect(parsed?.questions.map((q) => [q.question, q.multiSelect, q.allowCustom])).toEqual([
      ["Favourite color?", false, true],
      ["Which pets?", true, false]
    ]);
    expect(parsed?.fields).toEqual([
      { key: "q0", type: "string" },
      { key: "q1", type: "multiselect", values: { Cat: "cat", Dog: "dog" } }
    ]);
  });

  it("builds the reply answer by field key with option values", () => {
    const parsed = parseV2QuestionForm(QUESTION_FORM)!;
    expect(v2FormAnswer(parsed, { "Favourite color?": "Teal", "Which pets?": "Cat, Dog" })).toEqual({
      q0: "Teal",
      q1: ["cat", "dog"]
    });
    expect(v2FormAnswer(parsed, { "Favourite color?": "" })).toEqual({});
  });

  it("answers boolean fields with Yes and No", () => {
    const parsed = parseV2QuestionForm({ id: "frm_2", sessionID: "ses_1", title: "Confirm", fields: [{ key: "ok", type: "boolean", title: "Proceed?" }] })!;
    expect(parsed.questions[0]).toMatchObject({ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }], allowCustom: false });
    expect(v2FormAnswer(parsed, { "Proceed?": "Yes" })).toEqual({ ok: true });
    expect(v2FormAnswer(parsed, { "Proceed?": "No" })).toEqual({ ok: false });
  });

  it("refuses forms the question dock cannot answer", () => {
    expect(parseV2QuestionForm({ id: "frm_3", sessionID: "global", title: "Login", fields: [{ key: "n", type: "number" }] })).toBeNull();
    expect(
      parseV2QuestionForm({
        id: "frm_4",
        sessionID: "ses_1",
        title: "Conditional",
        fields: [{ key: "a", type: "string", when: [{ key: "b", op: "eq", value: "x" }] }]
      })
    ).toBeNull();
    expect(parseV2QuestionForm({ id: "frm_5", sessionID: "ses_1", title: "Empty", fields: [] })).toBeNull();
  });

  it("reads the pending form list as questions and forms to dismiss", () => {
    const login = { id: "frm_login", sessionID: "ses_child", title: "Login", fields: [{ key: "n", type: "number" }] };
    const global = { id: "frm_global", sessionID: "global", title: "MCP", fields: [{ key: "a", type: "string" }] };
    expect(parseV2PendingForms({ data: [QUESTION_FORM, login, global, { id: "frm_x" }] })).toEqual([
      { kind: "question.asked", question: parseV2QuestionForm(QUESTION_FORM)! },
      { kind: "form.unsupported", sessionID: "ses_child", formId: "frm_login", title: "Login" }
    ]);
  });
});
