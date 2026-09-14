import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, QuestionInfo, ThreadEvent } from "@cw-code/contracts";
import { OpencodeDriver } from "./OpencodeDriver.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const questions: QuestionInfo[] = [
  { question: "Preferred color?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false, allowCustom: false }
];

function seed(driver: OpencodeDriver, requestId = "que_1"): void {
  const internals = driver as unknown as {
    pendingQuestions: Map<string, { requestId: string; turnId: string; sessionID: string; questions: QuestionInfo[]; cwd: string }>;
    watchInfo: Map<string, { port: number; authHeader: string; cwd: string }>;
  };
  internals.pendingQuestions.set(requestId, {
    requestId,
    turnId: "turn-1",
    sessionID: "ses_1",
    questions,
    cwd: "C:\\proj"
  });
  internals.watchInfo.set("turn-1", { port: 41234, authHeader: "auth", cwd: "C:\\proj" });
}

function makeDriver(events: ThreadEvent[]): OpencodeDriver {
  const pool = {
    ensure: async () => ({ port: 41234, authHeader: "auth" }),
    beginTurn: () => {},
    endTurn: () => {},
    invalidate: () => {},
    dispose: () => {}
  };
  return new OpencodeDriver(
    (e) => {
      events.push(e);
    },
    () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
    pool as unknown as OpencodeServerPool
  );
}

const html = (): Response =>
  new Response("<!doctype html><html></html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });

describe("OpencodeDriver question reply routing", () => {
  it("posts answers to the v2 session route with the documented payload", async () => {
    const events: ThreadEvent[] = [];
    const seen: string[] = [];
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        seen.push(url);
        body = String(init?.body ?? "");
        return Promise.resolve(new Response(null, { status: 204 }));
      })
    );
    const driver = makeDriver(events);
    try {
      seed(driver);
      await driver.respondToQuestion("que_1", { "Preferred color?": "Red" });
      expect(seen).toEqual(["http://127.0.0.1:41234/api/session/ses_1/question/que_1/reply"]);
      expect(JSON.parse(body)).toEqual({ answers: [["Red"]] });
      expect(events).toContainEqual({ type: "question.resolved", turnId: "turn-1", requestId: "que_1", answers: { "Preferred color?": "Red" } });
    } finally {
      driver.dispose();
    }
  });

  it("skips SPA HTML fallbacks instead of treating them as success", async () => {
    const events: ThreadEvent[] = [];
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        if (url.endsWith("/question/que_1/reply") && !url.includes("/session/")) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(html());
      })
    );
    const driver = makeDriver(events);
    try {
      seed(driver);
      await driver.respondToQuestion("que_1", { "Preferred color?": "Red" });
      expect(seen).toEqual([
        "http://127.0.0.1:41234/api/session/ses_1/question/que_1/reply",
        "http://127.0.0.1:41234/question/que_1/reply"
      ]);
      expect(events).toContainEqual({ type: "question.resolved", turnId: "turn-1", requestId: "que_1", answers: { "Preferred color?": "Red" } });
    } finally {
      driver.dispose();
    }
  });

  it("throws instead of silently succeeding when every route returns HTML", async () => {
    const events: ThreadEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(html()))
    );
    const driver = makeDriver(events);
    try {
      seed(driver);
      await expect(driver.respondToQuestion("que_1", { "Preferred color?": "Red" })).rejects.toThrow(
        "no accepted route"
      );
      expect(events.filter((e) => e.type === "question.resolved")).toEqual([]);
      const internals = driver as unknown as { pendingQuestions: Map<string, unknown> };
      expect(internals.pendingQuestions.has("que_1")).toBe(true);
    } finally {
      driver.dispose();
    }
  });
});
