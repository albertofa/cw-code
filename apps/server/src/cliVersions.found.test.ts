import { describe, expect, it, mock, vi } from "bun:test";

mock.module("./cli/spawnCli.js", () => ({
  execCliFile: vi.fn(async () => {
    throw Object.assign(new Error("spawn codex.exe EACCES"), { code: "EACCES" });
  })
}));

const { checkCliVersion } = await import("./cliVersions.js");

describe("checkCliVersion with a binary that exists but cannot run", () => {
  it("reports it as found but unavailable on its default path", async () => {
    const check = await checkCliVersion("codex", "codex.exe");
    expect(check).toMatchObject({ configured: false, found: true, available: false, ok: false });
    expect(check.error).toContain("EACCES");
  });
});
