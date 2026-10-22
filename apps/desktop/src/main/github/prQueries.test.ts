import { describe, expect, it } from "vitest";
import { buildTrackedPrQuery } from "./prQueries.js";

const ref = (number: number, owner = "acme", repo = "widgets") => ({ host: "github.com", owner, repo, number });

describe("buildTrackedPrQuery", () => {
  it("builds one aliased repository selection per ref", () => {
    const query = buildTrackedPrQuery([ref(1), ref(22, "other", "gadgets")]);
    expect(query).toContain('pr0: repository(owner: "acme", name: "widgets")');
    expect(query).toContain("pullRequest(number: 1)");
    expect(query).toContain('pr1: repository(owner: "other", name: "gadgets")');
    expect(query).toContain("pullRequest(number: 22)");
    expect(query).not.toContain("pr2:");
  });

  it("spreads one shared summary fragment into every alias", () => {
    const query = buildTrackedPrQuery([ref(1), ref(2)]);
    expect(query.match(/\.\.\.PrSummaryFields/g)).toHaveLength(2);
    expect(query.match(/fragment PrSummaryFields on PullRequest/g)).toHaveLength(1);
    expect(query.match(/headRefOid/g)).toHaveLength(1);
    expect(query.match(/ciCommits: commits\(last: 1\)/g)).toHaveLength(1);
  });

  it("keeps a full batch of maximum-length names far below the Windows command-line limit", () => {
    const refs = Array.from({ length: 25 }, (_, index) => ref(100_000 + index, "o".repeat(39), "r".repeat(100)));
    expect(buildTrackedPrQuery(refs).length).toBeLessThan(12_000);
  });

  it("JSON-escapes owner and repo", () => {
    const query = buildTrackedPrQuery([ref(1, 'a"b', "c\\d")]);
    expect(query).toContain('owner: "a\\"b", name: "c\\\\d"');
  });

  it("rejects a non-integer number instead of interpolating it", () => {
    expect(() => buildTrackedPrQuery([ref(1.5)])).toThrow(/invalid pull request number/);
    expect(() => buildTrackedPrQuery([{ ...ref(1), number: "1) { id }" as unknown as number }])).toThrow(/invalid pull request number/);
  });
});
