import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeClaudeAccountUsage } from "./claudeAccountUsage.js";
import { probeClaudeCommands } from "./claudeCommands.js";

const dirs: string[] = [];

/** A shim like the one npm installs: a .cmd that Node refuses to spawn directly since CVE-2024-27980. */
function exitingCmdShim(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cw-claude-shim-"));
  dirs.push(dir);
  const shimDir = join(dir, "sub dir");
  mkdirSync(shimDir, { recursive: true });
  const file = join(shimDir, "claude.cmd");
  writeFileSync(file, "@echo off\r\nexit /b 0\r\n", "utf8");
  return { file, dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("default spawn of a Windows .cmd shim", () => {
  it("starts the account usage probe instead of failing with spawn EINVAL", async () => {
    const { file } = exitingCmdShim();
    const state = await probeClaudeAccountUsage(file, []);
    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.message).toMatch(/exited before responding/);
      expect(state.message).not.toMatch(/EINVAL|failed to spawn/);
    }
  });

  it("starts the commands probe instead of failing with spawn EINVAL", async () => {
    const { file, dir } = exitingCmdShim();
    const failure = await probeClaudeCommands(file, [], dir).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(failure).not.toBeNull();
    expect(failure).not.toMatch(/EINVAL|failed to spawn/);
  });
});
