import { describe, expect, it } from "vitest";
import { statusGroupsForRoot, type StatusCandidate } from "./statusTargets.js";

function candidate(overrides: Partial<StatusCandidate> & { id: string }): StatusCandidate {
  return { projectId: "p1", rootKey: "c:\\repo", active: true, ...overrides };
}

describe("statusGroupsForRoot", () => {
  it("groups active sessions on the root by project and base ref", () => {
    const groups = statusGroupsForRoot(
      [
        candidate({ id: "a" }),
        candidate({ id: "b", baseRef: "origin/main" }),
        candidate({ id: "c" }),
        candidate({ id: "d", baseRef: "origin/main" }),
      ],
      "c:\\repo",
      new Set(),
    );
    expect(groups).toEqual([
      { projectId: "p1", sessionIds: ["a", "c"] },
      { projectId: "p1", baseRef: "origin/main", sessionIds: ["b", "d"] },
    ]);
  });

  it("skips sessions on other roots and inactive sessions unless requested", () => {
    const groups = statusGroupsForRoot(
      [
        candidate({ id: "other", rootKey: "c:\\elsewhere" }),
        candidate({ id: "resolved", active: false }),
        candidate({ id: "requested", active: false }),
        candidate({ id: "moved", rootKey: null }),
      ],
      "c:\\repo",
      new Set(["requested", "moved"]),
    );
    expect(groups).toEqual([{ projectId: "p1", sessionIds: ["requested", "moved"] }]);
  });

  it("treats a blank base ref as none and dedupes session ids", () => {
    const groups = statusGroupsForRoot([candidate({ id: "a", baseRef: "  " }), candidate({ id: "a" })], "c:\\repo", new Set());
    expect(groups).toEqual([{ projectId: "p1", sessionIds: ["a"] }]);
  });

  it("returns no groups when nothing targets the root", () => {
    expect(statusGroupsForRoot([candidate({ id: "a", rootKey: "c:\\x" })], "c:\\repo", new Set())).toEqual([]);
  });
});
