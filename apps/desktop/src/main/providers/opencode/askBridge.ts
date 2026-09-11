import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { QuestionInfo, QuestionOption, QuestionRequest } from "@cw-code/contracts";
import { traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

export interface BridgeAskBody {
  sessionID?: unknown;
  questions?: unknown;
}

interface PendingAsk {
  res: ServerResponse;
  questions: QuestionInfo[];
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

export function normalizeBridgeQuestions(input: unknown): QuestionInfo[] {
  const raw = Array.isArray(input) ? input : [];
  const questions: QuestionInfo[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const args = entry as Record<string, unknown>;
    if (typeof args["question"] !== "string" || !args["question"]) continue;
    const rawOptions = Array.isArray(args["options"]) ? args["options"] : [];
    const options = rawOptions.map(optionOf).filter((o): o is QuestionOption => o !== null);
    questions.push({
      question: args["question"],
      ...(typeof args["header"] === "string" && args["header"] ? { header: args["header"] } : {}),
      options,
      multiSelect: args["multiple"] === true,
      allowCustom: true
    });
  }
  return questions;
}

export function bridgeReplyPayload(
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

const LABEL_LIMIT = 480;

export class AskBridge {
  private server: Server | null = null;
  private portValue = 0;
  private pending = new Map<string, PendingAsk>();

  constructor(private onQuestion: (sessionID: string, request: QuestionRequest) => void) {}

  async start(): Promise<number> {
    if (this.server) return this.portValue;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", (err) => reject(err));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    this.portValue = port;
    traceHarnessCall({
      harness: "opencode",
      operation: "askBridge.start",
      ok: true,
      extra: { bridgePort: port }
    });
    return port;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/ask") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) overflow = true;
    });
    await new Promise<void>((resolve) => req.on("end", resolve));
    if (overflow) {
      res.writeHead(413).end();
      return;
    }
    let parsed: BridgeAskBody;
    try {
      parsed = JSON.parse(body) as BridgeAskBody;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const sessionID = typeof parsed.sessionID === "string" ? parsed.sessionID : "";
    const questions = normalizeBridgeQuestions(parsed.questions).map((q) => ({
      ...q,
      options: q.options.map((o) => ({
        ...o,
        label: o.label.slice(0, LABEL_LIMIT),
        ...(o.description ? { description: o.description.slice(0, LABEL_LIMIT) } : {})
      }))
    }));
    if (!sessionID || questions.length === 0) {
      res.writeHead(400).end();
      return;
    }
    const requestId = `bridge:${randomUUID()}`;
    this.pending.set(requestId, { res, questions });
    this.onQuestion(sessionID, { requestId, turnId: "", questions });
  }

  resolve(requestId: string, answers: Record<string, string>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    try {
      entry.res.writeHead(200, { "Content-Type": "application/json" });
      entry.res.end(JSON.stringify(bridgeReplyPayload(entry.questions, answers)));
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation: "askBridge.resolve",
        resumeCursor: requestId,
        ok: false,
        error: truncateError((err as Error).message)
      });
      return false;
    }
    return true;
  }

  abandon(requestId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    try {
      entry.res.writeHead(410).end();
    } catch {
    }
    return true;
  }

  dispose(): void {
    for (const requestId of [...this.pending.keys()]) this.abandon(requestId);
    this.server?.close();
    this.server = null;
    this.portValue = 0;
  }
}
