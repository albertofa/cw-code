import { describe, expect, it } from "vitest";
import type { Project, Session } from "../cw.js";
import {
  concreteFilterId,
  defaultNewSessionProjectId,
  discoveredOwnerId,
  discoveryProjectId,
  projectsByRecentActivity
} from "./projectRecency.js";

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

  it("prefers the project that owns the active session over the filter", () => {
    expect(defaultNewSessionProjectId(projects, byProject, "b1", "c")).toBe("b");
  });

  it("uses a concrete project filter before recency", () => {
    expect(defaultNewSessionProjectId(projects, byProject, null, "c")).toBe("c");
    expect(defaultNewSessionProjectId(projects, byProject, "missing", "b")).toBe("b");
  });

  it("ignores a filter that points to an unregistered project", () => {
    expect(defaultNewSessionProjectId(projects, byProject, null, "gone")).toBe("a");
  });

  it("falls back to the most recently used project", () => {
    expect(defaultNewSessionProjectId(projects, byProject, null, "all")).toBe("a");
  });

  it("ignores an active session whose project is no longer registered", () => {
    expect(defaultNewSessionProjectId([project("a")], { gone: [session("g1", "gone", 99)], ...byProject }, "g1", "all")).toBe("a");
  });

  it("falls back to the first project without any sessions", () => {
    expect(defaultNewSessionProjectId(projects, {}, null, "all")).toBe("a");
  });

  it("returns null when there are no projects", () => {
    expect(defaultNewSessionProjectId([], {}, null, "all")).toBeNull();
  });
});

describe("concreteFilterId", () => {
  it("returns the filter only when it names a registered project", () => {
    expect(concreteFilterId(projects, "b")).toBe("b");
    expect(concreteFilterId(projects, "all")).toBeNull();
    expect(concreteFilterId(projects, "gone")).toBeNull();
  });
});

describe("discoveryProjectId", () => {
  it("follows a concrete filter and falls back to the active project", () => {
    expect(discoveryProjectId("b", "a")).toBe("b");
    expect(discoveryProjectId("all", "a")).toBe("a");
    expect(discoveryProjectId("all", null)).toBeNull();
  });
});

describe("discoveredOwnerId", () => {
  it("imports into the project whose discovered list holds the session", () => {
    const cli = session("cli_1", "a", 1);
    expect(discoveredOwnerId({ a: [], b: [{ ...cli, projectId: "b" }] }, cli)).toBe("b");
  });

  it("falls back to the session's own project", () => {
    expect(discoveredOwnerId({}, session("cli_2", "c", 1))).toBe("c");
  });
});
