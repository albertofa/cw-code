import type {
  ApprovalDecision,
  CliDriver,
  DriverKind,
  HistoryMessage,
  ModelOption,
  SessionEvent,
  SessionMeta,
  TurnHandle,
  TurnRequest
} from "@cw-code/contracts";
import { previewText, traceHarnessCall, truncateError } from "./harnessTrace.js";

export class TracingCliDriver implements CliDriver {
  readonly kind: DriverKind;

  constructor(private inner: CliDriver) {
    this.kind = inner.kind;
  }

  async listSessions(projectRoot: string, projectId = ""): Promise<SessionMeta[]> {
    const start = Date.now();
    const operation = `${this.kind}.listSessions`;
    try {
      const sessions = await this.inner.listSessions(projectRoot, projectId);
      traceHarnessCall({
        harness: this.kind,
        operation,
        cwd: projectRoot,
        durationMs: Date.now() - start,
        ok: true,
        extra: { count: sessions.length }
      });
      return sessions;
    } catch (err) {
      traceHarnessCall({
        harness: this.kind,
        operation,
        cwd: projectRoot,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  async getHistory(projectRoot: string, resumeCursor: string): Promise<HistoryMessage[]> {
    const start = Date.now();
    const operation = `${this.kind}.getHistory`;
    try {
      const messages = await this.inner.getHistory(projectRoot, resumeCursor);
      traceHarnessCall({
        harness: this.kind,
        operation,
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: true,
        extra: { messageCount: messages.length }
      });
      return messages;
    } catch (err) {
      traceHarnessCall({
        harness: this.kind,
        operation,
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  startTurn(request: TurnRequest): TurnHandle {
    const start = Date.now();
    const operation = `${this.kind}.startTurn`;
    const prompt = typeof request.prompt === "string" ? request.prompt : "";
    const preview = previewText(prompt);
    try {
      const handle = this.inner.startTurn(request);
      traceHarnessCall({
        harness: this.kind,
        operation,
        sessionId: request.sessionId,
        turnId: handle.turnId,
        cwd: request.cwd,
        model: request.model,
        promptPreview: preview.preview,
        promptLength: preview.length,
        resumeCursor: request.resumeCursor,
        durationMs: Date.now() - start,
        ok: true
      });
      return handle;
    } catch (err) {
      traceHarnessCall({
        harness: this.kind,
        operation,
        sessionId: request.sessionId,
        cwd: request.cwd,
        promptPreview: preview.preview,
        promptLength: preview.length,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  interrupt(turnId: string): void {
    traceHarnessCall({ harness: this.kind, operation: `${this.kind}.interrupt`, turnId, ok: true });
    this.inner.interrupt(turnId);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const start = Date.now();
    const operation = `${this.kind}.renameSession`;
    try {
      await this.inner.renameSession(sessionId, title);
      traceHarnessCall({
        harness: this.kind,
        operation,
        sessionId,
        durationMs: Date.now() - start,
        ok: true
      });
    } catch (err) {
      traceHarnessCall({
        harness: this.kind,
        operation,
        sessionId,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  events(): AsyncIterable<SessionEvent> {
    return this.inner.events();
  }

  async listModels(cwd: string): Promise<ModelOption[]> {
    if (typeof this.inner.listModels !== "function") return [];
    return this.inner.listModels(cwd);
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const start = Date.now();
    const operation = `${this.kind}.respondToApproval`;
    try {
      if (typeof this.inner.respondToApproval !== "function") return;
      await this.inner.respondToApproval(requestId, decision);
      traceHarnessCall({
        harness: this.kind,
        operation,
        resumeCursor: requestId,
        durationMs: Date.now() - start,
        ok: true,
        extra: { decision }
      });
    } catch (err) {
      traceHarnessCall({
        harness: this.kind,
        operation,
        resumeCursor: requestId,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  async respondToQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const start = Date.now();
    const operation = `${this.kind}.respondToQuestion`;
    try {
      if (typeof this.inner.respondToQuestion !== "function") return;
      await this.inner.respondToQuestion(requestId, answers);
      traceHarnessCall({
        harness: this.kind,
        operation,
        resumeCursor: requestId,
        durationMs: Date.now() - start,
        ok: true,
        extra: { questionCount: Object.keys(answers).length }
      });
    } catch (err) {
      traceHarnessCall({
        harness: this.kind,
        operation,
        resumeCursor: requestId,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  dispose(): void {
    this.inner.dispose?.();
  }
}
