import { describe, expect, it } from "vitest";
import { formatRelativeAge } from "./prInboxModel.js";

describe("formatRelativeAge", () => {
  it("formats seconds", () => {
    expect(formatRelativeAge(1_000, 1_000)).toBe("0s");
    expect(formatRelativeAge(1_000, 41_000)).toBe("40s");
  });

  it("formats minutes once past 60 seconds", () => {
    expect(formatRelativeAge(0, 60_000)).toBe("1m");
    expect(formatRelativeAge(0, 12 * 60_000)).toBe("12m");
  });

  it("formats hours once past 60 minutes", () => {
    expect(formatRelativeAge(0, 60 * 60_000)).toBe("1h");
    expect(formatRelativeAge(0, 5 * 60 * 60_000)).toBe("5h");
  });

  it("formats days then weeks", () => {
    expect(formatRelativeAge(0, 24 * 60 * 60_000)).toBe("1d");
    expect(formatRelativeAge(0, 9 * 24 * 60 * 60_000)).toBe("1w");
  });
});
