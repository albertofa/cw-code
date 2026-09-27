import { describe, expect, it } from "vitest";
import { channelOfVersion as mainChannelOfVersion } from "../../../main/updates/updateState.js";
import { channelOfVersion } from "./updateChannel.js";

const VERSIONS = ["0.0.1-alpha.21", "1.2.0", " 1.2.0-alpha.3 ", "1.2.0-beta.1", "1.2.0-alphabet", "alpha", "", "1.2-alpha.1", "v1.2.0-alpha.1"];

describe("channelOfVersion (renderer)", () => {
  it("maps alpha prereleases to alpha and everything else to stable", () => {
    expect(channelOfVersion("0.0.1-alpha.21")).toBe("alpha");
    expect(channelOfVersion("1.2.0")).toBe("stable");
    expect(channelOfVersion("1.2.0-beta.1")).toBe("stable");
  });

  it("matches the main-process rule for every sample", () => {
    for (const version of VERSIONS) expect(channelOfVersion(version)).toBe(mainChannelOfVersion(version));
  });
});
