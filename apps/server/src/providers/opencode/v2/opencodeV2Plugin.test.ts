import { afterEach, describe, expect, it, vi } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "../../../../tests/testing.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwSkillMarkdown } from "../../../agent/cwSkill.js";
import { cwToolDefinitions } from "../../../mcp/cwTools.js";
import {
  mergeConfigContent,
  opencodeSkillPath,
  opencodeV2PluginEnv,
  opencodeV2PluginSource,
  SHELL_STRIPPED_ENV,
  writeOpencodeSecretFile
} from "./opencodeV2Plugin.js";

interface ToolDef {
  name: string;
  options: { codemode: boolean };
  input: { type?: string; required: string[] };
  execute: (input: Record<string, unknown>, context: Record<string, unknown>) => Promise<{ content: string }>;
}

interface ContextEvent {
  sessionID: string;
  tools: Record<string, unknown>;
}

interface SkillDef {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
}

type ShellHook = (event: { env?: Record<string, string | undefined> }) => void;

const PLUGIN_DIR = join(tmpdir(), "cw-plugin");
const MCP_URL = "http://127.0.0.1:9/mcp";
const dirs: string[] = [];

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("cw-code.opencode.secrets")];
  unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-v2-plugin-"));
  dirs.push(dir);
  return dir;
}

function secretFile(secret = "s3cret"): string {
  const file = join(scratchDir(), "opencode-secret-test");
  writeFileSync(file, secret);
  return file;
}

async function loadPlugin(options: Record<string, unknown>, parentOf: (sessionID: string) => string | undefined = () => undefined) {
  const plugin = new Function(opencodeV2PluginSource(PLUGIN_DIR).replace("export default", "return"))() as {
    id: string;
    setup: (ctx: unknown) => Promise<void>;
  };
  const tools: ToolDef[] = [];
  const skills: SkillDef[] = [];
  const shellHooks = new Map<string, ShellHook>();
  let hook: ((event: ContextEvent) => Promise<void>) | undefined;
  await plugin.setup({
    options,
    tool: { transform: async (edit: (editor: { add: (tool: ToolDef) => void }) => void) => edit({ add: (tool) => tools.push(tool) }) },
    skill: { transform: async (edit: (editor: { add: (skill: SkillDef) => void }) => void) => edit({ add: (skill) => skills.push(skill) }) },
    shell: { hook: async (name: string, fn: ShellHook) => shellHooks.set(name, fn) },
    session: {
      hook: async (name: string, fn: (event: ContextEvent) => Promise<void>) => {
        if (name === "context") hook = fn;
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parentOf(sessionID) })
    }
  });
  return { plugin, tools, skills, shellHooks, hook };
}

function rpcReply(body: unknown, contentType = "application/json"): Response {
  const text = contentType === "text/event-stream" ? `event: message\ndata: ${JSON.stringify(body)}\n\n` : JSON.stringify(body);
  return new Response(text, { status: 200, headers: { "Content-Type": contentType } });
}

describe("cw-code v2 plugin source", () => {
  it("embeds the cw tools, the session header, the secret file handling, the shell hook keys and the skill", () => {
    const source = opencodeV2PluginSource(PLUGIN_DIR);
    for (const definition of cwToolDefinitions()) expect(source).toContain(`"name":"cw_${definition.name}"`);
    expect(source).toContain('"X-CW-Opencode-Session"');
    expect(source).toContain("fs.readFile(file");
    expect(source).toContain("fs.rm(file");
    expect(source).toContain('ctx.shell.hook("create.before"');
    for (const key of SHELL_STRIPPED_ENV) expect(source).toContain(`"${key}"`);
    expect(source).toContain("ctx.skill.transform((skills) => skills.add(CW_SKILL))");
    expect(source).toContain(JSON.stringify(cwSkillMarkdown("opencode")));
  });
});

describe("cw-code v2 plugin", () => {
  it("registers only the todo tool when no secret file is given", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { plugin, tools, skills, hook } = await loadPlugin({ askBridge: "http://127.0.0.1:9/ask", cwMcpUrl: MCP_URL });
    expect(plugin.id).toBe("cw-code");
    expect(tools.map((t) => [t.name, t.options.codemode])).toEqual([["todo", false]]);
    expect(tools[0].input.required).toEqual(["todos"]);
    await expect(tools[0].execute({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }, {})).resolves.toEqual({
      content: "Todo list updated: 2 item(s), 1 open."
    });
    expect(skills).toEqual([]);
    expect(hook).toBeUndefined();
    expect(String(errors.mock.calls[0]?.[0])).toContain("no secretFile");
    errors.mockRestore();
  });

  it("registers no cw tools and logs why when the secret file is unreadable", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = join(scratchDir(), "gone");
    const { tools } = await loadPlugin({ askBridge: "http://127.0.0.1:9/ask", cwMcpUrl: MCP_URL, secretFile: missing });
    expect(tools.map((t) => t.name)).toEqual(["todo"]);
    expect(String(errors.mock.calls[0]?.[0])).toContain(missing);
    errors.mockRestore();
  });

  it("reads and deletes the secret file, then registers cw_ask, the cw tools and the skill", async () => {
    const file = secretFile();
    const { tools, skills } = await loadPlugin({ askBridge: "http://127.0.0.1:9/ask", cwMcpUrl: MCP_URL, secretFile: file });
    expect(existsSync(file)).toBe(false);
    expect(tools.map((t) => t.name)).toEqual(["todo", "cw_ask", ...cwToolDefinitions().map((definition) => `cw_${definition.name}`)]);
    for (const tool of tools.slice(2)) expect(tool.input.type).toBe("object");
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: "cw-code", name: "cw-code", path: opencodeSkillPath(PLUGIN_DIR), content: cwSkillMarkdown("opencode") });
  });

  it("shares the secret with plugin instances that opencode loads later for other directories", async () => {
    const file = secretFile();
    const options = { askBridge: "http://127.0.0.1:9/ask", cwMcpUrl: MCP_URL, secretFile: file };
    await loadPlugin(options);
    expect(existsSync(file)).toBe(false);
    const later = await loadPlugin(options);
    expect(later.tools.map((t) => t.name)).toContain("cw_projects_list");
    expect(later.skills).toHaveLength(1);
  });

  it("strips the server secrets from the env of agent shells", async () => {
    const { shellHooks } = await loadPlugin({});
    const env: Record<string, string | undefined> = { PATH: "/bin", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_PASSWORD: "p", CW_AGENT_TOKEN: "t", CW_MCP_URL: "u" };
    shellHooks.get("create.before")!({ env });
    expect(env).toEqual({ PATH: "/bin" });
    expect(() => shellHooks.get("create.before")!({})).not.toThrow();
  });

  it("offers cw_ask only on root sessions where the native question tool is missing", async () => {
    const { hook } = await loadPlugin({ askBridge: "http://127.0.0.1:9/ask", secretFile: secretFile() }, (sid) => (sid === "ses_child" ? "ses_root" : undefined));
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

  it("posts cw_ask questions to the bridge with the secret and formats the answers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: [["Red"], []] }), { status: 200 }));
    stubGlobal("fetch", fetchMock);
    const { tools } = await loadPlugin({ askBridge: "http://127.0.0.1:9/ask", secretFile: secretFile("abc") });
    const ask = tools.find((t) => t.name === "cw_ask")!;
    const result = await ask.execute(
      { questions: [{ question: "Color?", options: [{ label: "Red" }] }, { question: "Size?", options: [] }] },
      { sessionID: "ses_root", messageID: "msg_1" }
    );
    expect(result.content).toBe('The user answered: "Color?" = Red; "Size?" = (no answer)');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer abc");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      sessionID: "ses_root",
      messageID: "msg_1",
      questions: [{ question: "Color?", options: [{ label: "Red" }] }, { question: "Size?", options: [] }]
    });
  });

  it("calls the cw MCP endpoint with the secret and the opencode session id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcReply({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '[{"id":"p1"}]' }] } }, "text/event-stream"));
    stubGlobal("fetch", fetchMock);
    const { tools } = await loadPlugin({ cwMcpUrl: MCP_URL, secretFile: secretFile("abc") });
    const signal = new AbortController().signal;
    const result = await tools.find((t) => t.name === "cw_projects_list")!.execute({}, { sessionID: "ses_1", signal });
    expect(result.content).toBe('[{"id":"p1"}]');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(MCP_URL);
    expect(init.signal).toBe(signal);
    expect(init.headers).toMatchObject({ Authorization: "Bearer abc", "X-CW-Opencode-Session": "ses_1", Accept: "application/json, text/event-stream" });
    expect(JSON.parse(init.body)).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "projects_list", arguments: {} } });
  });

  it.each([
    ["a tool error result", rpcReply({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "unknown session x" }], isError: true } }), "Error: unknown session x"],
    ["a JSON-RPC error", rpcReply({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad input" } }), "Error: bad input"],
    ["an HTTP error", new Response("unauthorized", { status: 401 }), "Error: cw-code answered HTTP 401: unauthorized"],
    ["an unreadable body", new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }), "Error: cw-code sent an unreadable reply"]
  ])("turns %s into text starting with Error:", async (_label, response, expected) => {
    stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { tools } = await loadPlugin({ cwMcpUrl: MCP_URL, secretFile: secretFile() });
    const result = await tools.find((t) => t.name === "cw_session_get")!.execute({ sessionId: "x" }, { sessionID: "ses_1" });
    expect(result.content.startsWith(expected)).toBe(true);
  });

  it("reports an unreachable endpoint as an error text", async () => {
    stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { tools } = await loadPlugin({ cwMcpUrl: MCP_URL, secretFile: secretFile() });
    const result = await tools.find((t) => t.name === "cw_settings_get")!.execute({}, { sessionID: "ses_1" });
    expect(result.content).toBe("Error: could not reach cw-code: ECONNREFUSED");
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

  it("writes the plugin entry and returns the env that loads it without the secret itself", async () => {
    const dir = scratchDir();
    const options = { askBridge: "http://b", secretFile: join(dir, "opencode-secret-1"), cwMcpUrl: MCP_URL };
    const env = await opencodeV2PluginEnv(dir, options, undefined);
    expect(readFileSync(join(dir, "index.js"), "utf8")).toBe(opencodeV2PluginSource(dir));
    expect(JSON.parse(env["OPENCODE_CONFIG_CONTENT"])).toEqual({ plugins: [{ package: dir, options }] });
    expect(env).not.toHaveProperty("OPENCODE_CONFIG_DIR");
  });

  it("writes each secret to a new owner-only file", async () => {
    const dir = scratchDir();
    const first = await writeOpencodeSecretFile(dir, "abc");
    const second = await writeOpencodeSecretFile(dir, "abc");
    expect(first).not.toBe(second);
    expect(readFileSync(first, "utf8")).toBe("abc");
    if (process.platform !== "win32") expect(statSync(first).mode & 0o777).toBe(0o600);
  });
});
