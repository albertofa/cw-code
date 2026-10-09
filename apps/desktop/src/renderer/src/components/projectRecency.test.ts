import { describe, expect, it } from "vitest";
import type { Project, Session } from "../cw.js";
import { defaultNewSessionProjectId, projectsByRecentActivity } from "./projectRecency.js";

function project(id: string): Project {
  return { id, rootPath: `C:\\Projects\\${id}`, name: id };
}

function session(id: string, projectId: string, updatedAt: number): Session {
  return {
    id,
    projectId,
    driver: "claude",
    title: id,
    status: "idle",
    resumeCursor: "",
    createdAt: 1,
    updatedAt
  };
}

const projects = [project("a"), project("b"), project("c")];

describe("projectsByRecentActivity", () => {
  it("orders projects by their latest session and keeps the stored order for ties", () => {
    const byProject = { a: [session("a1", "a", 10)], c: [session("c1", "c", 30), session("c2", "c", 5)] };
    expect(projectsByRecentActivity(projects, byProject).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps the stored order when no project has sessions", () => {
    expect(projectsByRecentActivity(projects, {}).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("defaultNewSessionProjectId", () => {
  const byProject = { a: [session("a1", "a", 50)], b: [session("b1", "b", 10)] };

  it("prefers the project that owns the active session over recency", () => {
    expect(defaultNewSessionProjectId(projects, byProject, "b1")).toBe("b");
  });

  it("ignores an unknown active session", () => {
    expect(defaultNewSessionProjectId(projects, byProject, "missing")).toBe("a");
  });

  it("falls back to the most recently used project", () => {
    expect(defaultNewSessionProjectId(projects, byProject, null)).toBe("a");
  });

  it("ignores an active session whose project is no longer registered", () => {
    expect(defaultNewSessionProjectId([project("a")], { gone: [session("g1", "gone", 99)], ...byProject }, "g1")).toBe("a");
  });

  it("falls back to the first project without any sessions", () => {
    expect(defaultNewSessionProjectId(projects, {}, null)).toBe("a");
  });

  it("returns null when there are no projects", () => {
    expect(defaultNewSessionProjectId([], {}, null)).toBeNull();
  });
});
