import { describe, expect, it } from "vitest";
import {
  opencodeReplyPayload,
  opencodeSseEvent,
  parseOpencodeQuestionAsked,
  parseOpencodeQuestionReplied,
  questionRequestOf
} from "./opencodeQuestions.js";

const askedEvent = {
  type: "question.asked",
  properties: {
    id: "que_123",
    sessionID: "ses_test",
    questions: [
      { question: "Preferred color?", header: "Color", options: [{ label: "Red", description: "Red" }, { label: "Blue" }], multiple: false },
      { question: "Which extras?", header: "Extras", options: [{ label: "Lint" }], multiple: true }
    ],
    tool: { messageID: "msg_1", callID: "call_1" }
  }
};

describe("parseOpencodeQuestionAsked", () => {
  it("maps a question.asked SSE event", () => {
    const parsed = parseOpencodeQuestionAsked(askedEvent);
    expect(parsed).toMatchObject({
      requestId: "que_123",
      sessionID: "ses_test",
      questions: [
        { question: "Preferred color?", header: "Color", multiSelect: false, allowCustom: true },
        { question: "Which extras?", header: "Extras", multiSelect: true, allowCustom: true }
      ]
    });
    expect(parsed!.questions[0].options).toEqual([
      { label: "Red", description: "Red" },
      { label: "Blue" }
    ]);
  });

  it("disables custom input when custom is false", () => {
    const parsed = parseOpencodeQuestionAsked({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "s", questions: [{ question: "q?", options: [{ label: "a" }], custom: false }] }
    });
    expect(parsed!.questions[0].allowCustom).toBe(false);
  });

  it("rejects malformed payloads and other event types", () => {
    expect(parseOpencodeQuestionAsked({ type: "session.updated", properties: {} })).toBeNull();
    expect(parseOpencodeQuestionAsked({ type: "question.asked", properties: { sessionID: "s" } })).toBeNull();
    expect(parseOpencodeQuestionAsked(null)).toBeNull();
  });
});

describe("parseOpencodeQuestionReplied", () => {
  it("maps replied and rejected events", () => {
    expect(parseOpencodeQuestionReplied({ type: "question.replied", properties: { sessionID: "s", requestID: "que_1" } })).toEqual({
      requestID: "que_1",
      sessionID: "s"
    });
    expect(parseOpencodeQuestionReplied({ type: "question.rejected", properties: { requestID: "que_2" } })).toEqual({
      requestID: "que_2",
      sessionID: ""
    });
    expect(parseOpencodeQuestionReplied({ type: "session.updated" })).toBeNull();
  });
});

describe("questionRequestOf", () => {
  it("carries the turn id", () => {
    const parsed = parseOpencodeQuestionAsked(askedEvent)!;
    expect(questionRequestOf(parsed, "turn-1")).toMatchObject({
      requestId: "que_123",
      turnId: "turn-1"
    });
  });
});

describe("opencodeSseEvent", () => {
  it("parses data lines and skips done markers", () => {
    expect(opencodeSseEvent(JSON.stringify(askedEvent))).toMatchObject({ type: "question.asked" });
    expect(opencodeSseEvent("data: " + JSON.stringify(askedEvent))).toMatchObject({ type: "question.asked" });
    expect(opencodeSseEvent("data: [DONE]")).toBeNull();
  });
});

describe("opencodeReplyPayload", () => {
  const questions = [
    { question: "Preferred color?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false, allowCustom: false },
    { question: "Which extras?", options: [{ label: "Lint" }, { label: "Docs" }], multiSelect: true, allowCustom: false }
  ];

  it("builds one string array per question in order", () => {
    expect(
      opencodeReplyPayload(questions, { "Preferred color?": "Red", "Which extras?": "Lint, Docs" })
    ).toEqual({ answers: [["Red"], ["Lint", "Docs"]] });
  });

  it("keeps free text and falls back to empty arrays", () => {
    expect(
      opencodeReplyPayload(questions, { "Preferred color?": "violet", "Which extras?": "" })
    ).toEqual({ answers: [["violet"], []] });
  });
});
