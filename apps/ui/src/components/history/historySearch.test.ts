import { describe, expect, it } from "bun:test";
import { isEmptyQuery, matchesQuery, parseHistoryQuery, type HistorySearchTarget } from "./historySearch.js";

const commit: HistorySearchTarget = {
  sha: "d3418e2a42081fc73ea559ef3c8eac4e96d9a71d",
  subject: "fix(opensearch): send Dashboards SAML login through Google",
  authorName: "Lucas Passos",
  authorEmail: "lucas.passos@example.com",
  refs: ["origin/master", "v0.9.0"]
};

describe("parseHistoryQuery", () => {
  it("routes plain words to the selected scope", () => {
    expect(parseHistoryQuery("SAML login", "messages").terms).toEqual([
      { field: "message", value: "saml" },
      { field: "message", value: "login" }
    ]);
    expect(parseHistoryQuery("lucas", "authors").terms).toEqual([{ field: "author", value: "lucas" }]);
    expect(parseHistoryQuery("master", "refs").terms).toEqual([{ field: "ref", value: "master" }]);
    expect(parseHistoryQuery("d3418e", "ids").terms).toEqual([{ field: "sha", value: "d3418e" }]);
    expect(parseHistoryQuery("saml", "everything").terms).toEqual([{ field: "any", value: "saml" }]);
  });

  it("reads prefixes whatever the scope", () => {
    expect(parseHistoryQuery("author:Lucas branch:master tag:v0 sha:D341 message:saml", "messages").terms).toEqual([
      { field: "author", value: "lucas" },
      { field: "ref", value: "master" },
      { field: "ref", value: "v0" },
      { field: "sha", value: "d341" },
      { field: "message", value: "saml" }
    ]);
  });

  it("keeps quoted values together", () => {
    expect(parseHistoryQuery('author:"Lucas Passos" "SAML login"', "everything").terms).toEqual([
      { field: "author", value: "lucas passos" },
      { field: "any", value: "saml login" }
    ]);
  });

  it("treats unknown prefixes and conventional commit types as text", () => {
    expect(parseHistoryQuery("fix: feat:ui fix(ui):", "messages").terms).toEqual([
      { field: "message", value: "fix:" },
      { field: "message", value: "feat:ui" },
      { field: "message", value: "fix(ui):" }
    ]);
  });

  it("ignores a prefix still waiting for its value", () => {
    expect(isEmptyQuery(parseHistoryQuery("author:", "everything"))).toBe(true);
    expect(isEmptyQuery(parseHistoryQuery("   ", "everything"))).toBe(true);
  });
});

describe("matchesQuery", () => {
  const match = (text: string, scope: Parameters<typeof parseHistoryQuery>[1] = "everything"): boolean =>
    matchesQuery(parseHistoryQuery(text, scope), commit);

  it("matches everything on message, author, refs and sha", () => {
    expect(match("dashboards")).toBe(true);
    expect(match("passos")).toBe(true);
    expect(match("example.com")).toBe(true);
    expect(match("v0.9")).toBe(true);
    expect(match("d3418e")).toBe(true);
    expect(match("nothing")).toBe(false);
  });

  it("limits plain words to the scope", () => {
    expect(match("lucas", "messages")).toBe(false);
    expect(match("lucas", "authors")).toBe(true);
    expect(match("master", "messages")).toBe(false);
    expect(match("master", "refs")).toBe(true);
  });

  it("matches commit ids by prefix only", () => {
    expect(match("sha:d3418e")).toBe(true);
    expect(match("sha:3418e")).toBe(false);
  });

  it("requires every term", () => {
    expect(match("author:lucas message:saml")).toBe(true);
    expect(match("author:lucas message:runner")).toBe(false);
  });

  it("matches everything when the query is empty", () => {
    expect(match("")).toBe(true);
  });
});
