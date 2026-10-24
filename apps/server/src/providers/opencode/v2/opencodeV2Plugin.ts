import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { traceHarnessCall, truncateError } from "../../../debug/harnessTrace.js";

export const CW_PLUGIN_ID = "cw-code";

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

export function opencodeV2PluginSource(): string {
  return `const TODO_DESCRIPTION = ${JSON.stringify(TODO_DESCRIPTION)};
const ASK_DESCRIPTION = ${JSON.stringify(ASK_DESCRIPTION)};
const TODO_INPUT = ${JSON.stringify(TODO_INPUT)};
const ASK_INPUT = ${JSON.stringify(ASK_INPUT)};

function todoSummary(todos) {
  const open = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length;
  return "Todo list updated: " + todos.length + " item(s), " + open + " open.";
}

async function askUser(bridge, input, context) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  let res;
  try {
    res = await fetch(bridge, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: context.sessionID, messageID: context.messageID, questions }),
      signal: context.signal
    });
  } catch {
    return "Could not deliver the question to the user. Continue with your best judgment.";
  }
  if (!res.ok) return "Could not deliver the question to the user. Continue with your best judgment.";
  const data = await res.json();
  let text = "The user answered:";
  questions.forEach((q, index) => {
    const picked = (data.answers || [])[index] || [];
    text += (index > 0 ? ";" : "") + ' "' + q.question + '" = ' + (picked.length ? picked.join(", ") : "(no answer)");
  });
  return text;
}

export default {
  id: ${JSON.stringify(CW_PLUGIN_ID)},
  setup: async (ctx) => {
    const bridge = ctx.options && typeof ctx.options.askBridge === "string" ? ctx.options.askBridge : "";
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "todo",
        description: TODO_DESCRIPTION,
        options: { codemode: false },
        input: TODO_INPUT,
        execute: async (input) => ({ content: todoSummary(Array.isArray(input.todos) ? input.todos : []) })
      });
      if (!bridge) return;
      tools.add({
        name: "cw_ask",
        description: ASK_DESCRIPTION,
        options: { codemode: false },
        input: ASK_INPUT,
        execute: async (input, context) => ({ content: await askUser(bridge, input, context) })
      });
    });
    if (!bridge) return;
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

export function mergeConfigContent(existing: string | undefined, plugin: { package: string; options: Record<string, unknown> }): string {
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
  const source = opencodeV2PluginSource();
  await mkdir(dir, { recursive: true });
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing !== source) await writeFile(file, source, "utf8");
  return file;
}

export async function opencodeV2PluginEnv(
  dir: string,
  askBridge: string,
  existingConfigContent: string | undefined
): Promise<Record<string, string>> {
  try {
    const file = await writeOpencodeV2Plugin(dir);
    const content = mergeConfigContent(existingConfigContent, { package: dir, options: { askBridge } });
    traceHarnessCall({ harness: "opencode", operation: "opencode.v2.plugin", ok: true, extra: { file } });
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
