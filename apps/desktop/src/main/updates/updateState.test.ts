import { describe, expect, it } from "vitest";
import type { UpdateState } from "@cw-code/contracts";
import {
  RELEASE_NOTES_MAX_CHARS,
  boundedText,
  channelOfVersion,
  compareVersions,
  initialUpdateState,
  isEligible,
  isUpdateChannel,
  normalizeReleaseNotes,
  reduceUpdate,
  type UpdateCandidate,
  type UpdateEvent
} from "./updateState.js";

function candidate(version: string, notes: string | null = null): UpdateCandidate {
  return { version, releaseName: `cw-code ${version}`, releaseNotes: notes, releaseDate: "2026-09-24T00:00:00.000Z" };
}

function idle(overrides: Partial<Parameters<typeof initialUpdateState>[0]> = {}): UpdateState {
  return initialUpdateState({ runningVersion: "1.0.0", channel: "stable", autoDownload: false, disabledReason: null, ...overrides });
}

function run(state: UpdateState, events: UpdateEvent[]): UpdateState {
  return events.reduce(reduceUpdate, state);
}

const FAILURE = { message: "offline", retryable: true };

function readyAt(version: string, state = idle()): UpdateState {
  return run(state, [
    { type: "check-started" },
    { type: "check-succeeded", at: 1, candidate: candidate(version) },
    { type: "download-started", version },
    { type: "download-succeeded", version }
  ]);
}

describe("compareVersions", () => {
  it("orders release versions numerically", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("orders alpha builds below their release and by alpha number", () => {
    expect(compareVersions("1.0.0-alpha.5", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-alpha.5")).toBe(1);
    expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.3", "1.0.0-alpha.3")).toBe(0);
    expect(compareVersions("1.0.1-alpha.1", "1.0.0")).toBe(1);
  });

  it("rejects shapes it does not understand", () => {
    for (const bad of ["1.0", "v1.0.0", "1.0.0-beta.1", "1.0.0-alpha", "1.0.0-alpha.1+build.5", "", "1.0.0.0", "latest"]) {
      expect(compareVersions(bad, "1.0.0")).toBeNull();
      expect(compareVersions("1.0.0", bad)).toBeNull();
    }
  });
});

describe("channelOfVersion", () => {
  it("derives the channel from the prerelease tag", () => {
    expect(channelOfVersion("0.0.1-alpha.21")).toBe("alpha");
    expect(channelOfVersion("1.0.0")).toBe("stable");
    expect(channelOfVersion("1.0.0-beta.1")).toBe("stable");
  });
});

describe("isEligible", () => {
  it("never offers prereleases on the stable channel", () => {
    expect(isEligible("2.0.0-alpha.1", "1.0.0", "stable")).toBe(false);
    expect(isEligible("1.0.1", "1.0.0", "stable")).toBe(true);
  });

  it("never offers the running version or anything lower", () => {
    expect(isEligible("1.0.0", "1.0.0", "stable")).toBe(false);
    expect(isEligible("0.9.9", "1.0.0", "alpha")).toBe(false);
    expect(isEligible("1.0.0-alpha.4", "1.0.0-alpha.5", "alpha")).toBe(false);
  });

  it("accepts newer stable and alpha builds on the alpha channel", () => {
    expect(isEligible("1.0.0-alpha.6", "1.0.0-alpha.5", "alpha")).toBe(true);
    expect(isEligible("1.0.0", "1.0.0-alpha.5", "alpha")).toBe(true);
  });

  it("makes an alpha user on stable wait for a newer stable", () => {
    expect(isEligible("1.0.0-alpha.6", "1.0.0-alpha.5", "stable")).toBe(false);
    expect(isEligible("0.9.0", "1.0.0-alpha.5", "stable")).toBe(false);
    expect(isEligible("1.0.0", "1.0.0-alpha.5", "stable")).toBe(true);
  });

  it("rejects malformed candidates and running versions", () => {
    expect(isEligible("1.0.0-rc.1", "0.1.0", "alpha")).toBe(false);
    expect(isEligible("garbage", "0.1.0", "alpha")).toBe(false);
    expect(isEligible("2.0.0", "dev", "stable")).toBe(false);
  });
});

describe("isUpdateChannel", () => {
  it("accepts only stable and alpha", () => {
    expect(isUpdateChannel("stable")).toBe(true);
    expect(isUpdateChannel("alpha")).toBe(true);
    expect(isUpdateChannel("latest")).toBe(false);
    expect(isUpdateChannel(undefined)).toBe(false);
    expect(isUpdateChannel({ channel: "alpha" })).toBe(false);
  });
});

describe("normalizeReleaseNotes", () => {
  it("keeps plain strings and normalizes line endings", () => {
    expect(normalizeReleaseNotes("  Fixes\r\n- one\r- two  ")).toBe("Fixes\n- one\n- two");
  });

  it("flattens version note arrays and skips malformed entries", () => {
    const notes = [
      { version: "1.0.1", note: "Second" },
      { version: "1.0.0", note: null },
      "junk",
      null,
      { note: "No version" },
      { version: 7, note: "Numeric version" }
    ];
    expect(normalizeReleaseNotes(notes)).toBe("## 1.0.1\n\nSecond\n\nNo version\n\nNumeric version");
  });

  it("returns null for missing, empty, or unsupported values", () => {
    expect(normalizeReleaseNotes(null)).toBeNull();
    expect(normalizeReleaseNotes(undefined)).toBeNull();
    expect(normalizeReleaseNotes("   ")).toBeNull();
    expect(normalizeReleaseNotes([])).toBeNull();
    expect(normalizeReleaseNotes(42)).toBeNull();
    expect(normalizeReleaseNotes({ note: "x" })).toBeNull();
  });

  it("caps oversized notes and keeps markup as inert text", () => {
    const huge = `<script>alert(1)</script>${"x".repeat(RELEASE_NOTES_MAX_CHARS * 2)}`;
    const normalized = normalizeReleaseNotes(huge);
    expect(normalized).toHaveLength(RELEASE_NOTES_MAX_CHARS);
    expect(normalized?.startsWith("<script>alert(1)</script>")).toBe(true);
  });
});

describe("boundedText", () => {
  it("trims, caps, and rejects non-strings", () => {
    expect(boundedText("  name  ", 10)).toBe("name");
    expect(boundedText("abcdef", 3)).toBe("abc");
    expect(boundedText(5, 3)).toBeNull();
    expect(boundedText("   ", 3)).toBeNull();
  });
});

describe("reduceUpdate", () => {
  it("starts idle, or disabled with a reason", () => {
    expect(idle()).toMatchObject({ phase: "idle", seq: 0, disabledReason: null });
    expect(idle({ disabledReason: "nope" })).toMatchObject({ phase: "disabled", disabledReason: "nope" });
  });

  it("walks checking, available, downloading, and ready", () => {
    const checking = reduceUpdate(idle(), { type: "check-started" });
    expect(checking).toMatchObject({ phase: "checking", seq: 1 });
    const available = reduceUpdate(checking, { type: "check-succeeded", at: 10, candidate: candidate("1.1.0", "notes") });
    expect(available).toMatchObject({
      phase: "available",
      availableVersion: "1.1.0",
      releaseName: "cw-code 1.1.0",
      releaseNotes: "notes",
      checkedAt: 10,
      seq: 2
    });
    const downloading = reduceUpdate(available, { type: "download-started", version: "1.1.0" });
    expect(downloading).toMatchObject({ phase: "downloading", progress: { percent: 0 }, seq: 3 });
    const progressed = reduceUpdate(downloading, {
      type: "download-progress",
      progress: { percent: 40, transferred: 40, total: 100, bytesPerSecond: 5 }
    });
    expect(progressed).toMatchObject({ progress: { percent: 40, transferred: 40, total: 100 }, seq: 4 });
    const ready = reduceUpdate(progressed, { type: "download-succeeded", version: "1.1.0" });
    expect(ready).toMatchObject({ phase: "ready", downloadedVersion: "1.1.0", progress: null, seq: 5 });
  });

  it("reports up-to-date when nothing eligible exists", () => {
    const state = run(idle(), [{ type: "check-started" }, { type: "check-succeeded", at: 5, candidate: null }]);
    expect(state).toMatchObject({ phase: "up-to-date", availableVersion: null, checkedAt: 5, error: null });
  });

  it("records check and download failures with their context", () => {
    const checkFailed = run(idle(), [{ type: "check-started" }, { type: "check-failed", at: 3, failure: FAILURE }]);
    expect(checkFailed).toMatchObject({ phase: "error", checkedAt: 3, error: { message: "offline", context: "check", retryable: true } });
    const downloadFailed = run(idle(), [
      { type: "check-started" },
      { type: "check-succeeded", at: 1, candidate: candidate("1.1.0") },
      { type: "download-started", version: "1.1.0" },
      { type: "download-failed", failure: { message: "checksum", retryable: true } }
    ]);
    expect(downloadFailed).toMatchObject({ phase: "error", progress: null, error: { context: "download" }, availableVersion: "1.1.0" });
    const retried = reduceUpdate(downloadFailed, { type: "download-started", version: "1.1.0" });
    expect(retried).toMatchObject({ phase: "downloading", error: null });
  });

  it("keeps a ready download through failed and empty checks", () => {
    const ready = readyAt("1.1.0");
    const afterFailure = run(ready, [{ type: "check-started" }, { type: "check-failed", at: 9, failure: FAILURE }]);
    expect(afterFailure).toMatchObject({ phase: "ready", downloadedVersion: "1.1.0", availableVersion: "1.1.0", error: { context: "check" } });
    const afterEmpty = run(afterFailure, [{ type: "check-started" }, { type: "check-succeeded", at: 10, candidate: null }]);
    expect(afterEmpty).toMatchObject({ phase: "ready", downloadedVersion: "1.1.0", availableVersion: "1.1.0", error: null });
    const afterOlder = run(afterEmpty, [{ type: "check-started" }, { type: "check-succeeded", at: 11, candidate: candidate("1.0.5") }]);
    expect(afterOlder).toMatchObject({ phase: "ready", downloadedVersion: "1.1.0", availableVersion: "1.1.0" });
  });

  it("offers a newer version while keeping the older download usable", () => {
    const state = run(readyAt("1.1.0"), [{ type: "check-started" }, { type: "check-succeeded", at: 12, candidate: candidate("1.2.0") }]);
    expect(state).toMatchObject({ phase: "available", availableVersion: "1.2.0", downloadedVersion: "1.1.0" });
    const failed = run(state, [
      { type: "download-started", version: "1.2.0" },
      { type: "download-failed", failure: FAILURE }
    ]);
    expect(failed).toMatchObject({ phase: "ready", downloadedVersion: "1.1.0", error: { context: "download" } });
  });

  it("ignores events that do not fit the current phase without bumping seq", () => {
    const base = idle();
    const stale: UpdateEvent[] = [
      { type: "check-succeeded", at: 1, candidate: candidate("2.0.0") },
      { type: "check-failed", at: 1, failure: FAILURE },
      { type: "download-progress", progress: { percent: 10, transferred: 1, total: 10, bytesPerSecond: 1 } },
      { type: "download-succeeded", version: "2.0.0" },
      { type: "download-failed", failure: FAILURE },
      { type: "download-started", version: "2.0.0" }
    ];
    for (const event of stale) expect(reduceUpdate(base, event)).toBe(base);
    const checking = reduceUpdate(base, { type: "check-started" });
    expect(reduceUpdate(checking, { type: "check-started" })).toBe(checking);
    const available = reduceUpdate(checking, { type: "check-succeeded", at: 1, candidate: candidate("1.1.0") });
    expect(reduceUpdate(available, { type: "download-started", version: "1.2.0" })).toBe(available);
    const downloading = reduceUpdate(available, { type: "download-started", version: "1.1.0" });
    expect(reduceUpdate(downloading, { type: "download-succeeded", version: "9.9.9" })).toBe(downloading);
    expect(reduceUpdate(downloading, { type: "check-started" })).toBe(downloading);
  });

  it("increments seq exactly once per visible change", () => {
    const state = idle();
    const toggled = reduceUpdate(state, { type: "auto-download-changed", autoDownload: true });
    expect(toggled.seq).toBe(1);
    expect(reduceUpdate(toggled, { type: "auto-download-changed", autoDownload: true })).toBe(toggled);
    expect(reduceUpdate(toggled, { type: "channel-changed", channel: "stable" })).toBe(toggled);
  });

  it("clamps malformed progress numbers", () => {
    const downloading = run(idle(), [
      { type: "check-started" },
      { type: "check-succeeded", at: 1, candidate: candidate("1.1.0") },
      { type: "download-started", version: "1.1.0" }
    ]);
    const next = reduceUpdate(downloading, {
      type: "download-progress",
      progress: { percent: 180, transferred: Number.NaN, total: -5, bytesPerSecond: Number.POSITIVE_INFINITY }
    });
    expect(next.progress).toEqual({ percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 });
  });

  it("ignores update activity while disabled but still records settings", () => {
    const disabled = idle({ disabledReason: "dev" });
    expect(reduceUpdate(disabled, { type: "check-started" })).toBe(disabled);
    const switched = reduceUpdate(disabled, { type: "channel-changed", channel: "alpha" });
    expect(switched).toMatchObject({ phase: "disabled", channel: "alpha" });
  });

  it("drops candidates and downloads that the new channel does not allow", () => {
    const alphaReady = readyAt("1.0.0-alpha.7", idle({ runningVersion: "1.0.0-alpha.5", channel: "alpha" }));
    const stable = reduceUpdate(alphaReady, { type: "channel-changed", channel: "stable" });
    expect(stable).toMatchObject({
      channel: "stable",
      phase: "idle",
      availableVersion: null,
      downloadedVersion: null,
      releaseNotes: null,
      error: null
    });
  });

  it("keeps downloads the new channel still allows", () => {
    const stableReady = readyAt("1.1.0");
    const alpha = reduceUpdate(stableReady, { type: "channel-changed", channel: "alpha" });
    expect(alpha).toMatchObject({ channel: "alpha", phase: "ready", downloadedVersion: "1.1.0", availableVersion: "1.1.0" });
  });

  it("invalidates an in-progress download when the channel changes", () => {
    const downloading = run(idle({ runningVersion: "1.0.0-alpha.1", channel: "alpha" }), [
      { type: "check-started" },
      { type: "check-succeeded", at: 1, candidate: candidate("1.0.0-alpha.2") },
      { type: "download-started", version: "1.0.0-alpha.2" }
    ]);
    const switched = reduceUpdate(downloading, { type: "channel-changed", channel: "stable" });
    expect(switched).toMatchObject({ phase: "idle", progress: null, availableVersion: null });
    expect(reduceUpdate(switched, { type: "download-succeeded", version: "1.0.0-alpha.2" })).toBe(switched);
  });
});
