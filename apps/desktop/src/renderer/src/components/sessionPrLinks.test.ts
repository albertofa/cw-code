import { describe, expect, it } from "bun:test";
import type { PrRef, SessionPrLink } from "@cw-code/contracts";
import { linkFor, linkWithWorkflow, prRefLabel, sessionLinks } from "./sessionPrLinks.js";

function ref(number: number, repo = "widgets"): PrRef {
  return { host: "github.com", owner: "acme", repo, number };
}

function link(number: number): SessionPrLink {
  return { ref: ref(number), origin: "linked", lastSeenSha: `sha-${number}`, lastSeenAt: 1_000 };
}

describe("session link lookups", () => {
  it("returns a stable empty list for sessions without links", () => {
    expect(sessionLinks({})).toEqual([]);
    expect(sessionLinks({})).toBe(sessionLinks(undefined));
  });

  it("finds the link for a ref by value", () => {
    const session = { prs: [link(1), link(2)] };
    expect(linkFor(session, ref(2))).toBe(session.prs[1]);
    expect(linkFor(session, ref(2, "gadgets"))).toBeUndefined();
  });

  it("labels a ref with its repository and number", () => {
    expect(prRefLabel(ref(7))).toBe("acme/widgets#7");
  });
});

describe("linkWithWorkflow", () => {
  const opened: SessionPrLink = { ref: ref(7), origin: "opened", lastSeenSha: "sha-7", lastSeenAt: 1_000 };

  it("adopts the workflow on a link the session opened, keeping its origin and seen state", () => {
    expect(linkWithWorkflow({ prs: [opened] }, ref(7), "babysit")).toEqual({ ...opened, workflowId: "babysit" });
  });

  it("returns null when the link already runs that workflow or the PR is not linked", () => {
    expect(linkWithWorkflow({ prs: [{ ...opened, workflowId: "babysit" }] }, ref(7), "babysit")).toBeNull();
    expect(linkWithWorkflow({ prs: [opened] }, ref(8), "babysit")).toBeNull();
  });
});
