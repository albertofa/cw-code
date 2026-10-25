import { describe, expect, it } from "bun:test";
import type { PrRef, SessionPrLink } from "@cw-code/contracts";
import { linkFor, prRefLabel, sessionLinks } from "./sessionPrLinks.js";

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
