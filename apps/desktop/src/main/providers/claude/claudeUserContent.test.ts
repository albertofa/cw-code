import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeUserContent } from "./claudeUserContent.js";

let dir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildClaudeUserContent", () => {
  it("returns the prompt unchanged with no attachments", () => {
    expect(buildClaudeUserContent("C:\\x", "hello", undefined)).toBe("hello");
    expect(buildClaudeUserContent("C:\\x", "hello", [])).toBe("hello");
    expect(buildClaudeUserContent("C:\\x", "hello", ["notes.txt"])).toBe("hello");
  });

  it("builds a text block followed by an image block for a png", () => {
    dir = mkdtempSync(join(tmpdir(), "cuc-"));
    const bytes = Buffer.from([1, 2, 3]);
    writeFileSync(join(dir, "pic.png"), bytes);
    const out = buildClaudeUserContent(dir, "look", ["pic.png"]) as unknown[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: "text", text: "look" });
    expect(out[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") }
    });
  });

  it("maps jpeg, webp and gif extensions", () => {
    dir = mkdtempSync(join(tmpdir(), "cuc-"));
    const bytes = Buffer.from([9]);
    writeFileSync(join(dir, "a.jpeg"), bytes);
    writeFileSync(join(dir, "b.webp"), bytes);
    writeFileSync(join(dir, "c.gif"), bytes);
    writeFileSync(join(dir, "d.jpg"), bytes);
    const out = buildClaudeUserContent(dir, "p", ["a.jpeg", "b.webp", "c.gif", "d.jpg"]) as Array<{ type: string; source?: { media_type: string } }>;
    expect(out).toHaveLength(5);
    expect(out.map((b) => b.source?.media_type)).toEqual([undefined, "image/jpeg", "image/webp", "image/gif", "image/jpeg"]);
  });

  it("reads absolute image paths directly", () => {
    const outside = mkdtempSync(join(tmpdir(), "cuc-abs-"));
    const abs = join(outside, "pic.png");
    const bytes = Buffer.from([7, 8, 9]);
    writeFileSync(abs, bytes);
    const out = buildClaudeUserContent(dir ?? mkdtempSync(join(tmpdir(), "cuc-")), "look", [abs]) as unknown[];
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") }
    });
  });

  it("skips missing files with a warning", () => {
    dir = mkdtempSync(join(tmpdir(), "cuc-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildClaudeUserContent(dir, "p", ["nope.png"])).toBe("p");
    expect(warn).toHaveBeenCalledWith("image attachment unreadable, skipped: nope.png");
  });

  it("omits the text block when the prompt is empty", () => {
    dir = mkdtempSync(join(tmpdir(), "cuc-"));
    writeFileSync(join(dir, "pic.png"), Buffer.from([1]));
    const out = buildClaudeUserContent(dir, "  ", ["pic.png"]) as unknown[];
    expect(out).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from([1]).toString("base64") } }
    ]);
  });

  it("falls back to the prompt string when no image is readable", () => {
    dir = mkdtempSync(join(tmpdir(), "cuc-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildClaudeUserContent(dir, "hello", ["nope.png"])).toBe("hello");
  });
});
