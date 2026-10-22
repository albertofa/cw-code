import { describe, expect, it } from "bun:test";
import { prKey, prRefFromUrl } from "./prRef.js";

describe("prKey", () => {
  it("formats host, owner, repo and number", () => {
    expect(prKey({ host: "github.com", owner: "acme", repo: "app", number: 7 })).toBe("github.com/acme/app#7");
  });
});

describe("prRefFromUrl", () => {
  it("parses a github.com pull request URL", () => {
    expect(prRefFromUrl("https://github.com/acme/app/pull/42")).toEqual({ host: "github.com", owner: "acme", repo: "app", number: 42 });
  });

  it("lower-cases the host and keeps owner and repo casing", () => {
    expect(prRefFromUrl("https://GitHub.com/Acme/App/pull/1")).toEqual({ host: "github.com", owner: "Acme", repo: "App", number: 1 });
  });

  it("accepts an enterprise host", () => {
    expect(prRefFromUrl("https://ghe.example.com/acme/app/pull/3")).toEqual({ host: "ghe.example.com", owner: "acme", repo: "app", number: 3 });
  });

  it("ignores a trailing path and surrounding whitespace", () => {
    expect(prRefFromUrl("  https://github.com/acme/app/pull/42/files#diff  ")).toEqual({ host: "github.com", owner: "acme", repo: "app", number: 42 });
  });

  it("rejects zero and numbers beyond the safe integer range", () => {
    expect(prRefFromUrl("https://github.com/acme/app/pull/0")).toBeNull();
    expect(prRefFromUrl("https://github.com/acme/app/pull/99999999999999999999")).toBeNull();
  });

  it("rejects URLs that are not pull requests", () => {
    expect(prRefFromUrl("https://github.com/acme/app/issues/5")).toBeNull();
    expect(prRefFromUrl("https://github.com/acme/app")).toBeNull();
    expect(prRefFromUrl("not a url")).toBeNull();
  });
});
