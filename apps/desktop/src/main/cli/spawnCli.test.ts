import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliSpawnTarget, execCliFile } from "./spawnCli.js";

describe("cliSpawnTarget", () => {
  it("spawns executables directly on any platform", () => {
    expect(cliSpawnTarget("/usr/local/bin/opencode", ["serve"], "linux")).toEqual({
      file: "/usr/local/bin/opencode",
      args: ["serve"]
    });
    expect(cliSpawnTarget("C:\\tools\\codex.exe", ["app-server"], "win32")).toEqual({
      file: "C:\\tools\\codex.exe",
      args: ["app-server"]
    });
  });

  it("routes Windows batch shims through cmd.exe with separate argv entries", () => {
    expect(cliSpawnTarget("C:\\nvm4w\\nodejs\\opencode.cmd", ["serve", "--port", "8080"], "win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/c", "C:\\nvm4w\\nodejs\\opencode.cmd", "serve", "--port", "8080"]
    });
    expect(cliSpawnTarget("C:\\tools\\codex.BAT", ["--version"], "win32").file).toBe("cmd.exe");
  });

  it("routes Windows ps1 shims through powershell with single-quoted argv", () => {
    expect(cliSpawnTarget("C:\\nvm4w\\nodejs\\codex.ps1", ["--version"], "win32")).toEqual({
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `& 'C:\\nvm4w\\nodejs\\codex.ps1' '--version'`]
    });
    expect(cliSpawnTarget("C:\\odd'dir\\tool.ps1", ["a b"], "win32").args[3]).toBe(
      `& 'C:\\odd''dir\\tool.ps1' 'a b'`
    );
  });

  it("ignores extensions on posix", () => {
    expect(cliSpawnTarget("/opt/bin/tool.cmd", ["--version"], "linux")).toEqual({
      file: "/opt/bin/tool.cmd",
      args: ["--version"]
    });
  });

  it.skipIf(process.platform !== "win32")("execCliFile runs a .cmd shim in a spaced directory", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cw-spawn-")), "sub dir");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "cli.cmd");
    writeFileSync(file, "@echo 9.9.9\r\n", "utf8");
    const { stdout } = await execCliFile(file, ["--version"], { timeout: 15000 });
    expect(stdout.trim()).toBe("9.9.9");
  });
});
