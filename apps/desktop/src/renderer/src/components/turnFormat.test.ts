import { describe, expect, it } from "vitest";
import { durationFromMessages, formatElapsed } from "./turnFormat.js";

describe("formatElapsed", () => {
  it("formats sub-minute durations with singular seconds", () => {
    expect(formatElapsed(0)).toBe("0 seconds");
    expect(formatElapsed(1_000)).toBe("1 second");
    expect(formatElapsed(50_000)).toBe("50 seconds");
    expect(formatElapsed(59_000)).toBe("59 seconds");
  });

  it("formats minute and hour durations", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(183_000)).toBe("3m 3s");
    expect(formatElapsed(3_723_000)).toBe("1h 2m 3s");
  });

  it("floors partial seconds", () => {
    expect(formatElapsed(1_999)).toBe("1 second");
  });
});

describe("durationFromMessages", () => {
  it("returns the span between the first and last timestamps", () => {
    expect(durationFromMessages([{ timestamp: 1_000 }, { timestamp: 4_500 }])).toBe(3_500);
  });

  it("returns zero for equal timestamps, including a single message", () => {
    expect(durationFromMessages([{ timestamp: 1_000 }, { timestamp: 1_000 }])).toBe(0);
    expect(durationFromMessages([{ timestamp: 1_000 }])).toBe(0);
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
