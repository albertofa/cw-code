import { sameDirectory } from "../opencodePaths.js";
import { withDirectoryQuery, OPENCODE_LIST_TIMEOUT_MS, OPENCODE_NO_TIMEOUT, OPENCODE_REQUEST_TIMEOUT_MS } from "../opencodeFetch.js";
import {
  buildOpencodeCommandBody,
  lastOpencodeUserMessageId,
  mapOpencodeCommands,
  opencodeRevertMessageId
} from "../opencodeCommands.js";
import { buildOpencodeMessageBody, latestAssistantOf, runEnded } from "../opencodeMessage.js";
import { opencodeSessionParentId } from "../opencodeEvents.js";
import { opencodeReplyPayload, type ParsedOpencodeQuestion } from "../opencodeQuestions.js";
import {
  opencodePermissionReplyBody,
  opencodePermissionReplyRoutes,
  parseOpencodePermissionList,
  type OpencodePermissionReply,
  type ParsedOpencodePermission
} from "../opencodePermissions.js";
import {
  isHtmlResponse,
  opencodeFailureText,
  opencodeJson,
  type OpencodeClient,
  type OpencodeEvent,
  type OpencodeMessage,
  type OpencodeProtocol,
  type OpencodeReattachState,
  type OpencodeSendInput,
  type OpencodeSendResult,
  type OpencodeSessionSummary
} from "../opencodeProtocol.js";
import { opencodeV1EventDecoder } from "./opencodeV1Events.js";
import type { CommandOption } from "@cw-code/contracts";
import type { OpencodeBuiltinCommand } from "../opencodeCommands.js";

interface ServerSession {
  id: string;
  directory: string;
  title: string;
  time: { created: number; updated: number };
}

function sessionPath(sessionId: string, suffix = ""): string {
  return `/session/${encodeURIComponent(sessionId)}${suffix}`;
}

function questionInfoDenied(permission: unknown): boolean {
  if (permission === null || permission === undefined) return false;
  if (typeof permission === "string") return permission.trim() === "deny";
  const p = permission as { question?: unknown };
  const question = p?.question;
  return typeof question === "string" ? question.trim() === "deny" : false;
}

export const opencodeV1Protocol: OpencodeProtocol = {
  version: "v1",
  todosFromTools: false,

  async listSessions(client: OpencodeClient): Promise<OpencodeSessionSummary[]> {
    const res = await client.request(withDirectoryQuery("/session", client.cwd), { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    if (!res.ok) throw new Error(`opencode session list failed: ${res.status}`);
    const sessions = (await res.json()) as ServerSession[];
    return sessions
      .filter((s) => s.directory.toLowerCase() === client.cwd.toLowerCase())
      .map((s) => ({ id: s.id, title: s.title, created: s.time.created, updated: s.time.updated }));
  },

  async createSession(client: OpencodeClient): Promise<string> {
    const res = await client.request(withDirectoryQuery("/session", client.cwd), {
      method: "POST",
      body: {},
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS
    });
    if (!res.ok) throw new Error(`opencode session create failed: ${res.status}`);
    const data = (await res.json()) as { id?: string; directory?: string };
    if (!data.id) throw new Error("opencode session create returned no id");
    if (!data.directory || !sameDirectory(data.directory, client.cwd)) {
      throw new Error(
        `opencode server ignored the session directory (wanted ${client.cwd}, got ${data.directory ?? "none"}); update the opencode CLI`
      );
    }
    return data.id;
  },

  async sessionExists(client: OpencodeClient, sessionId: string): Promise<boolean> {
    const probe = await client.request(sessionPath(sessionId), { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    if (probe.status === 404) return false;
    if (!probe.ok) throw new Error(`opencode session probe failed: ${probe.status}`);
    if (isHtmlResponse(probe)) return false;
    return true;
  },

  async awaitSession(): Promise<void> {},

  async sessionParent(client: OpencodeClient, sessionId: string): Promise<string | null> {
    const encoded = encodeURIComponent(sessionId);
    for (const path of [`/session/${encoded}`, `/api/session/${encoded}`]) {
      let res: Response;
      try {
        res = await client.request(path, { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
      } catch {
        return null;
      }
      if (!res.ok) continue;
      if (isHtmlResponse(res)) continue;
      try {
        return opencodeSessionParentId((await res.json()) as unknown);
      } catch {
        continue;
      }
    }
    return null;
  },

  async messages(client, sessionId, opts): Promise<OpencodeMessage[]> {
    const res = await client.request(sessionPath(sessionId, opts.recent ? "/message?limit=50" : "/message"), {
      timeoutMs: opts.timeoutMs ?? (opts.recent ? OPENCODE_LIST_TIMEOUT_MS : OPENCODE_REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`${opts.label}: ${res.status}`);
    if (isHtmlResponse(res)) throw new Error(`${opts.label}: server returned an HTML page instead of JSON`);
    const payload = (await res.json()) as unknown;
    return Array.isArray(payload) ? (payload as OpencodeMessage[]) : [];
  },

  async nativeQuestionAvailable(client: OpencodeClient, sessionId: string): Promise<boolean> {
    if (!sessionId) return true;
    const res = await client.request(sessionPath(sessionId), { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    if (!res.ok || isHtmlResponse(res)) return false;
    const info = (await res.json()) as { permission?: unknown };
    return !questionInfoDenied(info.permission);
  },

  subscribe(client: OpencodeClient, signal: AbortSignal): Promise<Response> {
    return client.request("/event", { accept: "text/event-stream", signal, timeoutMs: 0 });
  },

  decoder() {
    return opencodeV1EventDecoder;
  },

  async send(client: OpencodeClient, sessionId: string, input: OpencodeSendInput): Promise<OpencodeSendResult> {
    const files = input.files.map((f) => ({ mime: f.mime, url: f.path }));
    const body = input.command
      ? buildOpencodeCommandBody(input.command, {
          model: input.model,
          ...(input.variant ? { variant: input.variant } : {}),
          ...(files.length > 0 ? { files } : {})
        })
      : buildOpencodeMessageBody(input.prompt, {
          ...(input.model ? { model: input.model } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
          ...(files.length > 0 ? { files } : {})
        });
    const response = await client.request(sessionPath(sessionId, input.command ? "/command" : "/message"), {
      method: "POST",
      body,
      signal: input.signal,
      timeoutMs: OPENCODE_NO_TIMEOUT
    });
    return { response, settled: true };
  },

  interrupt(client: OpencodeClient, sessionId: string): Promise<Response> {
    return client.request(sessionPath(sessionId, "/abort"), { method: "POST", timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
  },

  async builtin(client, sessionId, name: OpencodeBuiltinCommand, opts) {
    const call = (suffix: string, init: { method?: "POST"; body?: unknown; timeoutMs?: number } = {}): Promise<Response> =>
      client.request(sessionPath(sessionId, suffix), {
        method: init.method ?? "GET",
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: opts.signal,
        timeoutMs: init.timeoutMs ?? OPENCODE_REQUEST_TIMEOUT_MS
      });
    if (name === "compact") {
      if (!opts.model) throw new Error("Pick a model before compacting");
      const res = await call("/summarize", { method: "POST", body: opts.model, timeoutMs: OPENCODE_NO_TIMEOUT });
      if (!res.ok) throw new Error(await opencodeFailureText("opencode compact failed", res));
      return { settled: true };
    }
    const revertId = opencodeRevertMessageId(await opencodeJson<unknown>(await call(""), "opencode session lookup failed"));
    if (name === "redo") {
      if (!revertId) throw new Error("Nothing to redo");
      const res = await call("/unrevert", { method: "POST" });
      if (!res.ok) throw new Error(await opencodeFailureText("opencode redo failed", res));
      return { notice: "Restored the reverted messages.", settled: true };
    }
    const messageID = lastOpencodeUserMessageId(
      await opencodeJson<unknown>(await call("/message"), "opencode history failed"),
      revertId
    );
    if (!messageID) throw new Error("Nothing to undo");
    const res = await call("/revert", { method: "POST", body: { messageID } });
    if (!res.ok) throw new Error(await opencodeFailureText("opencode undo failed", res));
    return { notice: "Reverted the last message and its file changes.", settled: true };
  },

  async replyQuestion(client, question: ParsedOpencodeQuestion, answers): Promise<boolean> {
    const payload = opencodeReplyPayload(question.questions, answers);
    const sid = encodeURIComponent(question.sessionID);
    const rid = encodeURIComponent(question.requestId);
    for (const route of [`/api/session/${sid}/question/${rid}/reply`, `/question/${rid}/reply`]) {
      const res = await client.request(route, { method: "POST", body: payload, timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
      if (isHtmlResponse(res)) continue;
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`opencode question reply failed: ${res.status}`);
      return true;
    }
    return false;
  },

  async pendingForms(): Promise<OpencodeEvent[]> {
    return [];
  },

  async dismissForm(): Promise<void> {},

  async replyPermission(client, sessionId, requestId, reply: OpencodePermissionReply): Promise<"replied" | "missing"> {
    for (const route of opencodePermissionReplyRoutes(sessionId, requestId)) {
      const res = await client.request(route, {
        method: "POST",
        body: opencodePermissionReplyBody(route, reply),
        timeoutMs: OPENCODE_LIST_TIMEOUT_MS
      });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`opencode permission reply failed: ${res.status}`);
      if (isHtmlResponse(res)) continue;
      return "replied";
    }
    return "missing";
  },

  async listPermissions(client, sessionId): Promise<ParsedOpencodePermission[] | null> {
    const encoded = encodeURIComponent(sessionId);
    for (const path of [`/session/${encoded}/permission`, `/api/session/${encoded}/permission`, `/permission`]) {
      const res = await client.request(path, { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
      if (!res.ok) continue;
      if (isHtmlResponse(res)) continue;
      let payload: unknown;
      try {
        payload = (await res.json()) as unknown;
      } catch {
        continue;
      }
      return parseOpencodePermissionList(payload);
    }
    return null;
  },

  async listCommands(client: OpencodeClient): Promise<CommandOption[]> {
    const res = await client.request("/command", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    return mapOpencodeCommands(await opencodeJson<unknown>(res, "opencode command list failed"));
  },

  turnEnded(messages: OpencodeMessage[], beforeIds: Set<string>): boolean {
    return runEnded(messages, beforeIds);
  },

  pendingChildren(): string[] {
    return [];
  },

  async reattachState(_client, _sessionId, messages: OpencodeMessage[]): Promise<OpencodeReattachState> {
    const latest = latestAssistantOf(messages);
    if (!latest || latest.terminal) return { running: false };
    return { running: true, latestId: latest.id };
  }
};
