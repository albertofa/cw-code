import { describe, expect, it } from "bun:test";
import type { ConnectionProfile, DesktopApi } from "@cw-code/contracts";
import { deriveCapabilities } from "./capabilities.js";

const desktop = { isDev: false } as unknown as DesktopApi;
const local: ConnectionProfile = { id: "local", kind: "local", name: "This computer" };
const remote: ConnectionProfile = { id: "r1", kind: "remote", name: "Box", url: "https://box.example" };

describe("deriveCapabilities", () => {
  it("treats the desktop with the local profile as desktop and local server", () => {
    expect(deriveCapabilities(desktop, local)).toEqual({ desktop: true, localServer: true });
  });

  it("treats the desktop with a remote profile as desktop only", () => {
    expect(deriveCapabilities(desktop, remote)).toEqual({ desktop: true, localServer: false });
  });

  it("treats the desktop without a profile as desktop only", () => {
    expect(deriveCapabilities(desktop, null)).toEqual({ desktop: true, localServer: false });
  });

  it("never reports a local server in a browser", () => {
    for (const profile of [local, remote, null]) {
      expect(deriveCapabilities(undefined, profile)).toEqual({ desktop: false, localServer: false });
      expect(deriveCapabilities(null, profile)).toEqual({ desktop: false, localServer: false });
    }
  });
});
