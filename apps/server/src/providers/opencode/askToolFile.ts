import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

export const ASK_TOOL_NAME = "cw_ask";

export function askToolSource(bridgeUrl: string): string {
  return [
    "export default {",
    `  description: "Ask the user one or multiple-choice questions and wait for their selections. Use whenever user input, preferences or a decision is needed before continuing. Returns their chosen labels or typed answers.",`,
    "  args: {",
    "    questions: {",
    '      type: "array",',
    '      description: "One or more questions to present to the user, in order.",',
    '      items: {',
    '        type: "object",',
    "        properties: {",
    '          question: { type: "string", description: "The complete question to display." },',
    '          header: { type: "string", description: "Very short label (max 12 characters)." },',
    "          options: {",
    '            type: "array",',
    '            description: "2-4 answer choices; put the recommended answer first.",',
    "            items: {",
    '              type: "object",',
    "              properties: {",
    '                label: { type: "string", description: "Short answer text (1-5 words)." },',
    '                description: { type: "string", description: "One-line explanation of the choice." }',
    "              },",
    '              required: ["label"]',
    "            }",
    "          },",
    '          multiple: { type: "boolean", description: "true to allow selecting multiple options." }',
    "        },",
    '        required: ["question", "options"]',
    "      }",
    "    }",
    "  },",
    `  async execute(args, context) {`,
    `    const res = await fetch(${JSON.stringify(bridgeUrl)}, {`,
    `      method: "POST",`,
    `      headers: { "Content-Type": "application/json" },`,
    `      body: JSON.stringify({ sessionID: context.sessionID, messageID: context.messageID, questions: args.questions })`,
    `    });`,
    `    if (!res.ok) return "Could not deliver the question to the user. Continue with your best judgment.";`,
    `    const data = await res.json();`,
    `    let text = "The user answered:";`,
    `    for (const [index, q] of (args.questions || []).entries()) {`,
    `      const picked = (data.answers || [])[index] || [];`,
    `      text += (index > 0 ? ";" : "") + ' "' + q.question + '" = ' + (picked.length ? picked.join(", ") : "(no answer)");`,
    `    }`,
    `    return text;`,
    `  }`,
    "}"
  ].join("\n");
}

export async function writeAskBridgeTool(root: string, bridgeUrl: string): Promise<string> {
  const toolsDir = join(root, "tools");
  const file = join(toolsDir, `${ASK_TOOL_NAME}.js`);
  try {
    await mkdir(toolsDir, { recursive: true });
    const existing = await readFile(file, "utf8").catch(() => undefined);
    if (existing !== askToolSource(bridgeUrl)) {
      await writeFile(file, askToolSource(bridgeUrl), "utf8");
    }
    traceHarnessCall({
      harness: "opencode",
      operation: "askBridge.toolFile",
      ok: true,
      extra: { file }
    });
    return file;
  } catch (err) {
    traceHarnessCall({
      harness: "opencode",
      operation: "askBridge.toolFile",
      ok: false,
      error: truncateError((err as Error).message),
      extra: { file }
    });
    throw err;
  }
}
