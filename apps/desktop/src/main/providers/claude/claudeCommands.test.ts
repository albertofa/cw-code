import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_COMMANDS_CACHE_PRUNE_MS,
  CLAUDE_COMMANDS_CACHE_TTL_MS,
  claudeCommandText,
  clearClaudeCommandsCache,
  decodeClaudeCommandsCache,
  initClaudeCommandsCache,
  listClaudeCommands,
  mapClaudeCommands,
  probeClaudeCommands,
  recordClaudeTerminalCommands,
  type ClaudeCommandsQuery
} from "./claudeCommands.js";

describe("mapClaudeCommands", () => {
  it("maps name/description/argumentHint and marks terminal commands", () => {
    const out = mapClaudeCommands(
      [
        { name: "compact", description: "Summarize the thread" },
        { name: "doctor", description: "Diagnose the install", argumentHint: "[flag]" }
      ],
      new Set(["doctor"])
    );
    expect(out).toEqual([
      { name: "compact", description: "Summarize the thread", dispatch: "prompt" },
      { name: "doctor", description: "Diagnose the install", argumentHint: "[flag]", dispatch: "terminal" }
    ]);
  });

  it("drops commands owned by the renderer", () => {
    const out = mapClaudeCommands(
      [
        { name: "model", description: "x" },
        { name: "effort", description: "x" },
        { name: "rename", description: "x" },
        { name: "clear", description: "x" },
        { name: "context", description: "Show context usage" }
      ],
      new Set()
    );
    expect(out.map((c) => c.name)).toEqual(["context"]);
  });

  it("tolerates missing or garbage fields", () => {
    expect(mapClaudeCommands(null, new Set())).toEqual([]);
    expect(mapClaudeCommands("not an array", new Set())).toEqual([]);
    expect(
      mapClaudeCommands([null, 42, {}, { name: "" }, { name: "ok" }, { name: "ok" }], new Set())
    ).toEqual([{ name: "ok", description: "", dispatch: "prompt" }]);
  });
});

describe("claudeCommandText", () => {
  it("maps the transcript command shape to slash text", () => {
    expect(
      claudeCommandText(
        "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>"
      )
    ).toBe("/context");
    expect(
      claudeCommandText(
        "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>focus on tests</command-args>"
      )
    ).toBe("/compact focus on tests");
  });

  it("returns null for ordinary text", () => {
    expect(claudeCommandText("hello there")).toBeNull();
  });

  it("leaves text alone when it only mentions the tag instead of starting with it", () => {
    expect(
      claudeCommandText(
        "Why does <command-name>/context</command-name> appear in the transcript?"
      )
    ).toBeNull();
  });

  it("keeps args containing angle brackets and inner whitespace intact", () => {
    expect(
      claudeCommandText(
        "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>  keep <foo> and bar  </command-args>"
      )
    ).toBe("/compact keep <foo> and bar");
  });

  it("always renders exactly one leading slash", () => {
    expect(
      claudeCommandText(
        "<command-name>context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>"
      )
    ).toBe("/context");
    expect(
      claudeCommandText(
        "<command-name>//context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>"
      )
    ).toBe("/context");
  });
});

describe("decodeClaudeCommandsCache", () => {
  it("ignores malformed cache files", () => {
    expect(decodeClaudeCommandsCache("not json")).toEqual([]);
    expect(decodeClaudeCommandsCache('{"entries":{"k":{"at":"x","raw":[]}}}')).toEqual([]);
    expect(decodeClaudeCommandsCache('{"entries":{"k":{"at":1,"raw":"nope"}}}')).toEqual([]);
    expect(
      decodeClaudeCommandsCache(
        '{"entries":{"claude::c:\\\\proj":{"at":1,"raw":[{"name":"a"}],"terminal":["doctor"]}}}'
      )
    ).toEqual([{ key: "claude::c:\\proj", at: 1, raw: [{ name: "a" }], terminal: ["doctor"] }]);
  });
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 123;
  killed = false;

  constructor() {
    super();
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(children: FakeChild[]) {
  return ((_command: string, _args: readonly string[]) => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as Parameters<typeof probeClaudeCommands>[3];
}

describe("probeClaudeCommands", () => {
  it("resolves the raw commands array once the matching control_response arrives", async () => {
    const children: FakeChild[] = [];
    const killed: unknown[] = [];
    const promise = probeClaudeCommands("claude", ["-p"], "C:\\proj", fakeSpawn(children), (proc) => killed.push(proc));
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    const written = JSON.parse(child.stdin.read()?.toString() ?? "null") as { request_id: string };
    child.stdout.write(
      `${JSON.stringify({
        type: "control_response",
        response: { request_id: written.request_id, response: { commands: [{ name: "compact" }] } }
      })}\n`
    );
    await expect(promise).resolves.toEqual([{ name: "compact" }]);
    expect(killed).toEqual([child]);
  });

  it("rejects with the cleaned stderr when the process exits early", async () => {
    const children: FakeChild[] = [];
    const promise = probeClaudeCommands("claude", ["-p"], "C:\\proj", fakeSpawn(children), () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    child.stderr.write("Error: boom\n");
    child.emit("close", 1);
    await expect(promise).rejects.toThrow("Error: boom");
  });

  it("rejects with a probe-specific fallback message when there is no stderr to show", async () => {
    const children: FakeChild[] = [];
    const promise = probeClaudeCommands("claude", ["-p"], "C:\\proj", fakeSpawn(children), () => {});
    await new Promise((resolve) => setImmediate(resolve));
    children[0].emit("close", 1);
    await expect(promise).rejects.toThrow("claude exited before listing commands (code 1)");
  });

  it("kills the child and rejects when spawning fails", async () => {
    const children: FakeChild[] = [];
    const killed: unknown[] = [];
    const promise = probeClaudeCommands("claude", ["-p"], "C:\\proj", fakeSpawn(children), (proc) => killed.push(proc));
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    child.emit("error", new Error("ENOENT"));
    await expect(promise).rejects.toThrow("failed to spawn claude: ENOENT");
    expect(killed).toEqual([child]);
  });

  it("rejects and kills the child when the stdin pipe errors", async () => {
    const children: FakeChild[] = [];
    const killed: unknown[] = [];
    const promise = probeClaudeCommands("claude", ["-p"], "C:\\proj", fakeSpawn(children), (proc) => killed.push(proc));
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    child.stdin.emit("error", new Error("EPIPE"));
    await expect(promise).rejects.toThrow("failed to write to claude stdin: EPIPE");
    expect(killed).toEqual([child]);
  });

  it("rejects when the matching response reports an error", async () => {
    const children: FakeChild[] = [];
    const promise = probeClaudeCommands("claude", ["-p"], "C:\\proj", fakeSpawn(children), () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    const written = JSON.parse(child.stdin.read()?.toString() ?? "null") as { request_id: string };
    child.stdout.write(
      `${JSON.stringify({
        type: "control_response",
        response: { request_id: written.request_id, subtype: "error", error: "unsupported subtype" }
      })}\n`
    );
    await expect(promise).rejects.toThrow("unsupported subtype");
  });

  it("rejects with a generic message when the matching response has no command list", async () => {
    const children: FakeChild[] = [];
    const promise = probeClaudeCommands("claude", ["-p"], "C:\\proj", fakeSpawn(children), () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const child = children[0];
    const written = JSON.parse(child.stdin.read()?.toString() ?? "null") as { request_id: string };
    child.stdout.write(
      `${JSON.stringify({ type: "control_response", response: { request_id: written.request_id, response: {} } })}\n`
    );
    await expect(promise).rejects.toThrow("claude returned no command list");
  });
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("listClaudeCommands cache", () => {
  beforeEach(() => clearClaudeCommandsCache());
  afterEach(() => clearClaudeCommandsCache());

  it("serves the cached list without re-querying", async () => {
    let calls = 0;
    const query: ClaudeCommandsQuery = async () => {
      calls += 1;
      return [{ name: "compact", description: "Summarize" }];
    };
    const first = await listClaudeCommands("C:\\one", "claude", [], query);
    const second = await listClaudeCommands("C:\\one", "claude", [], query);
    expect(first.map((c) => c.name)).toEqual(["compact"]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("shares one query between concurrent cold calls", async () => {
    let calls = 0;
    const query: ClaudeCommandsQuery = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [{ name: "compact", description: "Summarize" }];
    };
    const [a, b] = await Promise.all([
      listClaudeCommands("C:\\one", "claude", [], query),
      listClaudeCommands("C:\\one", "claude", [], query)
    ]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it("returns the stale list immediately and refreshes in the background", async () => {
    const base = 1_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(base);
    let name = "alpha";
    const query: ClaudeCommandsQuery = async () => [{ name, description: "d" }];
    const first = await listClaudeCommands("C:\\one", "claude", [], query);
    expect(first.map((c) => c.name)).toEqual(["alpha"]);
    name = "beta";
    now.mockReturnValue(base + CLAUDE_COMMANDS_CACHE_TTL_MS + 1);
    const stale = await listClaudeCommands("C:\\one", "claude", [], query);
    expect(stale.map((c) => c.name)).toEqual(["alpha"]);
    await flush();
    const fresh = await listClaudeCommands("C:\\one", "claude", [], query);
    expect(fresh.map((c) => c.name)).toEqual(["beta"]);
    now.mockRestore();
  });

  it("treats a terminal-only entry (no successful probe yet) as a cold miss, not a cached hit", async () => {
    const query: ClaudeCommandsQuery = async () => [{ name: "doctor", description: "d" }];
    recordClaudeTerminalCommands("claude", "C:\\one", ["doctor"]);
    const result = await listClaudeCommands("C:\\one", "claude", [], query);
    expect(result).toEqual([{ name: "doctor", description: "d", dispatch: "terminal" }]);
  });

  it("propagates the error on a cold miss", async () => {
    const query: ClaudeCommandsQuery = async () => {
      throw new Error("spawn failed");
    };
    await expect(listClaudeCommands("C:\\one", "claude", [], query)).rejects.toThrow("spawn failed");
  });

  it("propagates the error even when only a terminal-only entry exists (never cached, never silently empty)", async () => {
    recordClaudeTerminalCommands("claude", "C:\\one", ["doctor"]);
    const query: ClaudeCommandsQuery = async () => {
      throw new Error("spawn failed");
    };
    await expect(listClaudeCommands("C:\\one", "claude", [], query)).rejects.toThrow("spawn failed");
  });

  it("never caches a probe failure", async () => {
    let calls = 0;
    const query: ClaudeCommandsQuery = async () => {
      calls += 1;
      if (calls === 1) throw new Error("spawn failed");
      return [{ name: "compact", description: "d" }];
    };
    await expect(listClaudeCommands("C:\\one", "claude", [], query)).rejects.toThrow("spawn failed");
    const second = await listClaudeCommands("C:\\one", "claude", [], query);
    expect(calls).toBe(2);
    expect(second).toEqual([{ name: "compact", description: "d", dispatch: "prompt" }]);
  });
});

describe("claude commands disk cache", () => {
  beforeEach(() => clearClaudeCommandsCache());
  afterEach(() => clearClaudeCommandsCache());

  it("persists the live list and seeds it on the next startup", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-claude-commands-")), "claude-commands.json");
    initClaudeCommandsCache(file);
    const live = await listClaudeCommands("C:\\one", "claude", [], async () => [
      { name: "compact", description: "Summarize" }
    ]);
    expect(existsSync(file)).toBe(true);
    clearClaudeCommandsCache();
    initClaudeCommandsCache(file);
    let calls = 0;
    const offline: ClaudeCommandsQuery = async () => {
      calls += 1;
      throw new Error("offline");
    };
    const seeded = await listClaudeCommands("C:\\one", "claude", [], offline);
    expect(seeded).toEqual(live);
    expect(calls).toBe(0);
  });

  it("ignores malformed cache files and starts with an empty cache", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-claude-commands-")), "claude-commands.json");
    writeFileSync(file, "not json", "utf8");
    initClaudeCommandsCache(file);
    let calls = 0;
    const result = await listClaudeCommands("C:\\one", "claude", [], async () => {
      calls += 1;
      return [{ name: "compact", description: "d" }];
    });
    expect(calls).toBe(1);
    expect(result).toEqual([{ name: "compact", description: "d", dispatch: "prompt" }]);
  });

  it("skips the disk write when the live-captured terminal set has not changed", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-claude-commands-")), "claude-commands.json");
    initClaudeCommandsCache(file);
    recordClaudeTerminalCommands("claude", "C:\\one", ["doctor"]);
    expect(existsSync(file)).toBe(true);
    const firstMtime = statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    recordClaudeTerminalCommands("claude", "C:\\one", ["doctor"]);
    expect(statSync(file).mtimeMs).toBe(firstMtime);
    recordClaudeTerminalCommands("claude", "C:\\one", ["doctor", "color"]);
    expect(statSync(file).mtimeMs).toBeGreaterThan(firstMtime);
  });

  it("prunes entries older than 7 days on load", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-claude-commands-")), "claude-commands.json");
    const now = Date.now();
    const stale = now - CLAUDE_COMMANDS_CACHE_PRUNE_MS - 1;
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          "claude::c:\\stale": { at: stale, raw: [{ name: "old" }], terminal: [] },
          "claude::c:\\fresh": { at: now, raw: [{ name: "new" }], terminal: [] }
        }
      }),
      "utf8"
    );
    initClaudeCommandsCache(file);
    const stalePromise = listClaudeCommands("C:\\stale", "claude", [], async () => {
      throw new Error("should not probe");
    });
    await expect(stalePromise).rejects.toThrow("should not probe");
    const fresh = await listClaudeCommands("C:\\fresh", "claude", [], async () => {
      throw new Error("should not probe fresh either");
    });
    expect(fresh).toEqual([{ name: "new", description: "", dispatch: "prompt" }]);
  });

  it("drops terminal-only (at: 0) entries on load", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-claude-commands-")), "claude-commands.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          "claude::c:\\one": { at: 0, raw: [], terminal: ["doctor"] }
        }
      }),
      "utf8"
    );
    initClaudeCommandsCache(file);
    let calls = 0;
    const result = await listClaudeCommands("C:\\one", "claude", [], async () => {
      calls += 1;
      return [{ name: "compact", description: "d" }];
    });
    expect(calls).toBe(1);
    expect(result).toEqual([{ name: "compact", description: "d", dispatch: "prompt" }]);
  });
});
