import { afterEach, describe, expect, it } from "vitest";
import { AskBridge, bridgeReplyPayload, normalizeBridgeQuestions } from "./askBridge.js";
import type { QuestionRequest } from "@cw-code/contracts";
import type { AddressInfo } from "node:net";

describe("normalizeBridgeQuestions", () => {
  it("maps bridge questions onto the contract shape", () => {
    expect(
      normalizeBridgeQuestions([
        {
          question: "Preferred color?",
          header: "Color",
          options: [{ label: "Red", description: "Red" }, { label: "Blue" }],
          multiple: false
        },
        { question: "Which extras?", options: [{ label: "Lint" }], multiple: true }
      ])
    ).toEqual([
      { question: "Preferred color?", header: "Color", options: [{ label: "Red", description: "Red" }, { label: "Blue" }], multiSelect: false, allowCustom: true },
      { question: "Which extras?", options: [{ label: "Lint" }], multiSelect: true, allowCustom: true }
    ]);
  });

  it("drops malformed entries and empty payloads", () => {
    expect(normalizeBridgeQuestions(["junk", { question: "", options: [{ label: "a" }] }])).toEqual([]);
    expect(normalizeBridgeQuestions(undefined)).toEqual([]);
  });
});

describe("bridgeReplyPayload", () => {
  const questions = [
    { question: "Preferred color?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false, allowCustom: false },
    { question: "Which extras?", options: [{ label: "Lint" }, { label: "Docs" }], multiSelect: true, allowCustom: false }
  ];

  it("builds per-question label arrays in order", () => {
    expect(bridgeReplyPayload(questions, { "Preferred color?": "Blue", "Which extras?": "Lint, Docs" })).toEqual({
      answers: [["Blue"], ["Lint", "Docs"]]
    });
  });
});

describe("AskBridge", () => {
  const received: Array<{ sessionID: string; request: QuestionRequest }> = [];
  let bridge: AskBridge;
  let baseUrl = "";

  const start = async () => {
    received.length = 0;
    bridge = new AskBridge((sessionID, request) => {
      received.push({ sessionID, request });
    });
    const port = await bridge.start();
    baseUrl = `http://127.0.0.1:${port}`;
    return baseUrl;
  };

  afterEach(() => {
    bridge.dispose();
  });

  const settle = () => new Promise<void>((r) => setTimeout(r, 60));

  it("routes a chat ask to the renderer and resolves the pending HTTP call", async () => {
    await start();
    const pendingFetch = fetch(`${baseUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: "ses_abc",
        questions: [{ question: "Preferred color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiple: false }]
      })
    });
    await settle();
    expect(received).toHaveLength(1);
    const { sessionID, request } = received[0];
    expect(sessionID).toBe("ses_abc");
    expect(request.requestId.startsWith("bridge:")).toBe(true);
    expect(request.turnId).toBe("");
    expect(request.questions).toHaveLength(1);
    expect(bridge.resolve(request.requestId, { "Preferred color?": "Blue" })).toBe(true);
    const res = await pendingFetch;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answers: string[][] };
    expect(body.answers).toEqual([["Blue"]]);
  });

  it("persists label ordering for multi-select answers", async () => {
    await start();
    const questions = [
      { question: "Which extras?", options: [{ label: "Lint" }, { label: "Docs" }], multiple: true }
    ];
    const pendingFetch = fetch(`${baseUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: "ses_1", questions })
    });
    await settle();
    const { request } = received[0];
    expect(bridge.resolve(request.requestId, { "Which extras?": "Docs, Lint" })).toBe(true);
    const body = (await (await pendingFetch).json()) as { answers: string[][] };
    expect(body.answers).toEqual([["Docs", "Lint"]]);
  });

  it("rejects malformed asks and unknown routes", async () => {
    const base = await start();
    const bad = await fetch(`${base}/ask`, { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/other`, { method: "GET" })).status).toBe(404);
  });

  it("abandons a pending ask when the turn dies", async () => {
    const base = await start();
    const pendingFetch = fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: "ses_1", questions: [{ question: "q?", options: [{ label: "a" }] }] })
    });
    await settle();
    const requestId = received[0].request.requestId;
    expect(bridge.abandon(requestId)).toBe(true);
    expect((await pendingFetch).status).toBe(410);
    expect(bridge.resolve(requestId, { "q?": "a" })).toBe(false);
  });
});
