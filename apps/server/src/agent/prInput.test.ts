import { describe, expect, it } from "bun:test";
import type { RepoRef, SessionPrLink } from "@cw-code/contracts";
import { findLinkIgnoringCase, resolvePrInput } from "./prInput.js";

const REMOTE: RepoRef = { host: "github.com", owner: "acme", repo: "widgets" };

function remoteOf(remote: RepoRef | null): { lookups: number; get: () => Promise<RepoRef | null> } {
  const state = {
    lookups: 0,
    get: async (): Promise<RepoRef | null> => {
      state.lookups += 1;
      return remote;
    }
  };
  return state;
}

describe("resolvePrInput", () => {
  it("reads a pull request URL without looking up the checkout remote", async () => {
    const remote = remoteOf(REMOTE);
    expect(await resolvePrInput(" https://github.com/Other/thing/pull/12/files ", remote.get)).toEqual({
      host: "github.com",
      owner: "Other",
      repo: "thing",
      number: 12
    });
    expect(remote.lookups).toBe(0);
  });

  it("resolves a bare or hash-prefixed number against the checkout remote", async () => {
    expect(await resolvePrInput("42", remoteOf(REMOTE).get)).toEqual({ ...REMOTE, number: 42 });
    expect(await resolvePrInput("#43", remoteOf(REMOTE).get)).toEqual({ ...REMOTE, number: 43 });
  });

  it("keeps the remote's host for owner/repo#n only when it names the checkout's repository", async () => {
    const enterprise: RepoRef = { host: "git.acme.dev", owner: "acme", repo: "widgets" };
    expect(await resolvePrInput("ACME/Widgets#5", remoteOf(enterprise).get)).toEqual({ host: "git.acme.dev", owner: "ACME", repo: "Widgets", number: 5 });
    expect(await resolvePrInput("other/repo#5", remoteOf(enterprise).get)).toEqual({ host: "github.com", owner: "other", repo: "repo", number: 5 });
    expect(await resolvePrInput("other/repo#5", remoteOf(null).get)).toEqual({ host: "github.com", owner: "other", repo: "repo", number: 5 });
  });

  it("asks for a URL when a bare number has no GitHub remote to resolve against", async () => {
    await expect(resolvePrInput("42", remoteOf(null).get)).rejects.toThrow("no GitHub remote; pass the pull request URL or owner/repo#42");
  });

  it("rejects text that is not a pull request reference", async () => {
    await expect(resolvePrInput("the last one", remoteOf(REMOTE).get)).rejects.toThrow("is not a pull request");
    await expect(resolvePrInput("https://github.com/acme/widgets/issues/3", remoteOf(REMOTE).get)).rejects.toThrow("is not a pull request");
  });

  it("rejects number zero", async () => {
    await expect(resolvePrInput("#0", remoteOf(REMOTE).get)).rejects.toThrow("invalid pull request number");
  });
});

describe("findLinkIgnoringCase", () => {
  const link: SessionPrLink = { ref: { host: "github.com", owner: "Acme", repo: "Widgets", number: 7 }, origin: "opened", lastSeenSha: "a", lastSeenAt: 1 };

  it("matches a link whose owner or repository differs only in case", () => {
    expect(findLinkIgnoringCase([link], { host: "github.com", owner: "acme", repo: "widgets", number: 7 })).toBe(link);
    expect(findLinkIgnoringCase([link], { host: "github.com", owner: "acme", repo: "widgets", number: 8 })).toBeUndefined();
    expect(findLinkIgnoringCase(undefined, link.ref)).toBeUndefined();
  });
});
