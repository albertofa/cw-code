import { describe, expect, test } from "bun:test";
import { CommitPullsService, parseCommitPulls } from "./commitPulls.js";

const SHA = "a".repeat(40);

const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/o/r/pull/${number}`,
  state: "open",
  head: { ref: `feature-${number}` },
  base: { ref: "main" },
  ...extra
});

describe("parseCommitPulls", () => {
  test("maps states, drafts and merge time", () => {
    const [merged, open, closed] = parseCommitPulls(
      JSON.stringify([
        pull(3, { state: "closed" }),
        pull(2, { draft: true }),
        pull(1, { state: "closed", merged_at: "2024-01-02T03:04:05Z" })
      ]),
      "github.com",
      "o",
      "r"
    );
    expect(merged).toMatchObject({ state: "MERGED", mergedAt: Date.parse("2024-01-02T03:04:05Z"), isDraft: false, headRefName: "feature-1", baseRefName: "main" });
    expect(merged!.ref).toEqual({ host: "github.com", owner: "o", repo: "r", number: 1 });
    expect(open).toMatchObject({ state: "OPEN", isDraft: true, mergedAt: null });
    expect(closed).toMatchObject({ state: "CLOSED", mergedAt: null });
  });

  test("ranks merged, open, closed then number descending", () => {
    const list = parseCommitPulls(
      JSON.stringify([pull(1, { state: "closed" }), pull(5), pull(7), pull(2, { merged_at: "2024-01-01T00:00:00Z" }), pull(9, { merged_at: "2024-01-01T00:00:00Z" })]),
      "github.com",
      "o",
      "r"
    );
    expect(list.map((entry) => entry.ref.number)).toEqual([9, 2, 7, 5, 1]);
  });

  test("returns an empty list for malformed input", () => {
    expect(parseCommitPulls("not json", "github.com", "o", "r")).toEqual([]);
    expect(parseCommitPulls("{}", "github.com", "o", "r")).toEqual([]);
    expect(parseCommitPulls(JSON.stringify([null, 3, { number: "x" }, { number: 1 }]), "github.com", "o", "r")).toEqual([]);
  });
});

function setup(remote: { host: string; owner: string; repository: string } | null = { host: "GitHub.com", owner: "Owner", repository: "Repo" }) {
  const state = { now: 0, calls: 0, answer: (): Promise<string> => Promise.resolve(JSON.stringify([pull(1)])) };
  const service = new CommitPullsService({
    remote: async () => remote,
    lookup: () => {
      state.calls += 1;
      return state.answer();
    },
    now: () => state.now
  });
  return { state, service };
}

describe("CommitPullsService", () => {
  test("caches a result until the TTL expires", async () => {
    const { state, service } = setup();
    const first = await service.resolve("/r", SHA);
    expect(first.unavailable).toBeNull();
    expect(first.pulls[0]!.ref.host).toBe("github.com");
    await service.resolve("/r", SHA);
    expect(state.calls).toBe(1);
    state.now = 600_001;
    await service.resolve("/r", SHA);
    expect(state.calls).toBe(2);
  });

  test("caches a 404 as an empty list", async () => {
    const { state, service } = setup();
    state.answer = () => Promise.reject(new Error("gh: Not Found (HTTP 404)"));
    expect(await service.resolve("/r", SHA)).toEqual({ pulls: [], unavailable: null });
    await service.resolve("/r", SHA);
    expect(state.calls).toBe(1);
  });

  test("reports an auth error without caching it", async () => {
    const { state, service } = setup();
    state.answer = () => Promise.reject(new Error("HTTP 401: Bad credentials https://user:secret@github.com/x\nmore"));
    const result = await service.resolve("/r", SHA);
    expect(result.pulls).toEqual([]);
    expect(result.unavailable).toContain("Bad credentials");
    expect(result.unavailable).not.toContain("secret");
    expect(result.unavailable).not.toContain("more");
    await service.resolve("/r", SHA);
    expect(state.calls).toBe(2);
  });

  test("needs a github.com remote", async () => {
    const message = { pulls: [], unavailable: "PR lookup needs a GitHub remote" };
    expect(await setup(null).service.resolve("/r", SHA)).toEqual(message);
    const other = setup({ host: "gitlab.com", owner: "o", repository: "r" });
    expect(await other.service.resolve("/r", SHA)).toEqual(message);
    expect(other.state.calls).toBe(0);
  });
});
