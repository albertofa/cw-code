import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toShellTarget } from "../pty/resolve.js";
import { codexAgentFingerprint, codexTerminalMcpArgs, codexThreadConfig } from "./codexMcp.js";

describe("codexThreadConfig", () => {
  it("sends the token as an Authorization header and auto-approves the cw tools", () => {
    expect(codexThreadConfig({ mcpUrl: "http://127.0.0.1:4100/mcp", token: "tok" })).toEqual({
      mcp_servers: {
        cw: {
          url: "http://127.0.0.1:4100/mcp",
          http_headers: { Authorization: "Bearer tok" },
          default_tools_approval_mode: "approve"
        }
      }
    });
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
        `^^^"-c^^^" ^^^"mcp_servers.cw.default_tools_approval_mode=\\^^^"approve\\^^^"^^^""`
    );
  });
});
