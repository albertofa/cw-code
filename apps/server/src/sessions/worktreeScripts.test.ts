import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeScriptResult, runWorktreeScript, scriptCommand, type WorktreeScriptResult } from "./worktreeScripts.js";

function result(overrides: Partial<WorktreeScriptResult>): WorktreeScriptResult {
  return { ok: false, exitCode: 1, timedOut: false, aborted: false, durationMs: 2400, output: "", ...overrides };
}

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

describe("scriptCommand", () => {
  it("encodes the script for PowerShell on Windows, without progress records", () => {
    const command = scriptCommand('echo "hi"\nexit 2', "win32");
    expect(command.file).toBe("powershell.exe");
    expect(command.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(Buffer.from(command.args.at(-1) ?? "", "base64").toString("utf16le")).toBe(`$ProgressPreference = 'SilentlyContinue'\necho "hi"\nexit 2`);
  });

  it("runs the script through the user's shell elsewhere", () => {
    expect(scriptCommand("bun install", "linux", { SHELL: "/usr/bin/zsh" })).toEqual({ file: "/usr/bin/zsh", args: ["-c", "bun install"] });
    expect(scriptCommand("bun install", "darwin", {})).toEqual({ file: "/bin/sh", args: ["-c", "bun install"] });
  });
});

describe("describeScriptResult", () => {
  it("reports success with the duration", () => {
    expect(describeScriptResult("setup", result({ ok: true, exitCode: 0 }))).toBe("Setup script finished in 2s.");
  });

  it("reports the exit code with the last lines of output", () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\r\n");
    const text = describeScriptResult("destroy", result({ exitCode: 3, output }));
    expect(text.startsWith("Destroy script failed with exit code 3:\n")).toBe(true);
    expect(text).toContain("line 20");
    expect(text).not.toContain("line 8\n");
  });

  it("names timeouts, aborts and spawn errors", () => {
    expect(describeScriptResult("setup", result({ timedOut: true, exitCode: null }))).toBe("Setup script timed out after 2s.");
    expect(describeScriptResult("setup", result({ aborted: true, exitCode: null }))).toBe("Setup script was stopped.");
    expect(describeScriptResult("setup", result({ exitCode: null, error: "spawn sh ENOENT" }))).toBe("Setup script could not start: spawn sh ENOENT.");
  });
});

describe("runWorktreeScript", () => {
  const writeMarker = process.platform === "win32" ? "Set-Content -NoNewline -Path marker.txt -Value $env:CW_MARK" : 'printf %s "$CW_MARK" > marker.txt';

  it("runs inside the worktree with the given environment", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cw-script-"));
    const outcome = await runWorktreeScript({ script: writeMarker, cwd, env: { ...env, CW_MARK: "sess_1" } });
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "marker.txt"), "utf8")).toBe("sess_1");
  });

  it("captures the exit code and output of a failing script", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cw-script-"));
    const outcome = await runWorktreeScript({ script: "echo broken\nexit 3", cwd, env });
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toContain("broken");
  });

  it("stops the script when aborted", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cw-script-"));
    const controller = new AbortController();
    const running = runWorktreeScript({ script: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30", cwd, env, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    expect(outcome.aborted).toBe(true);
    expect(outcome.durationMs).toBeLessThan(20_000);
  });
});
