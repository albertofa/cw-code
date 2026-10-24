import type { CommandInvocation, CommandOption, ModelOption, NativeSession, TodoItem } from "@cw-code/contracts";
import type { ParsedOpencodePermission, OpencodePermissionReply } from "./opencodePermissions.js";
import type { ParsedOpencodeQuestion } from "./opencodeQuestions.js";
import type { OpencodeRetryStatus } from "./opencodeEvents.js";
import type { OpencodeProtocolVersion } from "./opencodeServerProbe.js";
import type { OpencodeBuiltinCommand } from "./opencodeCommands.js";

export type { OpencodeProtocolVersion };

export interface OpencodeRequestInit {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  accept?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OpencodeClient {
  readonly cwd: string;
  request(path: string, init?: OpencodeRequestInit): Promise<Response>;
}

export interface OpencodeMessagePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  filename?: string;
  mime?: string;
  url?: string;
  time?: { start?: number; end?: number };
}

export interface OpencodeMessageInfo {
  id?: string;
  role?: string;
  mode?: string;
  summary?: boolean;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  finish?: string;
  error?: unknown;
  time?: { created?: number; completed?: number };
}

/** The opencode v1 `{info, parts}` message shape; every protocol maps its messages into it. */
export interface OpencodeMessage {
  info?: OpencodeMessageInfo;
  parts?: OpencodeMessagePart[];
}

export interface OpencodeSessionSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
}

export interface OpencodeModelRef {
  providerID: string;
  modelID: string;
}

export interface OpencodeAttachment {
  mime: string;
  path: string;
}

export interface OpencodeSendInput {
  prompt: string;
  command?: CommandInvocation;
  skills?: string[];
  model: OpencodeModelRef | null;
  variant?: string;
  files: OpencodeAttachment[];
  signal: AbortSignal;
}

/** `settled` is true when the response itself marks the end of the turn (v1's blocking send). */
export interface OpencodeSendResult {
  response: Response;
  settled: boolean;
  /** Inbox id the server gave the prompt; its delivery marks where this turn's run starts. */
  admittedId?: string;
  notice?: string;
}

export type OpencodeTurnEndReason = "completed" | "failed" | "interrupted";

export interface OpencodeToolUpdate {
  sessionID: string;
  messageID: string;
  callId: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  metadata?: Record<string, unknown>;
}

export type OpencodeEvent =
  | { kind: "question.asked"; question: ParsedOpencodeQuestion }
  | { kind: "question.resolved"; requestId: string }
  | { kind: "session.parent"; sessionID: string; parentID: string }
  | { kind: "permission.asked"; permission: ParsedOpencodePermission | null }
  | { kind: "permission.replied"; requestId: string }
  | { kind: "todos"; sessionID: string; todos: TodoItem[] }
  | { kind: "message.compaction"; sessionID: string; messageID: string }
  | { kind: "part.type"; sessionID: string; partID: string; partType: string }
  | { kind: "delta"; sessionID: string; messageID: string; partID: string; field: string; text: string }
  | { kind: "retry"; retry: OpencodeRetryStatus }
  | { kind: "tool"; tool: OpencodeToolUpdate }
  | { kind: "input.delivered"; sessionID: string; inboxID: string }
  | { kind: "form.unsupported"; sessionID: string; formId: string; title: string }
  | { kind: "turn.ended"; sessionID: string; reason: OpencodeTurnEndReason; error?: string };

export interface OpencodeEventDecoder {
  decode(event: unknown): OpencodeEvent[];
}

/** `runIds` are the messages of the run still in flight; they count as new work for the reattached turn. */
export type OpencodeReattachState = { running: false } | { running: true; runIds: string[] };

export interface OpencodeProtocol {
  readonly version: OpencodeProtocolVersion;
  /** Tool events and poll diffs carry the todo list (v2 has no todo event). */
  readonly todosFromTools: boolean;
  listSessions(client: OpencodeClient): Promise<OpencodeSessionSummary[]>;
  /** Root sessions across every directory the server has recorded. */
  listNativeSessions(client: OpencodeClient): Promise<NativeSession[]>;
  createSession(client: OpencodeClient): Promise<string>;
  sessionExists(client: OpencodeClient, sessionId: string): Promise<boolean>;
  /** Resolves once a resumed session is readable (v2 copies v1 sessions in the background). */
  awaitSession(client: OpencodeClient, sessionId: string): Promise<void>;
  sessionParent(client: OpencodeClient, sessionId: string): Promise<string | null>;
  messages(
    client: OpencodeClient,
    sessionId: string,
    opts: { label: string; recent?: boolean; timeoutMs?: number }
  ): Promise<OpencodeMessage[]>;
  nativeQuestionAvailable(client: OpencodeClient, sessionId: string): Promise<boolean>;
  subscribe(client: OpencodeClient, signal: AbortSignal): Promise<Response>;
  decoder(): OpencodeEventDecoder;
  send(client: OpencodeClient, sessionId: string, input: OpencodeSendInput): Promise<OpencodeSendResult>;
  interrupt(client: OpencodeClient, sessionId: string): Promise<Response>;
  /** Runs a native builtin; resolves with the notice to show and whether the turn is over. */
  builtin(
    client: OpencodeClient,
    sessionId: string,
    name: OpencodeBuiltinCommand,
    opts: { model: OpencodeModelRef | null; signal: AbortSignal }
  ): Promise<{ notice?: string; settled: boolean; admittedId?: string }>;
  replyQuestion(client: OpencodeClient, question: ParsedOpencodeQuestion, answers: Record<string, string>): Promise<boolean>;
  /** Pending forms as question or unsupported-form events; v1 has none to poll. */
  pendingForms(client: OpencodeClient, sessionId: string): Promise<OpencodeEvent[]>;
  dismissForm(client: OpencodeClient, sessionId: string, formId: string, message: string): Promise<void>;
  replyPermission(
    client: OpencodeClient,
    sessionId: string,
    requestId: string,
    reply: OpencodePermissionReply
  ): Promise<"replied" | "missing">;
  /** Pending approvals for a session, or null when no route answered with JSON. */
  listPermissions(client: OpencodeClient, sessionId: string): Promise<ParsedOpencodePermission[] | null>;
  listCommands(client: OpencodeClient): Promise<CommandOption[]>;
  listModels?(client: OpencodeClient): Promise<ModelOption[]>;
  /** Poll fallback: the turn that started after `beforeIds` has ended (v2 also checks background children). */
  turnEnded(messages: OpencodeMessage[], beforeIds: Set<string>): boolean;
  /** Child sessions the turn launched in the background that have not finished yet. */
  pendingChildren(messages: OpencodeMessage[], beforeIds: Set<string> | null): string[];
  reattachState(client: OpencodeClient, sessionId: string, messages: OpencodeMessage[]): Promise<OpencodeReattachState>;
}

export async function opencodeFailureText(label: string, res: Response): Promise<string> {
  let detail = "";
  try {
    detail = (await res.text()).trim();
  } catch {
  }
  return `${label}: ${res.status}${detail ? ` ${detail.slice(0, 1000)}` : ""}`;
}

export function isHtmlResponse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/html");
}

export async function opencodeJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) throw new Error(await opencodeFailureText(label, res));
  if (isHtmlResponse(res)) {
    throw new Error(`${label}: server returned an HTML page instead of JSON`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(`${label}: invalid JSON response (${(err as Error).message})`);
  }
}
