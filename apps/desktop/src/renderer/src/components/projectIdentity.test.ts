import { describe, expect, it } from "bun:test";
import { deriveProjectIdentity } from "./projectIdentity.js";

describe("deriveProjectIdentity", () => {
  it.each([
    ["cmutil-nuget", "CN"],
    ["t3code", "T3"],
    ["nuria-devkit", "ND"],
    ["connect-info", "CI"],
    ["", "PR"],
  ])("derives monogram for %j", (name, monogram) => {
    expect(deriveProjectIdentity(name).monogram).toBe(monogram);
  });

  it.each([
    ["cmutil-nuget", "var(--project-sky)"],
    ["nuria-devkit", "var(--project-lime)"],
    ["connect-info", "var(--project-red)"],
  ])("derives color for %j", (name, color) => {
    expect(deriveProjectIdentity(name).color).toBe(color);
  });

  it("is deterministic", () => {
    expect(deriveProjectIdentity("cmutil-nuget")).toEqual(deriveProjectIdentity("cmutil-nuget"));
  });
});
