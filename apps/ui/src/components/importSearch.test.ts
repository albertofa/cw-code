import { describe, expect, it } from "bun:test";
import type { ImportableSession } from "../cw.js";
import { filterImportable } from "./importSearch.js";

function session(overrides: Partial<ImportableSession>): ImportableSession {
  return {
    driver: "claude",
    resumeCursor: "abc-123",
    title: "Fix login",
    cwd: "C:\\Projects\\web-app",
    createdAt: 1,
    updatedAt: 2,
    projectName: "web-app",
    projectRoot: "C:\\Projects\\web-app",
    ...overrides
  };
}

describe("filterImportable", () => {
  const sessions = [
    session({ resumeCursor: "a", title: "Fix login redirect", gitBranch: "feat/auth", repository: "acme/web-app" }),
    session({ resumeCursor: "b", title: "Billing export", cwd: "/home/me/billing", projectName: "billing", gitBranch: "main" }),
    session({ resumeCursor: "c", title: "Untitled", repository: "acme/infra", projectName: "infra" })
  ];

  it("returns everything for a blank query", () => {
    expect(filterImportable(sessions, "   ")).toHaveLength(3);
  });

  it("matches title, project, path, repository, branch and cursor case-insensitively", () => {
    expect(filterImportable(sessions, "LOGIN").map((s) => s.resumeCursor)).toEqual(["a"]);
    expect(filterImportable(sessions, "billing").map((s) => s.resumeCursor)).toEqual(["b"]);
    expect(filterImportable(sessions, "/home/me").map((s) => s.resumeCursor)).toEqual(["b"]);
    expect(filterImportable(sessions, "acme/infra").map((s) => s.resumeCursor)).toEqual(["c"]);
    expect(filterImportable(sessions, "feat/auth").map((s) => s.resumeCursor)).toEqual(["a"]);
    expect(filterImportable(sessions, "c").map((s) => s.resumeCursor)).toContain("c");
  });

  it("requires every term to match somewhere in the session", () => {
    expect(filterImportable(sessions, "acme login").map((s) => s.resumeCursor)).toEqual(["a"]);
    expect(filterImportable(sessions, "acme billing")).toEqual([]);
  });
});
