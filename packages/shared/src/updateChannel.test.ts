import { describe, expect, it } from "bun:test";
import { channelOfVersion } from "./updateChannel.js";

describe("channelOfVersion", () => {
  it("derives the channel from the prerelease tag", () => {
    expect(channelOfVersion("0.0.1-alpha.21")).toBe("alpha");
    expect(channelOfVersion("1.0.0")).toBe("stable");
    expect(channelOfVersion("1.0.0-beta.1")).toBe("stable");
  });

  it("trims the version and needs a full x.y.z core before the alpha tag", () => {
    expect(channelOfVersion(" 1.2.0-alpha.3 ")).toBe("alpha");
    for (const version of ["alpha", "", "1.2-alpha.1", "v1.2.0-alpha.1"]) expect(channelOfVersion(version)).toBe("stable");
  });
});
