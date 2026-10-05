import { describe, expect, it } from "vitest";
import { durationFromMessages } from "./turnFormat.js";

describe("durationFromMessages", () => {
  it("returns the span between the first and last timestamps", () => {
    expect(durationFromMessages([{ timestamp: 1_000 }, { timestamp: 4_500 }])).toBe(3_500);
  });

  it("returns zero for two messages with equal timestamps", () => {
    expect(durationFromMessages([{ timestamp: 1_000 }, { timestamp: 1_000 }])).toBe(0);
  });

  it("returns undefined for a single message", () => {
    expect(durationFromMessages([{ timestamp: 1_000 }])).toBeUndefined();
  });

  it("returns undefined for missing timestamps", () => {
    expect(durationFromMessages([])).toBeUndefined();
    expect(durationFromMessages([{}])).toBeUndefined();
    expect(durationFromMessages([{ timestamp: 1_000 }, {}])).toBeUndefined();
    expect(durationFromMessages([{}, { timestamp: 1_000 }])).toBeUndefined();
  });

  it("returns undefined for inverted or non-finite timestamps", () => {
    expect(durationFromMessages([{ timestamp: 5_000 }, { timestamp: 1_000 }])).toBeUndefined();
    expect(durationFromMessages([{ timestamp: Number.NaN }, { timestamp: 1_000 }])).toBeUndefined();
  });
});
