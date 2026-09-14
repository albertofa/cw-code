import { describe, expect, it } from "vitest";
import { pickRestoreCandidate } from "./sessionRestore.js";

describe("pickRestoreCandidate", () => {
  it("returns null when nothing is unclaimed", () => {
    expect(
      pickRestoreCandidate("fix login", [
        { resumeCursor: "a", title: "fix login", updatedAt: 2, claimed: true },
        { resumeCursor: "", title: "fix login", updatedAt: 3, claimed: false }
      ])
    ).toBeNull();
  });

  it("prefers a title match over a more recent candidate", () => {
    expect(
      pickRestoreCandidate("fix login", [
        { resumeCursor: "recent", title: "other work", updatedAt: 10, claimed: false },
        { resumeCursor: "match", title: "Fix Login", updatedAt: 2, claimed: false }
      ])
    ).toBe("match");
  });

  it("falls back to the most recent unclaimed session for a started session", () => {
    expect(
      pickRestoreCandidate("fix login", [
        { resumeCursor: "old", title: "other work", updatedAt: 2, claimed: false },
        { resumeCursor: "new", title: "another", updatedAt: 9, claimed: false }
      ])
    ).toBe("new");
  });

  it("never adopts a stray session for a brand-new session", () => {
    expect(
      pickRestoreCandidate("New session", [
        { resumeCursor: "stray", title: "whatever", updatedAt: 9, claimed: false }
      ])
    ).toBeNull();
  });
});
