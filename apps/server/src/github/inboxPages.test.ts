import { describe, expect, it } from "bun:test";
import { combineInboxQueries, fetchInboxPages } from "./inboxPages.js";

function node(number: number) {
  return { number, url: `https://github.com/acme/widgets/pull/${number}`, title: `PR ${number}`, state: "OPEN" };
}

function page(numbers: number[], endCursor: string | null) {
  return JSON.stringify({
    data: { viewer: { login: "me" }, search: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes: numbers.map(node) } }
  });
}

function pager(pages: Record<string, string | Error>) {
  const cursors: Array<string | null> = [];
  const fetch = async (after: string | null) => {
    cursors.push(after);
    const result = pages[after ?? "first"];
    if (result instanceof Error) throw result;
    return result;
  };
  return { cursors, fetch };
}

const numbers = (result: { items: Array<{ ref: { number: number } }> }) => result.items.map((item) => item.ref.number);

describe("fetchInboxPages", () => {
  it("follows cursors until GitHub reports no next page", async () => {
    const { cursors, fetch } = pager({ first: page([1, 2], "c1"), c1: page([3], null) });
    const result = await fetchInboxPages(fetch, 4);
    expect(numbers(result)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ truncated: false, error: null });
    expect(cursors).toEqual([null, "c1"]);
  });

  it("stops at the page cap and reports truncation", async () => {
    const { cursors, fetch } = pager({ first: page([1], "c1"), c1: page([2], "c2"), c2: page([3], "c3") });
    const result = await fetchInboxPages(fetch, 2);
    expect(numbers(result)).toEqual([1, 2]);
    expect(result).toMatchObject({ truncated: true, error: null });
    expect(cursors).toEqual([null, "c1"]);
  });

  it("keeps earlier pages when a later page fails or returns no viewer", async () => {
    const failed = await fetchInboxPages(pager({ first: page([1], "c1"), c1: new Error("gh: HTTP 502") }).fetch, 4);
    expect(numbers(failed)).toEqual([1]);
    expect(failed).toMatchObject({ truncated: true, error: "gh: HTTP 502" });

    const malformed = await fetchInboxPages(pager({ first: page([1], "c1"), c1: "not-json" }).fetch, 4);
    expect(numbers(malformed)).toEqual([1]);
    expect(malformed).toMatchObject({ truncated: true, error: "Unexpected response from GitHub" });
  });

  it("returns the error with no items when the first page fails", async () => {
    const result = await fetchInboxPages(pager({ first: new Error("") }).fetch, 4);
    expect(result).toEqual({ items: [], truncated: false, error: "GitHub CLI error" });
  });
});

describe("combineInboxQueries", () => {
  const ok = { items: [], truncated: false, error: null };

  it("reports a partial failure when other pages still returned items", async () => {
    const partial = await fetchInboxPages(pager({ first: page([1], "c1"), c1: new Error("gh: HTTP 502") }).fetch, 4);
    const combined = combineInboxQueries([partial, ok]);
    expect(combined.error).toBe("Some results failed: gh: HTTP 502");
    expect(combined.truncated).toBe(true);
    expect(combined.items.flat()).toHaveLength(1);
  });

  it("reports the plain error when nothing was fetched", () => {
    expect(combineInboxQueries([{ items: [], truncated: false, error: "Bad credentials" }, ok]).error).toBe("Bad credentials");
    expect(combineInboxQueries([ok, ok]).error).toBeNull();
  });
});
