import { describe, expect, it } from "vitest";
import { describeMicError, pickRecorderMimeType } from "./recorderSupport.js";

describe("pickRecorderMimeType", () => {
  it("prefers webm with opus", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to the first supported format", () => {
    expect(pickRecorderMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("returns null when nothing is supported", () => {
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });
});

describe("describeMicError", () => {
  const named = (name: string, message = "") => Object.assign(new Error(message), { name });

  it("explains a blocked microphone", () => {
    expect(describeMicError(named("NotAllowedError"))).toMatch(/blocked/);
  });

  it("explains a missing microphone", () => {
    expect(describeMicError(named("NotFoundError"))).toMatch(/No microphone/);
  });

  it("explains a busy microphone", () => {
    expect(describeMicError(named("NotReadableError"))).toMatch(/busy/);
  });

  it("keeps the detail of an unknown failure", () => {
    expect(describeMicError(new Error("boom"))).toBe("Could not start recording: boom");
    expect(describeMicError("weird")).toBe("Could not start recording");
  });
});
