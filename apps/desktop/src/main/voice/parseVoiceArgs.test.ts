import { describe, expect, it } from "vitest";
import { parseGroqKeyArg, parseTranscribeArgs } from "./parseVoiceArgs.js";

describe("parseTranscribeArgs", () => {
  it("accepts an ArrayBuffer", () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const parsed = parseTranscribeArgs({ audio: buffer, mimeType: "audio/webm" });
    expect(Array.from(parsed.audio)).toEqual([1, 2, 3]);
    expect(parsed.mimeType).toBe("audio/webm");
  });

  it("accepts a typed array view without copying its neighbours", () => {
    const backing = new Uint8Array([9, 1, 2, 9]);
    const parsed = parseTranscribeArgs({ audio: backing.subarray(1, 3), mimeType: "audio/webm" });
    expect(Array.from(parsed.audio)).toEqual([1, 2]);
  });

  it.each([
    [undefined],
    [null],
    ["audio"],
    [{ audio: "not bytes", mimeType: "audio/webm" }],
    [{ audio: new ArrayBuffer(4) }],
    [{ audio: new ArrayBuffer(4), mimeType: "" }],
    [{ audio: new ArrayBuffer(4), mimeType: "x".repeat(101) }]
  ])("rejects malformed input %#", (args) => {
    expect(() => parseTranscribeArgs(args)).toThrow(/voice\.transcribeGroq/);
  });
});

describe("parseGroqKeyArg", () => {
  it("passes strings through and rejects everything else", () => {
    expect(parseGroqKeyArg("gsk_x")).toBe("gsk_x");
    expect(() => parseGroqKeyArg(42)).toThrow(/voice\.setGroqKey/);
    expect(() => parseGroqKeyArg(undefined)).toThrow(/voice\.setGroqKey/);
  });
});
