import { describe, expect, it } from "vitest";
import { firstRunChannelPatch, touchesUpdatePreferences, updatePreferences } from "./updatePreferences.js";

describe("updatePreferences", () => {
  it("derives the channel from the running version when none is chosen", () => {
    expect(updatePreferences({ updateChannel: null, updateBackgroundDownload: true }, "0.0.1-alpha.21")).toEqual({
      channel: "alpha",
      autoDownload: true
    });
    expect(updatePreferences({ updateChannel: null, updateBackgroundDownload: true }, "1.2.0").channel).toBe("stable");
  });

  it("keeps an explicit choice regardless of the running version", () => {
    expect(updatePreferences({ updateChannel: "stable", updateBackgroundDownload: false }, "0.0.1-alpha.21")).toEqual({
      channel: "stable",
      autoDownload: false
    });
    expect(updatePreferences({ updateChannel: "alpha", updateBackgroundDownload: true }, "1.2.0").channel).toBe("alpha");
  });

  it("freezes the derived channel on the first enabled run so a later stable build keeps an alpha tester on alpha", () => {
    expect(firstRunChannelPatch({ updateChannel: null }, "0.0.1-alpha.21", true)).toEqual({ updateChannel: "alpha" });
    expect(firstRunChannelPatch({ updateChannel: null }, "1.2.0", true)).toEqual({ updateChannel: "stable" });
    expect(firstRunChannelPatch({ updateChannel: "alpha" }, "1.2.0", true)).toBeNull();
    expect(firstRunChannelPatch({ updateChannel: null }, "0.0.1-alpha.21", false)).toBeNull();
  });

  it("detects patches that change update preferences", () => {
    expect(touchesUpdatePreferences({ updateChannel: null })).toBe(true);
    expect(touchesUpdatePreferences({ updateBackgroundDownload: false })).toBe(true);
    expect(touchesUpdatePreferences({ holdingHours: 3 })).toBe(false);
  });
});
