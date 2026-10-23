import { describe, expect, it } from "bun:test";
import { mapRestRun, newCiActivity, parseRunSuites } from "./runParsers.js";

function suite(runId: number | null, overrides: Record<string, unknown> = {}) {
  return {
    status: "COMPLETED",
    conclusion: "FAILURE",
    createdAt: "2024-03-01T10:00:00Z",
    updatedAt: "2024-03-01T10:05:00Z",
    branch: { name: "feature" },
    creator: { login: "octocat" },
    app: { slug: "github-actions" },
    workflowRun:
      runId === null
        ? null
        : {
            databaseId: runId,
            runNumber: 7,
            event: "push",
            url: `https://github.com/acme/widgets/actions/runs/${runId}`,
            createdAt: "2024-03-01T10:00:01Z",
            updatedAt: "2024-03-01T10:04:00Z",
            workflow: { name: "CI" }
          },
    checkRuns: {
      nodes: [
        {
          name: "build",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          startedAt: "2024-03-01T10:00:10Z",
          completedAt: "2024-03-01T10:01:10Z",
          detailsUrl: "https://github.com/acme/widgets/actions/runs/1/job/9"
        },
        { name: "test", status: "IN_PROGRESS", conclusion: null, startedAt: "2024-03-01T10:01:00Z", completedAt: null, detailsUrl: null }
      ]
    },
    ...overrides
  };
}

function prNode(number: number, suites: unknown[]) {
  return {
    __typename: "PullRequest",
    number,
    title: `PR ${number}`,
    repository: { nameWithOwner: "acme/widgets" },
    commits: { nodes: [{ commit: { oid: "abc123", checkSuites: { nodes: suites } } }] }
  };
}

function defaultBranch(nameWithOwner: string, suites: unknown[]) {
  return {
    nameWithOwner,
    defaultBranchRef: { name: "main", target: { oid: "def456", messageHeadline: "Merge things", checkSuites: { nodes: suites } } }
  };
}

describe("parseRunSuites", () => {
  it("maps a PR source with PR title, number, jobs and lower-cased enums", () => {
    const json = JSON.stringify({ data: { viewer: { login: "octocat" }, search: { nodes: [prNode(12, [suite(100)])] } } });
    const [run] = parseRunSuites(json);
    expect(run).toMatchObject({
      ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 100 },
      url: "https://github.com/acme/widgets/actions/runs/100",
      workflowName: "CI",
      runNumber: 7,
      event: "push",
      branch: "feature",
      headSha: "abc123",
      title: "PR 12",
      actor: "octocat",
      status: "completed",
      conclusion: "failure",
      prNumber: 12,
      onDefaultBranch: false
    });
    expect(run.createdAt).toBe(Date.parse("2024-03-01T10:00:01Z"));
    expect(run.updatedAt).toBe(Date.parse("2024-03-01T10:04:00Z"));
    expect(run.jobs).toEqual([
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        startedAt: Date.parse("2024-03-01T10:00:10Z"),
        completedAt: Date.parse("2024-03-01T10:01:10Z"),
        url: "https://github.com/acme/widgets/actions/runs/1/job/9"
      },
      { name: "test", status: "in_progress", conclusion: null, startedAt: Date.parse("2024-03-01T10:01:00Z"), completedAt: null, url: null }
    ]);
  });

  it("maps a default-branch source with the commit headline and no PR number", () => {
    const scheduled = suite(200, { status: "QUEUED", conclusion: null, branch: { name: "main" }, workflowRun: { ...suite(200).workflowRun, event: "schedule" } });
    const [run] = parseRunSuites(JSON.stringify({ data: { r0: defaultBranch("acme/widgets", [scheduled]) } }));
    expect(run).toMatchObject({
      ref: { owner: "acme", repo: "widgets", runId: 200 },
      title: "Merge things",
      headSha: "def456",
      prNumber: null,
      onDefaultBranch: true,
      status: "queued",
      conclusion: null,
      event: "schedule"
    });
  });

  it("maps an org source across its repositories", () => {
    const json = JSON.stringify({
      data: {
        o0: {
          repositories: {
            nodes: [defaultBranch("acme/widgets", [suite(300, { branch: { name: "main" } })]),
              defaultBranch("acme/gadgets", [suite(301, { status: "IN_PROGRESS", conclusion: null, branch: { name: "main" } })])]
          }
        }
      }
    });
    const runs = parseRunSuites(json);
    expect(runs.map((run) => `${run.ref.owner}/${run.ref.repo}#${run.ref.runId}`)).toEqual(["acme/widgets#300", "acme/gadgets#301"]);
    expect(runs[1].status).toBe("in_progress");
    expect(runs.every((run) => run.onDefaultBranch)).toBe(true);
  });

  it("flags onDefaultBranch only for suites on the default branch itself", () => {
    const json = JSON.stringify({
      data: { r0: defaultBranch("acme/widgets", [suite(700, { branch: { name: "main" } }), suite(701, { branch: { name: "feature" } }), suite(702, { branch: null })]) }
    });
    expect(parseRunSuites(json).map((run) => [run.ref.runId, run.onDefaultBranch])).toEqual([
      [700, true],
      [701, false],
      [702, false]
    ]);
  });

  it("suffixes a Bot creator with [bot]", () => {
    const json = JSON.stringify({ data: { search: { nodes: [prNode(3, [suite(800, { creator: { login: "dependabot", __typename: "Bot" } })])] } } });
    expect(parseRunSuites(json)[0].actor).toBe("dependabot[bot]");
  });

  it("drops suites without a workflow run", () => {
    const json = JSON.stringify({ data: { search: { nodes: [prNode(1, [suite(null), suite(400)])] } } });
    expect(parseRunSuites(json).map((run) => run.ref.runId)).toEqual([400]);
  });

  it("dedupes by run id and keeps the PR source over the default branch", () => {
    const json = JSON.stringify({ data: { search: { nodes: [prNode(5, [suite(500)])] }, r0: defaultBranch("acme/widgets", [suite(500), suite(501)]) } });
    const runs = parseRunSuites(json);
    expect(runs.map((run) => run.ref.runId)).toEqual([500, 501]);
    expect(runs[0].prNumber).toBe(5);
  });

  it("maps pending-like statuses to queued and unknown conclusions to null", () => {
    const json = JSON.stringify({
      data: {
        r0: defaultBranch("acme/widgets", [
          suite(600, { status: "WAITING", conclusion: null }),
          suite(601, { conclusion: "WEIRD" }),
          suite(602, { conclusion: "TIMED_OUT" })
        ])
      }
    });
    expect(parseRunSuites(json).map((run) => [run.status, run.conclusion])).toEqual([
      ["queued", null],
      ["completed", null],
      ["completed", "timed_out"]
    ]);
  });

  it("tolerates null aliases and malformed payloads", () => {
    expect(parseRunSuites(JSON.stringify({ data: { r0: null, o0: null, search: null } }))).toEqual([]);
    expect(parseRunSuites("not json")).toEqual([]);
    expect(parseRunSuites("[]")).toEqual([]);
  });
});

describe("mapRestRun", () => {
  const restRun = {
    id: 1234,
    run_number: 42,
    name: "CI",
    display_title: "Fix flaky test",
    event: "pull_request",
    status: "in_progress",
    conclusion: null,
    head_branch: "fix/flaky",
    head_sha: "cafebabe",
    html_url: "https://github.com/acme/widgets/actions/runs/1234",
    actor: { login: "octocat" },
    created_at: "2024-03-01T10:00:00Z",
    updated_at: "2024-03-01T10:02:00Z",
    pull_requests: [{ number: 9 }]
  };

  it("maps an in-progress run with its jobs", () => {
    const jobs = {
      jobs: [
        {
          name: "build",
          status: "completed",
          conclusion: "success",
          started_at: "2024-03-01T10:00:05Z",
          completed_at: "2024-03-01T10:01:00Z",
          html_url: "https://github.com/acme/widgets/actions/runs/1234/job/1"
        },
        {
          name: "test",
          status: "in_progress",
          conclusion: null,
          started_at: "2024-03-01T10:01:00Z",
          completed_at: null,
          html_url: "https://github.com/acme/widgets/actions/runs/1234/job/2"
        }
      ]
    };
    expect(mapRestRun(restRun, jobs)).toEqual({
      ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 1234 },
      url: "https://github.com/acme/widgets/actions/runs/1234",
      workflowName: "CI",
      runNumber: 42,
      event: "pull_request",
      branch: "fix/flaky",
      headSha: "cafebabe",
      title: "Fix flaky test",
      actor: "octocat",
      status: "in_progress",
      conclusion: null,
      prNumber: 9,
      onDefaultBranch: false,
      createdAt: Date.parse("2024-03-01T10:00:00Z"),
      updatedAt: Date.parse("2024-03-01T10:02:00Z"),
      jobs: [
        {
          name: "build",
          status: "completed",
          conclusion: "success",
          startedAt: Date.parse("2024-03-01T10:00:05Z"),
          completedAt: Date.parse("2024-03-01T10:01:00Z"),
          url: "https://github.com/acme/widgets/actions/runs/1234/job/1"
        },
        {
          name: "test",
          status: "in_progress",
          conclusion: null,
          startedAt: Date.parse("2024-03-01T10:01:00Z"),
          completedAt: null,
          url: "https://github.com/acme/widgets/actions/runs/1234/job/2"
        }
      ]
    });
  });

  it("maps a completed failure with no PR and no jobs payload", () => {
    const run = mapRestRun({ ...restRun, status: "completed", conclusion: "failure", pull_requests: [], display_title: "" }, null);
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", prNumber: null, title: "CI", jobs: [] });
  });

  it("suffixes a Bot actor with [bot] once", () => {
    expect(mapRestRun({ ...restRun, actor: { login: "dependabot", type: "Bot" } }, null)?.actor).toBe("dependabot[bot]");
    expect(mapRestRun({ ...restRun, actor: { login: "dependabot[bot]", type: "Bot" } }, null)?.actor).toBe("dependabot[bot]");
    expect(mapRestRun({ ...restRun, actor: { login: "octocat", type: "User" } }, null)?.actor).toBe("octocat");
  });

  it("returns null for payloads without an id or a run url", () => {
    expect(mapRestRun({ ...restRun, id: undefined }, null)).toBeNull();
    expect(mapRestRun({ ...restRun, html_url: "nope" }, null)).toBeNull();
    expect(mapRestRun("garbage", null)).toBeNull();
  });
});

describe("newCiActivity", () => {
  const since = Date.parse("2024-03-01T10:00:00Z");

  it("finds ci_activity notifications newer than since and reports the latest", () => {
    const result = newCiActivity(
      [
        { reason: "mention", updated_at: "2024-03-01T12:00:00Z" },
        { reason: "ci_activity", updated_at: "2024-03-01T10:30:00Z" },
        { reason: "ci_activity", updated_at: "2024-03-01T11:00:00Z" },
        { reason: "ci_activity", updated_at: "2024-03-01T09:00:00Z" }
      ],
      since
    );
    expect(result).toEqual({ found: true, latest: Date.parse("2024-03-01T11:00:00Z") });
  });

  it("reports nothing when no ci_activity is newer", () => {
    expect(newCiActivity([{ reason: "ci_activity", updated_at: "2024-03-01T09:00:00Z" }], since)).toEqual({ found: false, latest: since });
    expect(newCiActivity([], since)).toEqual({ found: false, latest: since });
    expect(newCiActivity({ message: "oops" }, since)).toEqual({ found: false, latest: since });
  });
});
