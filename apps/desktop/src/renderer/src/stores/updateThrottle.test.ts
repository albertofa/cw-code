import { describe, expect, it } from "vitest";
import type { UpdateState } from "../cw.js";
import { PROGRESS_RENDER_INTERVAL_MS, shouldApplyUpdateState } from "./updateThrottle.js";

function downloading(seq: number, percent: number, patch: Partial<UpdateState> = {}): UpdateState {
  return {
    seq,
    phase: "downloading",
    runningVersion: "1.0.0",
    channel: "stable",
    availableVersion: "1.1.0",
    downloadedVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    progress: { percent, transferred: percent, total: 100, bytesPerSecond: 10 },
    checkedAt: 1,
    error: null,
    disabledReason: null,
    autoDownload: true,
    ...patch
  };
}

describe("shouldApplyUpdateState", () => {
  it("always applies the first state and never applies an older one", () => {
    expect(shouldApplyUpdateState(null, downloading(1, 0), 0, 0)).toBe(true);
    expect(shouldApplyUpdateState(downloading(5, 10), downloading(4, 50), 0, 10_000)).toBe(false);
  });

  it("drops small progress steps that arrive quickly", () => {
    const current = downloading(3, 10);
    expect(shouldApplyUpdateState(current, downloading(4, 11), 1_000, 1_100)).toBe(false);
    expect(shouldApplyUpdateState(current, downloading(4, 11.9), 1_000, 1_000 + PROGRESS_RENDER_INTERVAL_MS - 1)).toBe(false);
  });

  it("applies progress after the interval, after a 2% step, and at completion", () => {
    const current = downloading(3, 10);
    expect(shouldApplyUpdateState(current, downloading(4, 10.5), 1_000, 1_000 + PROGRESS_RENDER_INTERVAL_MS)).toBe(true);
    expect(shouldApplyUpdateState(current, downloading(4, 12), 1_000, 1_010)).toBe(true);
    expect(shouldApplyUpdateState(downloading(3, 99.5), downloading(4, 100), 1_000, 1_010)).toBe(true);
  });

  it("never throttles phase or other field changes", () => {
    const current = downloading(3, 10);
    expect(shouldApplyUpdateState(current, { ...downloading(4, 10), phase: "ready", progress: null, downloadedVersion: "1.1.0" }, 1_000, 1_001)).toBe(true);
    expect(shouldApplyUpdateState(current, downloading(4, 10.2, { autoDownload: false }), 1_000, 1_001)).toBe(true);
    expect(
      shouldApplyUpdateState(current, downloading(4, 10.2, { error: { message: "x", context: "check", retryable: true } }), 1_000, 1_001)
    ).toBe(true);
  });

  it("treats an equal error as unchanged", () => {
    const error = { message: "offline", context: "check" as const, retryable: true };
    expect(shouldApplyUpdateState(downloading(3, 10, { error }), downloading(4, 10.5, { error: { ...error } }), 1_000, 1_001)).toBe(false);
  });
});
