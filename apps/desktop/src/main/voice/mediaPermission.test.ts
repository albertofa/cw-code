import { describe, expect, it } from "vitest";
import { allowPermissionRequest } from "./mediaPermission.js";

describe("allowPermissionRequest", () => {
  it("allows audio-only capture", () => {
    expect(allowPermissionRequest("media", { mediaTypes: ["audio"] })).toBe(true);
  });

  it("refuses camera access, alone or together with audio", () => {
    expect(allowPermissionRequest("media", { mediaTypes: ["video"] })).toBe(false);
    expect(allowPermissionRequest("media", { mediaTypes: ["audio", "video"] })).toBe(false);
  });

  it("refuses a media request that does not say what it wants", () => {
    expect(allowPermissionRequest("media", {})).toBe(false);
    expect(allowPermissionRequest("media", { mediaTypes: [] })).toBe(false);
  });

  it("leaves every other permission at Electron's default", () => {
    expect(allowPermissionRequest("clipboard-sanitized-write", {})).toBe(true);
    expect(allowPermissionRequest("notifications", {})).toBe(true);
  });
});
