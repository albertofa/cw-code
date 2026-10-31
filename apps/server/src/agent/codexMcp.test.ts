import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAIT_MAX_MS } from "../mcp/cwTools.js";
import { toShellTarget } from "../pty/resolve.js";
import { codexAgentFingerprint, codexTerminalMcpArgs, codexThreadConfig } from "./codexMcp.js";
import { MCP_IDLE_TIMEOUT_SECONDS } from "./mcpTimeouts.js";

describe("codexThreadConfig", () => {
  it("sends the token as an Authorization header, auto-approves the cw tools and outlasts the longest wait", () => {
    expect(codexThreadConfig({ mcpUrl: "http://127.0.0.1:4100/mcp", token: "tok" })).toEqual({
      mcp_servers: {
        cw: {
          url: "http://127.0.0.1:4100/mcp",
          http_headers: { Authorization: "Bearer tok" },
          default_tools_approval_mode: "approve",
          tool_timeout_sec: MCP_IDLE_TIMEOUT_SECONDS
        }
      }
    });
    expect(MCP_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(WAIT_MAX_MS);
  });
});

describe("codexAgentFingerprint", () => {
  it("is empty without an agent and changes with the token", () => {
    expect(codexAgentFingerprint(undefined)).toBe("");
    const first = codexAgentFingerprint({ mcpUrl: "u", token: "a" });
    expect(first).not.toBe("");
    expect(codexAgentFingerprint({ mcpUrl: "other", token: "a" })).toBe(first);
    expect(codexAgentFingerprint({ mcpUrl: "u", token: "b" })).not.toBe(first);
  });
});

describe("codexTerminalMcpArgs", () => {
  it("keeps the TOML string quotes through the cmd.exe batch line", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-codex-mcp-"));
    writeFileSync(join(dir, "codex.cmd"), "@echo off\r\n");
    const target = toShellTarget("codex", codexTerminalMcpArgs("http://127.0.0.1:4100/mcp"), {
      pathDirs: [dir],
      pathExts: [".CMD"],
      platform: "win32"
    });
    expect(target.file).toBe("cmd.exe");
    expect(target.args).toBe(
      `/s /k ""${join(dir, "codex.cmd")}" ^^^"-c^^^" ^^^"mcp_servers.cw.url=\\^^^"http://127.0.0.1:4100/mcp\\^^^"^^^" ` +
        `^^^"-c^^^" ^^^"mcp_servers.cw.bearer_token_env_var=\\^^^"CW_AGENT_TOKEN\\^^^"^^^" ` +
        `^^^"-c^^^" ^^^"mcp_servers.cw.default_tools_approval_mode=\\^^^"approve\\^^^"^^^" ` +
        `^^^"-c^^^" ^^^"mcp_servers.cw.tool_timeout_sec=${MCP_IDLE_TIMEOUT_SECONDS}^^^""`
    );
  });
});
