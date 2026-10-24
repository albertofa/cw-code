import { afterEach, describe, expect, it, vi } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "../../../../tests/testing.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfigContent, opencodeV2PluginEnv, opencodeV2PluginSource } from "./opencodeV2Plugin.js";

interface ToolDef {
  name: string;
  options: { codemode: boolean };
  input: { required: string[] };
  execute: (input: Record<string, unknown>, context: Record<string, unknown>) => Promise<{ content: string }>;
}

interface ContextEvent {
  sessionID: string;
  tools: Record<string, unknown>;
}

const dirs: string[] = [];

afterEach(() => {
  unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadPlugin(options: Record<string, unknown>, parentOf: (sessionID: string) => string | undefined) {
  const plugin = new Function(opencodeV2PluginSource().replace("export default", "return"))() as {
    id: string;
    setup: (ctx: unknown) => Promise<void>;
  };
  const tools: ToolDef[] = [];
  let hook: ((event: ContextEvent) => Promise<void>) | undefined;
  await plugin.setup({
    options,
    tool: { transform: async (edit: (editor: { add: (tool: ToolDef) => void }) => void) => edit({ add: (tool) => tools.push(tool) }) },
    session: {
      hook: async (name: string, fn: (event: ContextEvent) => Promise<void>) => {
        if (name === "context") hook = fn;
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parentOf(sessionID) })
    }
  });
  return { plugin, tools, hook };
}

describe("cw-code v2 plugin", () => {
  it("registers a direct todo tool without the ask bridge", async () => {
    const { plugin, tools, hook } = await loadPlugin({}, () => undefined);
    expect(plugin.id).toBe("cw-code");
    expect(tools.map((t) => [t.name, t.options.codemode])).toEqual([["todo", false]]);
    expect(tools[0].input.required).toEqual(["todos"]);
    await expect(tools[0].execute({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }, {})).resolves.toEqual({
      content: "Todo list updated: 2 item(s), 1 open."
    });
    expect(hook).toBeUndefined();
  });

  it("offers cw_ask only on root sessions where the native question tool is missing", async () => {
    const { tools, hook } = await loadPlugin({ askBridge: "http://127.0.0.1:9/ask" }, (sid) => (sid === "ses_child" ? "ses_root" : undefined));
    expect(tools.map((t) => t.name)).toEqual(["todo", "cw_ask"]);
    const withNative: ContextEvent = { sessionID: "ses_root", tools: { question: {}, cw_ask: {} } };
    await hook!(withNative);
    expect(Object.keys(withNative.tools)).toEqual(["question"]);
    const denied: ContextEvent = { sessionID: "ses_root", tools: { cw_ask: {} } };
    await hook!(denied);
    expect(Object.keys(denied.tools)).toEqual(["cw_ask"]);
    const child: ContextEvent = { sessionID: "ses_child", tools: { cw_ask: {} } };
    await hook!(child);
    expect(Object.keys(child.tools)).toEqual([]);
  });

  it("posts cw_ask questions to the bridge and formats the answers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: [["Red"], []] }), { status: 200 }));
    stubGlobal("fetch", fetchMock);
    const { tools } = await loadPlugin({ askBridge: "http://127.0.0.1:9/ask" }, () => undefined);
    const ask = tools.find((t) => t.name === "cw_ask")!;
    const result = await ask.execute(
      { questions: [{ question: "Color?", options: [{ label: "Red" }] }, { question: "Size?", options: [] }] },
      { sessionID: "ses_root", messageID: "msg_1" }
    );
    expect(result.content).toBe('The user answered: "Color?" = Red; "Size?" = (no answer)');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      sessionID: "ses_root",
      messageID: "msg_1",
      questions: [{ question: "Color?", options: [{ label: "Red" }] }, { question: "Size?", options: [] }]
    });
  });
});

describe("OPENCODE_CONFIG_CONTENT", () => {
  const plugin = { package: "C:\\cw\\plugin", options: { askBridge: "http://b" } };

  it("adds the plugin to an empty or existing config without dropping the user's keys", () => {
    expect(JSON.parse(mergeConfigContent(undefined, plugin))).toEqual({ plugins: [plugin] });
    expect(JSON.parse(mergeConfigContent('{"model":"a/b","plugins":[{"package":"x"}]}', plugin))).toEqual({
      model: "a/b",
      plugins: [{ package: "x" }, plugin]
    });
  });

  it("refuses to overwrite a config that is not a JSON object", () => {
    expect(() => mergeConfigContent("[1]", plugin)).toThrow("not a JSON object");
    expect(() => mergeConfigContent("{oops", plugin)).toThrow();
  });

  it("writes the plugin entry and returns the env that loads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-v2-plugin-"));
    dirs.push(dir);
    const env = await opencodeV2PluginEnv(dir, "http://b", undefined);
    expect(readFileSync(join(dir, "index.js"), "utf8")).toBe(opencodeV2PluginSource());
    expect(JSON.parse(env["OPENCODE_CONFIG_CONTENT"])).toEqual({ plugins: [{ package: dir, options: { askBridge: "http://b" } }] });
    expect(env).not.toHaveProperty("OPENCODE_CONFIG_DIR");
  });
});
