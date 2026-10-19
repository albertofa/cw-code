import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandOption, ModelOption, NativeSession } from "@cw-code/contracts";
import { traceHarnessCall } from "../../../debug/harnessTrace.js";
import { OPENCODE_LIST_TIMEOUT_MS, OPENCODE_REQUEST_TIMEOUT_MS } from "../opencodeFetch.js";
import { sameDirectory } from "../opencodePaths.js";
import { lastOpencodeUserMessageId, opencodeRevertMessageId, type OpencodeBuiltinCommand } from "../opencodeCommands.js";
import { parseOpencodePermissionList, type OpencodePermissionReply, type ParsedOpencodePermission } from "../opencodePermissions.js";
import type { ParsedOpencodeQuestion } from "../opencodeQuestions.js";
import {
  isHtmlResponse,
  opencodeFailureText,
  opencodeJson,
  type OpencodeClient,
  type OpencodeEvent,
  type OpencodeMessage,
  type OpencodeProtocol,
  type OpencodeSendInput,
  type OpencodeSendResult,
  type OpencodeSessionSummary
} from "../opencodeProtocol.js";
import { OpencodeV2EventDecoder } from "./opencodeV2Events.js";
import { mapV2Messages, v2PendingChildren, v2RunIds, v2Running, v2TurnEnded } from "./opencodeV2Messages.js";
import { parseV2PendingForms, v2FormAnswer } from "./opencodeV2Forms.js";
import { activeSessionIds } from "./opencodeV2Server.js";
import {
  buildV2CommandOptions,
  directoryCommandTemplates,
  v2CommandEntries,
  v2ConfigCommandSources,
  v2SkillIds
} from "./opencodeV2Commands.js";
import { mapV2Models } from "./opencodeV2Models.js";

const PAGE_LIMIT = 200;
const RECENT_LIMIT = 50;
const MAX_PAGES = 50;
const SESSION_LIST_PAGES = 4;
const NATIVE_SESSION_LIST_PAGES = 20;
const MIGRATION_WAIT_MS = 60_000;
const MIGRATION_POLL_MS = 1_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sessionPath(sessionId: string, suffix = ""): string {
  return `/api/session/${encodeURIComponent(sessionId)}${suffix}`;
}

function dataOf(payload: unknown): unknown {
  return asRecord(payload)?.["data"];
}

function nextCursor(payload: unknown): string {
  return asString(asRecord(asRecord(payload)?.["cursor"])?.["next"]);
}

async function readJson(res: Response, label: string): Promise<unknown> {
  return opencodeJson<unknown>(res, label);
}

async function migrationPending(client: OpencodeClient): Promise<boolean> {
  try {
    const res = await client.request("/api/experimental/migration/v1", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    if (!res.ok || isHtmlResponse(res)) return false;
    const status = asString(asRecord((await res.json()) as unknown)?.["status"]);
    return status === "running" || status === "required";
  } catch {
    return false;
  }
}

async function waitForMigration(client: OpencodeClient, sessionId: string, deadline: number): Promise<boolean> {
  if (Date.now() > deadline || !(await migrationPending(client))) return false;
  traceHarnessCall({
    harness: "opencode",
    operation: "opencode.v2.migrationWait",
    resumeCursor: sessionId,
    ok: true
  });
  await new Promise((resolve) => setTimeout(resolve, MIGRATION_POLL_MS));
  return true;
}

async function sessionActive(client: OpencodeClient, sessionId: string): Promise<boolean> {
  const res = await client.request("/api/session/active", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
  if (!res.ok || isHtmlResponse(res)) return false;
  return activeSessionIds((await res.json()) as unknown).includes(sessionId);
}

async function currentModel(client: OpencodeClient, sessionId: string): Promise<{ providerID: string; id: string } | null> {
  const res = await client.request(sessionPath(sessionId), { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
  if (!res.ok || isHtmlResponse(res)) return null;
  const model = asRecord(asRecord(dataOf((await res.json()) as unknown))?.["model"]);
  const providerID = asString(model?.["providerID"]);
  const id = asString(model?.["id"]);
  return providerID && id ? { providerID, id } : null;
}

/** Applies the turn's model and variant to the session; returns a notice when it had to be skipped. */
async function switchModel(client: OpencodeClient, sessionId: string, input: OpencodeSendInput): Promise<string | undefined> {
  if (!input.model && !input.variant) return undefined;
  if (await sessionActive(client, sessionId)) {
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.v2.modelSwitch",
      ok: false,
      error: "session is running, kept its current model",
      extra: { sessionId }
    });
    return "opencode is still running this session, so the model and effort picked for this message apply from the next one.\n\n";
  }
  const model = input.model ? { providerID: input.model.providerID, id: input.model.modelID } : await currentModel(client, sessionId);
  if (!model) return undefined;
  const res = await client.request(sessionPath(sessionId, "/model"), {
    method: "POST",
    body: { model: { ...model, ...(input.variant ? { variant: input.variant } : {}) } },
    signal: input.signal,
    timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS
  });
  if (!res.ok) throw new Error(await opencodeFailureText("opencode model switch failed", res));
  return undefined;
}

async function admittedIdOf(response: Response): Promise<string> {
  if (!response.ok || response.status === 204 || isHtmlResponse(response)) return "";
  const payload = (await response.clone().json().catch(() => null)) as unknown;
  return asString(asRecord(dataOf(payload))?.["id"]);
}

async function admitted(response: Response, notice: string | undefined): Promise<OpencodeSendResult> {
  const admittedId = await admittedIdOf(response);
  return { response, settled: false, ...(admittedId ? { admittedId } : {}), ...(notice ? { notice } : {}) };
}

async function skillIdFor(client: OpencodeClient, name: string): Promise<string | null> {
  const commands = await client.request("/api/command", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
  if (commands.ok && !isHtmlResponse(commands)) {
    const listed = v2CommandEntries((await commands.json()) as unknown, []);
    if (listed.some((entry) => entry.name === name)) return null;
  }
  const skills = await client.request("/api/skill", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
  if (!skills.ok || isHtmlResponse(skills)) return null;
  return v2CommandEntries([], (await skills.json()) as unknown).find((entry) => entry.name === name)?.skill ?? null;
}

async function mentionedSkillIds(client: OpencodeClient, names: readonly string[]): Promise<Array<{ id: string }>> {
  try {
    const res = await client.request("/api/skill", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    if (!res.ok || isHtmlResponse(res)) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as unknown;
    const ids = v2SkillIds(payload, names);
    const missing = names.filter((name) => v2SkillIds(payload, [name]).length === 0);
    if (missing.length > 0) console.warn(`opencode skills not listed, sent as text only: ${missing.join(", ")}`);
    return ids;
  } catch (err) {
    console.warn(`opencode skill list failed; skills sent as text only: ${(err as Error).message}`);
    return [];
  }
}

async function rejectedSkills(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  return /skill/i.test(await response.clone().text().catch(() => ""));
}

function fileAttachments(input: OpencodeSendInput): Array<{ uri: string; name: string }> {
  return input.files.map((file) => ({ uri: pathToFileURL(file.path).href, name: basename(file.path) }));
}

async function requestMessages(client: OpencodeClient, sessionId: string, query: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + MIGRATION_WAIT_MS;
  for (;;) {
    const res = await client.request(sessionPath(sessionId, `/message?${query}`), { timeoutMs });
    if (res.status !== 404 || !(await waitForMigration(client, sessionId, deadline))) return res;
  }
}

async function loadMessages(
  client: OpencodeClient,
  sessionId: string,
  opts: { label: string; recent?: boolean; timeoutMs?: number }
): Promise<OpencodeMessage[]> {
  const timeoutMs = opts.timeoutMs ?? (opts.recent ? OPENCODE_LIST_TIMEOUT_MS : OPENCODE_REQUEST_TIMEOUT_MS);
  if (opts.recent) {
    const payload = await readJson(await requestMessages(client, sessionId, `order=desc&limit=${RECENT_LIMIT}`, timeoutMs), opts.label);
    const data = dataOf(payload);
    return mapV2Messages(Array.isArray(data) ? [...data].reverse() : []);
  }
  const raw: unknown[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = `order=asc&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const payload = await readJson(await requestMessages(client, sessionId, query, timeoutMs), opts.label);
    const data = dataOf(payload);
    const items = Array.isArray(data) ? data : [];
    raw.push(...items);
    cursor = nextCursor(payload);
    if (items.length < PAGE_LIMIT || !cursor) break;
  }
  return mapV2Messages(raw);
}

async function revert(client: OpencodeClient, sessionId: string, name: "undo" | "redo", signal: AbortSignal): Promise<string> {
  const session = dataOf(await readJson(await client.request(sessionPath(sessionId), { signal }), "opencode session lookup failed"));
  const revertId = opencodeRevertMessageId(session);
  if (name === "redo") {
    if (!revertId) throw new Error("Nothing to redo");
    const res = await client.request(sessionPath(sessionId, "/revert"), { method: "DELETE", signal });
    if (!res.ok) throw new Error(await opencodeFailureText("opencode redo failed", res));
    return "Restored the reverted messages.";
  }
  const messages = await loadMessages(client, sessionId, { label: "opencode history failed" });
  const messageID = lastOpencodeUserMessageId(messages, revertId);
  if (!messageID) throw new Error("Nothing to undo");
  const res = await client.request(sessionPath(sessionId, "/revert/stage"), { method: "POST", body: { messageID }, signal });
  if (!res.ok) throw new Error(await opencodeFailureText("opencode undo failed", res));
  return "Reverted the last message and its file changes.";
}

export const opencodeV2Protocol: OpencodeProtocol = {
  version: "v2",
  todosFromTools: true,

  async listSessions(client): Promise<OpencodeSessionSummary[]> {
    const out: OpencodeSessionSummary[] = [];
    let cursor = "";
    for (let page = 0; page < SESSION_LIST_PAGES; page++) {
      const query = `directory=${encodeURIComponent(client.cwd)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await client.request(`/api/session?${query}`, { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
      if (!res.ok) throw new Error(`opencode session list failed: ${res.status}`);
      const payload = await readJson(res, "opencode session list failed");
      const data = dataOf(payload);
      const items = Array.isArray(data) ? data : [];
      for (const entry of items) {
        const session = asRecord(entry);
        const id = asString(session?.["id"]);
        const directory = asString(asRecord(session?.["location"])?.["directory"]);
        if (!id || asString(session?.["parentID"]) || !sameDirectory(directory, client.cwd)) continue;
        const time = asRecord(session?.["time"]);
        out.push({
          id,
          title: asString(session?.["title"]),
          created: typeof time?.["created"] === "number" ? time["created"] : 0,
          updated: typeof time?.["updated"] === "number" ? time["updated"] : 0
        });
      }
      cursor = nextCursor(payload);
      if (items.length === 0 || !cursor) break;
    }
    return out;
  },

  async listNativeSessions(client): Promise<NativeSession[]> {
    const out: NativeSession[] = [];
    let cursor = "";
    for (let page = 0; page < NATIVE_SESSION_LIST_PAGES; page++) {
      const query = `parentID=null&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await client.request(`/api/session?${query}`, { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
      const payload = await readJson(res, "opencode session list failed");
      const data = dataOf(payload);
      const items = Array.isArray(data) ? data : [];
      for (const entry of items) {
        const session = asRecord(entry);
        const id = asString(session?.["id"]);
        const cwd = asString(asRecord(session?.["location"])?.["directory"]);
        const time = asRecord(session?.["time"]);
        if (!id || !cwd || asString(session?.["parentID"]) || time?.["archived"]) continue;
        const created = typeof time?.["created"] === "number" ? time["created"] : 0;
        out.push({
          driver: "opencode",
          resumeCursor: id,
          title: asString(session?.["title"]) || id.slice(0, 8),
          cwd,
          createdAt: created,
          updatedAt: typeof time?.["updated"] === "number" ? time["updated"] : created
        });
      }
      cursor = nextCursor(payload);
      if (items.length === 0 || !cursor) break;
    }
    return out;
  },

  async createSession(client): Promise<string> {
    const res = await client.request("/api/session", {
      method: "POST",
      body: { location: { directory: client.cwd } },
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS
    });
    if (!res.ok) throw new Error(await opencodeFailureText("opencode session create failed", res));
    const data = asRecord(dataOf(await readJson(res, "opencode session create failed")));
    const id = asString(data?.["id"]);
    if (!id) throw new Error("opencode session create returned no id");
    const directory = asString(asRecord(data?.["location"])?.["directory"]);
    if (!directory || !sameDirectory(directory, client.cwd)) {
      throw new Error(
        `opencode server ignored the session directory (wanted ${client.cwd}, got ${directory || "none"}); update the opencode CLI`
      );
    }
    return id;
  },

  async sessionExists(client, sessionId): Promise<boolean> {
    const deadline = Date.now() + MIGRATION_WAIT_MS;
    for (;;) {
      const res = await client.request(sessionPath(sessionId), { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
      if (res.ok && !isHtmlResponse(res)) return true;
      if (res.status !== 404) throw new Error(`opencode session probe failed: ${res.status}`);
      if (!(await waitForMigration(client, sessionId, deadline))) return false;
    }
  },

  async awaitSession(client, sessionId): Promise<void> {
    await opencodeV2Protocol.sessionExists(client, sessionId);
  },

  async sessionParent(client, sessionId): Promise<string | null> {
    try {
      const res = await client.request(sessionPath(sessionId), { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
      if (!res.ok || isHtmlResponse(res)) return null;
      return asString(asRecord(dataOf((await res.json()) as unknown))?.["parentID"]) || null;
    } catch {
      return null;
    }
  },

  messages: loadMessages,

  async nativeQuestionAvailable(): Promise<boolean> {
    return true;
  },

  subscribe(client, signal): Promise<Response> {
    return client.request("/api/event", { accept: "text/event-stream", signal, timeoutMs: 0 });
  },

  decoder() {
    return new OpencodeV2EventDecoder();
  },

  async send(client, sessionId, input: OpencodeSendInput): Promise<OpencodeSendResult> {
    const notice = await switchModel(client, sessionId, input);
    const files = fileAttachments(input);
    const post = (suffix: string, body: Record<string, unknown>): Promise<Response> =>
      client.request(sessionPath(sessionId, suffix), {
        method: "POST",
        body: { ...body, ...(files.length > 0 ? { files } : {}) },
        signal: input.signal,
        timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS
      });
    if (!input.command) {
      const skills = input.skills?.length ? await mentionedSkillIds(client, input.skills) : [];
      if (skills.length === 0) return admitted(await post("/prompt", { text: input.prompt }), notice);
      const withSkills = await post("/prompt", { text: input.prompt, skills });
      if (!(await rejectedSkills(withSkills))) return admitted(withSkills, notice);
      console.warn(`opencode rejected skills ${skills.map((s) => s.id).join(", ")}; resending as text only`);
      return admitted(await post("/prompt", { text: input.prompt }), notice);
    }
    const skill = await skillIdFor(client, input.command.name);
    if (skill) return admitted(await post("/prompt", { text: input.command.args, skills: [{ id: skill }] }), notice);
    return admitted(await post("/command", { name: input.command.name, text: input.command.args }), notice);
  },

  interrupt(client, sessionId): Promise<Response> {
    return client.request(sessionPath(sessionId, "/interrupt"), { method: "POST", timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
  },

  async builtin(client, sessionId, name: OpencodeBuiltinCommand, opts) {
    if (name === "compact") {
      const res = await client.request(sessionPath(sessionId, "/compact"), {
        method: "POST",
        body: {},
        signal: opts.signal,
        timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS
      });
      if (!res.ok) throw new Error(await opencodeFailureText("opencode compact failed", res));
      const admittedId = await admittedIdOf(res);
      return { settled: false, ...(admittedId ? { admittedId } : {}) };
    }
    return { notice: await revert(client, sessionId, name, opts.signal), settled: true };
  },

  async replyQuestion(client, question: ParsedOpencodeQuestion, answers): Promise<boolean> {
    const res = await client.request(
      `${sessionPath(question.sessionID)}/form/${encodeURIComponent(question.requestId)}/reply`,
      { method: "POST", body: { answer: v2FormAnswer(question, answers) }, timeoutMs: OPENCODE_LIST_TIMEOUT_MS }
    );
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(await opencodeFailureText("opencode question reply failed", res));
    return true;
  },

  async pendingForms(client): Promise<OpencodeEvent[]> {
    const res = await client.request("/api/form", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    if (!res.ok || isHtmlResponse(res)) return [];
    return parseV2PendingForms((await res.json()) as unknown);
  },

  async dismissForm(client, sessionId, formId, message): Promise<void> {
    const res = await client.request(
      `${sessionPath(sessionId)}/form/${encodeURIComponent(formId)}?message=${encodeURIComponent(message)}`,
      { method: "DELETE", timeoutMs: OPENCODE_LIST_TIMEOUT_MS }
    );
    if (!res.ok && res.status !== 404) throw new Error(await opencodeFailureText("opencode form dismiss failed", res));
  },

  async replyPermission(client, sessionId, requestId, reply: OpencodePermissionReply): Promise<"replied" | "missing"> {
    const res = await client.request(
      `${sessionPath(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: "POST", body: { decision: reply }, timeoutMs: OPENCODE_LIST_TIMEOUT_MS }
    );
    if (res.status === 404) return "missing";
    if (!res.ok) throw new Error(await opencodeFailureText("opencode permission reply failed", res));
    return "replied";
  },

  async listPermissions(client): Promise<ParsedOpencodePermission[] | null> {
    const res = await client.request("/api/permission/request", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    if (!res.ok || isHtmlResponse(res)) return null;
    return parseOpencodePermissionList((await res.json()) as unknown);
  },

  async listCommands(client): Promise<CommandOption[]> {
    const commands = await readJson(
      await client.request("/api/command", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS }),
      "opencode command list failed"
    );
    const skillsRes = await client.request("/api/skill", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    const skills = skillsRes.ok && !isHtmlResponse(skillsRes) ? ((await skillsRes.json()) as unknown) : [];
    const configRes = await client.request("/api/config", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS });
    const config = configRes.ok && !isHtmlResponse(configRes) ? ((await configRes.json()) as unknown) : [];
    const sources = v2ConfigCommandSources(config);
    const templates = new Map(sources.templates);
    for (const directory of sources.directories) {
      for (const [name, template] of await directoryCommandTemplates(directory)) templates.set(name, template);
    }
    return buildV2CommandOptions(v2CommandEntries(commands, skills), templates);
  },

  async listModels(client): Promise<ModelOption[]> {
    return mapV2Models(
      await readJson(await client.request("/api/model", { timeoutMs: OPENCODE_LIST_TIMEOUT_MS }), "opencode model list failed")
    );
  },

  turnEnded: v2TurnEnded,

  pendingChildren(messages, beforeIds): string[] {
    return v2PendingChildren(messages, beforeIds);
  },

  async reattachState(client, sessionId, messages: OpencodeMessage[]) {
    if (!v2Running(messages) || !(await sessionActive(client, sessionId))) return { running: false };
    return { running: true, runIds: v2RunIds(messages) };
  }
};
