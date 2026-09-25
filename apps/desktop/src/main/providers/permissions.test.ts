import { describe, expect, it } from "vitest";
import { permissionOption, withSyntheticFullAccess } from "./permissions.js";

describe("withSyntheticFullAccess", () => {
  it("appends a non-native full access mode when the harness lacks one", () => {
    const out = withSyntheticFullAccess([
      permissionOption("manual", true),
      permissionOption("auto", true)
    ]);
    expect(out.map((o) => o.id)).toEqual(["manual", "auto", "bypassPermissions"]);
    const synthetic = out.find((o) => o.id === "bypassPermissions");
    expect(synthetic?.native).toBe(false);
    expect(synthetic?.description).toMatch(/auto-accept/i);
  });

  it("keeps the native bypass untouched when the harness provides one", () => {
    const out = withSyntheticFullAccess([
      permissionOption("manual", true),
      permissionOption("bypassPermissions", true)
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((o) => o.id === "bypassPermissions")?.native).toBe(true);
  });
});
