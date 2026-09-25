import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeFileArgs } from "./opencodeArgs.js";

describe("opencodeFileArgs", () => {
  it("emits -f pairs after the message for files inside the cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-opencode-args-"));
    mkdirSync(join(root, ".cw", "pastes"), { recursive: true });
    const png = join(".cw", "pastes", "x.png");
    writeFileSync(join(root, png), "x", "utf8");
    expect(opencodeFileArgs(root, [png, "README.md"])).toEqual(["-f", png, "-f", "README.md"]);
  });

  it("passes absolute paths through without sandbox checks", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-opencode-args-"));
    const outside = mkdtempSync(join(tmpdir(), "cw-opencode-outside-"));
    const abs = join(outside, "a.png");
    writeFileSync(abs, "x", "utf8");
    expect(opencodeFileArgs(root, [abs])).toEqual(["-f", abs]);
  });

  it("drops relative attachments that escape the project root", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = mkdtempSync(join(tmpdir(), "cw-opencode-args-"));
    const escapes = opencodeFileArgs(root, [join("..", "secret.png")]);
    expect(escapes).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns nothing for empty or missing attachments", () => {
    expect(opencodeFileArgs("C:\\proj", [])).toEqual([]);
    expect(opencodeFileArgs("C:\\proj", undefined)).toEqual([]);
  });
});
