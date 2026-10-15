import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cw-code/contracts";

const account = vi.hoisted(() => ({ login: "octocat" }));

vi.mock("./githubAccount.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./githubAccount.js")>()),
  resolveGitHubAccount: async () => ({ account: { host: "github.com", login: account.login }, token: "not-a-real-token" })
}));

import { RunsService, type GhExec } from "./RunsService.js";

const settings = (() => ({})) as unknown as () => AppSettings;
const SOURCES = { prSearchQuery: null, repos: [{ host: "github.com", owner: "acme", repo: "widgets" }], orgs: [] };

function payload(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    data: {
      r0: {
        nameWithOwner: "acme/widgets",
        defaultBranchRef: {
          name: "main",
          target: {
            oid: "abc",
            messageHeadline: "Merge",
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  branch: { name: "main" },
                  workflowRun: { databaseId: 9, runNumber: 1, event: "push", url: "https://github.com/acme/widgets/actions/runs/9", workflow: { name: "CI" } },
                  checkRuns: { nodes: [] }
                }
              ]
            }
          }
        }
      }
    },
    ...extra
  });
}

describe("RunsService", () => {
  beforeEach(() => {
    account.login = "octocat";
  });

  it("caches successful results per account and sources", async () => {
    const exec = vi.fn<GhExec>(async () => ({ code: 0, stdout: payload(), stderr: "" }));
    const service = new RunsService(settings, exec);
    const first = await service.runs(SOURCES);
    await service.runs(SOURCES);
    expect(first.error).toBeNull();
    expect(first.items.map((run) => run.ref.runId)).toEqual([9]);
    expect(exec).toHaveBeenCalledTimes(1);

    account.login = "someone-else";
    await service.runs(SOURCES);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("keeps items but reports partial GraphQL errors without caching them", async () => {
    const exec = vi.fn<GhExec>(async () => ({ code: 1, stdout: payload({ errors: [{ message: "Could not resolve to a Repository" }] }), stderr: "" }));
    const service = new RunsService(settings, exec);
    const result = await service.runs(SOURCES);
    expect(result.items).toHaveLength(1);
    expect(result.error).toBe("Some sources failed: Could not resolve to a Repository");
    await service.runs(SOURCES);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("returns the failure when GitHub sends no data and does not cache it", async () => {
    const exec = vi.fn<GhExec>(async () => ({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" }));
    const service = new RunsService(settings, exec);
    const result = await service.runs(SOURCES);
    expect(result).toMatchObject({ items: [], error: "HTTP 401: Bad credentials" });
    await service.runs(SOURCES);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid sources before calling gh", async () => {
    const exec = vi.fn<GhExec>();
    const service = new RunsService(settings, exec);
    await expect(service.runs({ prSearchQuery: null, repos: [{ host: "github.com", owner: "a/b", repo: "x" }], orgs: [] })).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});
