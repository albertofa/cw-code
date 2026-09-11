import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AppSettings,
  ApprovalDecision,
  CliDriver,
  EffortLevel,
  HistoryMessage,
  PermissionMode,
  ThreadEvent,
  TurnHandle,
  TurnRequest
} from "@cw-code/contracts";
import { parseExtraArgs } from "../../settings/settingsUtils.js";
import { killProcessTree } from "../../processTree.js";
import { attributeClaudeSubagentEvent, buildClaudeAllowRule, claudeAllowResponse, claudeApprovalRequest, claudeQuestionRequest, claudeDenyResponse, claudeControlResponse, parseClaudeControlRequest, parseStreamLine, type ClaudeControlRequest } from "./claudeStreamParser.js";
import { listClaudeSessions } from "./claudeSessions.js";
import { readClaudeHistory } from "./claudeHistory.js";
import { previewText, traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

export const CLAUDE_CURATED_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "fable", label: "Fable 5.1" },
  { id: "haiku", label: "Haiku" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
];

export function mapClaudePermission(mode: PermissionMode | string): string {
  if (mode === "acceptEdits") return "acceptEdits";
  if (mode === "bypassPermissions") return "bypassPermissions";
  if (mode === "plan") return "plan";
  if (mode === "manual") return "manual";
  return "auto";
}

export function mapClaudeEffort(effort: EffortLevel | string): string {
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
    return effort;
  }
  return "medium";
}

export function buildClaudeArgs(request: Pick<TurnRequest, "resumeCursor" | "model" | "effort" | "permissionMode" | "allowedTools" | "maxTurns">): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--permission-prompt-tool", "stdio"
  ];
  if (request.resumeCursor) args.push("--resume", request.resumeCursor);
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", mapClaudeEffort(request.effort));
  if (request.permissionMode) args.push("--permission-mode", mapClaudePermission(request.permissionMode));
  if (request.allowedTools?.length) args.push("--allowedTools", request.allowedTools.join(","));
  if (request.maxTurns) args.push("--max-turns", String(request.maxTurns));
  return args;
}

export interface PendingClaudeApproval {
  turnId: string;
  control: ClaudeControlRequest;
  cwd: string;
  localSessionId: string;
}

export interface ClaudeTurnMeta {
  localSessionId: string;
  cwd: string;
}

export function claudeSettingsPath(cwd: string): string {
  return join(cwd, ".claude", "settings.json");
}

export function mergeClaudeAllowRule(existing: unknown, rule: string): Record<string, unknown> {
  const base =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const permissions =
    base["permissions"] !== null && typeof base["permissions"] === "object" && !Array.isArray(base["permissions"])
      ? { ...(base["permissions"] as Record<string, unknown>) }
      : {};
  const allow = Array.isArray(permissions["allow"])
    ? [...(permissions["allow"] as unknown[])]
    : [];
  if (!allow.includes(rule)) allow.push(rule);
  return { ...base, permissions: { ...permissions, allow } };
}

export class ClaudeCliDriver implements CliDriver {
  readonly kind = "claude" as const;
  private procs = new Map<string, ChildProcess>();
  private pendingQuestions = new Map<string, { turnId: string; control: ClaudeControlRequest }>();
  private pendingApprovals = new Map<string, PendingClaudeApproval>();
  private turnMeta = new Map<string, ClaudeTurnMeta>();
  private sessionAllows = new Map<string, Set<string>>();

  constructor(
    private emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings
  ) {}

  private writeControl(turnId: string, line: string): void {
    const stdin = this.procs.get(turnId)?.stdin;
    if (!stdin) return;
    stdin.write(line + "\n");
  }

  private terminate(turnId: string): void {
    killProcessTree(this.procs.get(turnId));
  }

  private configuredBinary(): string {
    return this.getSettings().claudeBinaryPath;
  }

  private extraArgs(): string[] {
    return parseExtraArgs(this.getSettings().claudeExtraArgs);
  }

  async listSessions(projectRoot: string, projectId = ""): Promise<import("@cw-code/contracts").SessionMeta[]> {
    const start = Date.now();
    try {
      const sessions = await listClaudeSessions(projectId, projectRoot);
      traceHarnessCall({
        harness: "claude",
        operation: "claude.listSessions",
        cwd: projectRoot,
        durationMs: Date.now() - start,
        ok: true,
        extra: { count: sessions.length }
      });
      return sessions;
    } catch (err) {
      traceHarnessCall({
        harness: "claude",
        operation: "claude.listSessions",
        cwd: projectRoot,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  async getHistory(projectRoot: string, resumeCursor: string): Promise<HistoryMessage[]> {
    if (!resumeCursor) return [];
    const start = Date.now();
    try {
      const messages = await readClaudeHistory(projectRoot, resumeCursor);
      traceHarnessCall({
        harness: "claude",
        operation: "claude.getHistory",
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: true,
        extra: { messageCount: messages.length }
      });
      return messages;
    } catch (err) {
      traceHarnessCall({
        harness: "claude",
        operation: "claude.getHistory",
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
    const turnId = randomUUID();
    const start = Date.now();
    const baseArgs = buildClaudeArgs(request);
    const args = [...this.extraArgs(), ...baseArgs];
    const preview = previewText(request.prompt);
    const binary = this.configuredBinary();

    const child = spawn(binary, args, { cwd: request.cwd, windowsHide: true });
    this.procs.set(turnId, child);
    this.turnMeta.set(turnId, { localSessionId: request.sessionId, cwd: request.cwd });
    traceHarnessCall({
      harness: "claude",
      operation: "claude.startTurn",
      sessionId: request.sessionId,
      turnId,
      cwd: request.cwd,
      binary,
      args,
      model: request.model,
      promptPreview: preview.preview,
      promptLength: preview.length,
      resumeCursor: request.resumeCursor,
      ok: true
    });

    const rl = createInterface({ input: child.stdout });
    const agentByCall = new Map<string, string>();
    rl.on("line", (line) => {
      const control = parseClaudeControlRequest(line);
      if (control) {
        this.handleControl(control, turnId);
        return;
      }
      for (const event of parseStreamLine(line, turnId, request.resumeCursor ?? "", (info) => {
        this.emit({
          type: "turn.done",
          turnId,
          sessionId: request.sessionId,
          resumeCursor: info.resumeCursor,
          resultText: info.resultText,
          inputTokens: info.inputTokens,
          outputTokens: info.outputTokens,
          costUsd: info.costUsd,
          numTurns: info.numTurns,
          isError: info.isError
        });
        child.stdin?.end();
        if (!info.isError) this.terminate(turnId);
      })) {
        this.emit(attributeClaudeSubagentEvent(event, agentByCall));
      }
    });
    child.stdin?.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: request.prompt } })}\n`
    );

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      traceHarnessCall({
        harness: "claude",
        operation: "claude.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        binary,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError(`failed to spawn ${binary}: ${err.message}`)
      });
      this.emit({ type: "turn.error", turnId, message: `failed to spawn ${binary}: ${err.message}` });
    });
    child.on("close", (code) => {
      this.procs.delete(turnId);
      this.resolvePendingFor(turnId, null);
      traceHarnessCall({
        harness: "claude",
        operation: "claude.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        binary,
        durationMs: Date.now() - start,
        ok: code === 0,
        exitCode: code,
        stderrPreview: stderr ? truncateError(stderr) : undefined
      });
      if (code !== 0 && stderr && !child.killed) {
        this.emit({ type: "turn.error", turnId, message: stderr.slice(0, 2000) });
      }
    });

    return { turnId, events: (async function* () {})() };
  }

  interrupt(turnId: string): void {
    traceHarnessCall({ harness: "claude", operation: "claude.interrupt", turnId, ok: true });
    this.terminate(turnId);
    this.procs.delete(turnId);
  }

  private handleControl(control: ClaudeControlRequest, turnId: string): void {
    const question = claudeQuestionRequest(control, turnId);
    if (question) {
      this.pendingQuestions.set(control.requestId, { turnId, control });
      this.emit({ type: "question.request", turnId, request: question });
      return;
    }
    const meta = this.turnMeta.get(turnId);
    const cwd = meta?.cwd ?? "";
    const localSessionId = meta?.localSessionId ?? "";
    if (localSessionId && this.sessionAllows.get(localSessionId)?.has(control.toolName)) {
      this.writeControl(turnId, claudeAllowResponse(control.requestId, control.input));
      traceHarnessCall({
        harness: "claude",
        operation: "claude.autoAllowSession",
        turnId,
        cwd: cwd || undefined,
        ok: true,
        extra: { requestId: control.requestId, toolName: control.toolName }
      });
      return;
    }
    this.pendingApprovals.set(control.requestId, { turnId, control, cwd, localSessionId });
    this.emit({
      type: "approval.request",
      turnId,
      request: claudeApprovalRequest(control, turnId, cwd || undefined)
    });
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.pendingApprovals.get(requestId);
    if (!entry) return;
    this.pendingApprovals.delete(requestId);
    const { turnId, control, cwd, localSessionId } = entry;
    if (decision === "accept" || decision === "acceptForSession" || decision === "acceptGlobal") {
      if (localSessionId && (decision === "acceptForSession" || decision === "acceptGlobal")) {
        let allowed = this.sessionAllows.get(localSessionId);
        if (!allowed) {
          allowed = new Set<string>();
          this.sessionAllows.set(localSessionId, allowed);
        }
        allowed.add(control.toolName);
      }
      if (decision === "acceptGlobal") {
        await this.persistGlobalAllow(control.toolName, control.input, cwd, turnId);
      }
      this.writeControl(turnId, claudeAllowResponse(requestId, control.input));
    } else {
      const message = decision === "cancel" ? "Cancelled by user." : "Denied by user.";
      this.writeControl(turnId, claudeDenyResponse(requestId, message));
    }
    this.emit({ type: "approval.resolved", turnId, requestId });
    traceHarnessCall({
      harness: "claude",
      operation: "claude.respondToApproval",
      turnId,
      cwd: cwd || undefined,
      ok: true,
      extra: { requestId, decision, toolName: control.toolName }
    });
  }

  private async persistGlobalAllow(toolName: string, input: unknown, cwd: string, turnId: string): Promise<void> {
    const rule = buildClaudeAllowRule(toolName, input);
    const filePath = claudeSettingsPath(cwd);
    try {
      let raw: string | null = null;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      }
      let existing: unknown = null;
      if (raw !== null) {
        try {
          existing = JSON.parse(raw);
        } catch (err) {
          throw new Error(`existing settings are not valid JSON: ${(err as Error).message}`);
        }
        if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
          throw new Error("existing settings are not a JSON object; refusing to overwrite");
        }
      }
      const next = mergeClaudeAllowRule(existing, rule);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
      traceHarnessCall({
        harness: "claude",
        operation: "claude.persistGlobalAllow",
        turnId,
        cwd: cwd || undefined,
        ok: true,
        extra: { rule, filePath }
      });
    } catch (err) {
      const message = `Could not save global allow rule "${rule}" to ${filePath}: ${(err as Error).message}`;
      traceHarnessCall({
        harness: "claude",
        operation: "claude.persistGlobalAllow",
        turnId,
        cwd: cwd || undefined,
        ok: false,
        error: truncateError(message)
      });
      this.emit({ type: "turn.error", turnId, message });
    }
  }

  async respondToQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const entry = this.pendingQuestions.get(requestId);
    if (!entry) return;
    this.pendingQuestions.delete(requestId);
    this.writeControl(entry.turnId, claudeControlResponse(requestId, entry.control.input, answers));
    this.emit({
      type: "question.resolved",
      turnId: entry.turnId,
      requestId,
      answers
    });
  }

  private resolvePendingFor(turnId: string, answers: Record<string, string> | null): void {
    for (const [requestId, entry] of [...this.pendingQuestions]) {
      if (entry.turnId !== turnId) continue;
      this.pendingQuestions.delete(requestId);
      this.emit({ type: "question.resolved", turnId, requestId, answers });
    }
    for (const [requestId, entry] of [...this.pendingApprovals]) {
      if (entry.turnId !== turnId) continue;
      this.pendingApprovals.delete(requestId);
      this.emit({ type: "approval.resolved", turnId, requestId });
    }
    this.turnMeta.delete(turnId);
  }

  async renameSession(): Promise<void> {}

  async *events(): AsyncIterable<never> {}
}
