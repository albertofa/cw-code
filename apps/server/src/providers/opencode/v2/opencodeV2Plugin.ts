import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CW_SKILL_NAME, cwSkillMarkdown, cwToolName, SKILL_DESCRIPTION } from "../../../agent/cwSkill.js";
import { traceHarnessCall, truncateError } from "../../../debug/harnessTrace.js";
import { cwToolDefinitions } from "../../../mcp/cwTools.js";

export const CW_PLUGIN_ID = "cw-code";

export const SHELL_STRIPPED_ENV = ["OPENCODE_CONFIG_CONTENT", "OPENCODE_PASSWORD", "CW_AGENT_TOKEN", "CW_MCP_URL"] as const;

export interface OpencodeV2PluginOptions {
  askBridge: string;
  secretFile?: string;
  cwMcpUrl?: string;
}

const TODO_DESCRIPTION = [
  "Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.",
  "",
  "Use it when the task needs 3 or more distinct steps, when the user gives several tasks or asks for a todo list, and whenever new instructions arrive.",
  "Skip it for a single straightforward task or a purely conversational request.",
  "",
  "States: pending (not started), in_progress (exactly one at a time), completed (done and verified), cancelled (no longer needed).",
  "Send the whole list on every call. Update statuses in real time, mark an item completed only after the work is actually done, and keep one item in_progress while work remains."
].join("\n");

const ASK_DESCRIPTION =
  "Ask the user one or multiple-choice questions and wait for their selections. Use whenever user input, preferences or a decision is needed before continuing. Returns their chosen labels or typed answers.";

const TODO_INPUT = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The complete, updated todo list.",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "Brief description of the task." },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
          priority: { type: "string", enum: ["high", "medium", "low"] }
        },
        required: ["content", "status"]
      }
    }
  },
  required: ["todos"]
};

const ASK_INPUT = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "One or more questions to present to the user, in order.",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The complete question to display." },
          header: { type: "string", description: "Very short label (max 12 characters)." },
          options: {
            type: "array",
            description: "2-4 answer choices; put the recommended answer first.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short answer text (1-5 words)." },
                description: { type: "string", description: "One-line explanation of the choice." }
              },
              required: ["label"]
            }
          },
          multiple: { type: "boolean", description: "true to allow selecting multiple options." }
        },
        required: ["question", "options"]
      }
    }
  },
  required: ["questions"]
};

const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";

function cwTools(): Array<{ name: string; tool: string; description: string; input: Record<string, unknown> }> {
  return cwToolDefinitions().map((definition) => ({
    name: cwToolName("opencode", definition.name),
    tool: definition.name,
    description: definition.description,
    input: definition.inputSchema
  }));
}

export function opencodeSkillPath(pluginDir: string): string {
  return join(pluginDir, "skills", CW_SKILL_NAME, "SKILL.md");
}

export function opencodeV2PluginSource(pluginDir: string): string {
  const skill = {
    id: CW_SKILL_NAME,
    name: CW_SKILL_NAME,
    description: SKILL_DESCRIPTION,
    path: opencodeSkillPath(pluginDir),
    content: cwSkillMarkdown("opencode")
  };
  return `const TODO_DESCRIPTION = ${JSON.stringify(TODO_DESCRIPTION)};
const ASK_DESCRIPTION = ${JSON.stringify(ASK_DESCRIPTION)};
const TODO_INPUT = ${JSON.stringify(TODO_INPUT)};
const ASK_INPUT = ${JSON.stringify(ASK_INPUT)};
const CW_TOOLS = ${JSON.stringify(cwTools())};
const CW_SKILL = ${JSON.stringify(skill)};
const SHELL_STRIPPED_ENV = ${JSON.stringify(SHELL_STRIPPED_ENV)};
const SESSION_HEADER = "X-CW-Opencode-Session";
const MCP_PROTOCOL_VERSION = ${JSON.stringify(MCP_LEGACY_PROTOCOL_VERSION)};
const UNDELIVERED = "Could not deliver the question to the user. Continue with your best judgment.";

const SECRET_CACHE = Symbol.for("cw-code.opencode.secrets");
let rpcId = 0;

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

function stringOption(options, key) {
  return options && typeof options[key] === "string" ? options[key] : "";
}

async function readSecret(file) {
  if (!file) {
    console.error("[cw-code] no secretFile option; cw tools and cw_ask are disabled");
    return "";
  }
  const fs = await import("node:fs/promises");
  let secret;
  try {
    secret = (await fs.readFile(file, "utf8")).trim();
  } catch (err) {
    console.error("[cw-code] could not read the secret file " + file + "; cw tools and cw_ask are disabled: " + errorText(err));
    return "";
  }
  try {
    await fs.rm(file, { force: true });
  } catch (err) {
    console.error("[cw-code] could not delete the secret file " + file + ": " + errorText(err));
  }
  if (!secret) console.error("[cw-code] the secret file " + file + " is empty; cw tools and cw_ask are disabled");
  return secret;
}

function loadSecret(file) {
  const cache = globalThis[SECRET_CACHE] || (globalThis[SECRET_CACHE] = new Map());
  if (!cache.has(file)) cache.set(file, readSecret(file));
  return cache.get(file);
}

function todoSummary(todos) {
  const open = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length;
  return "Todo list updated: " + todos.length + " item(s), " + open + " open.";
}

async function askUser(bridge, secret, input, context) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  let res;
  try {
    res = await fetch(bridge, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
      body: JSON.stringify({ sessionID: context.sessionID, messageID: context.messageID, questions }),
      signal: context.signal
    });
  } catch {
    return UNDELIVERED;
  }
  if (!res.ok) return UNDELIVERED;
  const data = await res.json();
  let text = "The user answered:";
  questions.forEach((q, index) => {
    const picked = (data.answers || [])[index] || [];
    text += (index > 0 ? ";" : "") + ' "' + q.question + '" = ' + (picked.length ? picked.join(", ") : "(no answer)");
  });
  return text;
}

function rpcMessage(text, contentType) {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split(/\\r?\\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (data.length === 0) throw new Error("the event stream carried no data");
  return JSON.parse(data[data.length - 1]);
}

async function callCwTool(endpoint, secret, tool, input, context) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        Authorization: "Bearer " + secret,
        [SESSION_HEADER]: String(context.sessionID || "")
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: input || {} } }),
      signal: context.signal
    });
  } catch (err) {
    return "Error: could not reach cw-code: " + errorText(err);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return "Error: cw-code answered HTTP " + res.status + (text ? ": " + text.slice(0, 500) : "");
  let message;
  try {
    message = rpcMessage(text, res.headers.get("content-type") || "");
  } catch (err) {
    return "Error: cw-code sent an unreadable reply: " + errorText(err);
  }
  if (message.error) return "Error: " + (message.error.message || "cw-code rejected the call");
  const result = message.result || {};
  const body = (Array.isArray(result.content) ? result.content : [])
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\\n");
  if (result.isError) return "Error: " + (body || "the cw tool failed without a message");
  return body || "(no output)";
}

export default {
  id: ${JSON.stringify(CW_PLUGIN_ID)},
  setup: async (ctx) => {
    if (ctx.shell && typeof ctx.shell.hook === "function") {
      await ctx.shell.hook("create.before", (event) => {
        if (!event || !event.env) return;
        for (const key of SHELL_STRIPPED_ENV) delete event.env[key];
      });
    }
    const bridge = stringOption(ctx.options, "askBridge");
    const endpoint = stringOption(ctx.options, "cwMcpUrl");
    const secret = await loadSecret(stringOption(ctx.options, "secretFile"));
    if (secret && !endpoint) console.error("[cw-code] no cwMcpUrl option; cw tools are disabled");
    const ask = Boolean(secret && bridge);
    const tools = Boolean(secret && endpoint);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "todo",
        description: TODO_DESCRIPTION,
        options: { codemode: false },
        input: TODO_INPUT,
        execute: async (input) => ({ content: todoSummary(Array.isArray(input.todos) ? input.todos : []) })
      });
      if (ask) {
        editor.add({
          name: "cw_ask",
          description: ASK_DESCRIPTION,
          options: { codemode: false },
          input: ASK_INPUT,
          execute: async (input, context) => ({ content: await askUser(bridge, secret, input, context) })
        });
      }
      if (!tools) return;
      for (const definition of CW_TOOLS) {
        editor.add({
          name: definition.name,
          description: definition.description,
          options: { codemode: false },
          input: definition.input,
          execute: async (input, context) => ({ content: await callCwTool(endpoint, secret, definition.tool, input, context) })
        });
      }
    });
    if (tools) {
      if (ctx.skill && typeof ctx.skill.transform === "function") await ctx.skill.transform((skills) => skills.add(CW_SKILL));
      else console.error("[cw-code] this opencode has no skill API; the cw-code skill is not registered");
    }
    if (!ask) return;
    await ctx.session.hook("context", async (event) => {
      if (!event.tools.cw_ask) return;
      if (event.tools.question) {
        delete event.tools.cw_ask;
        return;
      }
      const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined);
      if (!session || session.parentID) delete event.tools.cw_ask;
    });
  }
};
`;
}

export function mergeConfigContent(existing: string | undefined, plugin: { package: string; options: OpencodeV2PluginOptions }): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    const parsed = JSON.parse(existing) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OPENCODE_CONFIG_CONTENT is not a JSON object");
    }
    base = parsed as Record<string, unknown>;
  }
  const plugins = Array.isArray(base["plugins"]) ? base["plugins"] : [];
  return JSON.stringify({ ...base, plugins: [...plugins, plugin] });
}

export async function writeOpencodeV2Plugin(dir: string): Promise<string> {
  const file = join(dir, "index.js");
  const source = opencodeV2PluginSource(dir);
  await mkdir(dir, { recursive: true });
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing !== source) await writeFile(file, source, "utf8");
  return file;
}

export async function writeOpencodeSecretFile(dir: string, secret: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `opencode-secret-${randomBytes(8).toString("hex")}`);
  await writeFile(file, secret, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

export async function opencodeV2PluginEnv(
  dir: string,
  options: OpencodeV2PluginOptions,
  existingConfigContent: string | undefined
): Promise<Record<string, string>> {
  try {
    const file = await writeOpencodeV2Plugin(dir);
    const content = mergeConfigContent(existingConfigContent, { package: dir, options });
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.v2.plugin",
      ok: true,
      extra: { file, cwTools: Boolean(options.secretFile && options.cwMcpUrl) }
    });
    return { OPENCODE_CONFIG_CONTENT: content };
  } catch (err) {
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.v2.plugin",
      ok: false,
      error: truncateError((err as Error).message)
    });
    throw err;
  }
}
