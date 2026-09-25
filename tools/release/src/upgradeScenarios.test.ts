import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUpdateInfo } from "./updateInfoYaml.ts";
import {
  type AutotestEvent,
  type ScenarioObservation,
  type UpgradeScenario,
  UPDATE_AUTOTEST_HANDOFF_FILE,
  UPGRADE_SCENARIOS,
  classifyTransfer,
  compareMetadata,
  deriveUpdateTestVersions,
  evaluateScenario,
  fabricateManifest,
  installerFileName,
  observedOutcome,
  parseAutotestLog,
  projectMetadata,
  redactText,
  redactValue,
  requiredBuilds,
  selectScenarios,
  splitRuns
} from "./upgradeScenarios.ts";
import { compareVersions, parseVersion } from "./semver.ts";

const versions = deriveUpdateTestVersions("0.0.1-alpha.21");

function byId(id: string): UpgradeScenario {
  const found = UPGRADE_SCENARIOS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
}

const HOME = "C:\\work\\n-to-n1\\cw-code-home";
const USER_DATA = "C:\\Users\\runner\\AppData\\Roaming\\@cw-code\\desktop-updatetest";

function event(name: string, data: Record<string, unknown> = {}): AutotestEvent {
  const identity = name === "started" ? { cwCodeHome: HOME, userDataDir: USER_DATA } : {};
  return { at: "2026-09-25T00:00:00.000Z", event: name, ...identity, ...data };
}

function observation(overrides: Partial<ScenarioObservation> = {}): ScenarioObservation {
  return {
    events: [event("started", { version: versions.n, pid: 1 }), event("installing")],
    relaunchEvents: [
      event("started", { version: versions.n1, pid: 2 }),
      event("relaunched", { version: versions.n1, startupMode: "ready", launchedByInstaller: true }),
      event("result", { outcome: "relaunched", state: { phase: "up-to-date" } })
    ],
    displayVersionAfter: versions.n1,
    installLocationBefore: "C:\\Programs\\cw-code-updatetest",
    installLocationAfter: "C:\\Programs\\cw-code-updatetest",
    advertisedInstaller: installerFileName(versions.n1),
    advertisedInstallerSize: 1000,
    transfers: [{ path: installerFileName(versions.n1), requests: 3, rangeRequests: 3, bytes: 120, statuses: [206] }],
    metadataProblems: [],
    fakeCli: null,
    recoveryEvents: null,
    expectedCwCodeHome: HOME,
    expectedUserDataDir: USER_DATA,
    ...overrides
  };
}

describe("deriveUpdateTestVersions", () => {
  it("derives strictly increasing cw-code release versions from the desktop version", () => {
    expect(versions).toEqual({
      previous: "0.0.1-alpha.9000",
      n: "0.0.1-alpha.9001",
      n1: "0.0.1-alpha.9002",
      n2: "0.0.1-alpha.9003",
      stable1: "0.0.2",
      stable2: "0.0.3",
      alphaAfterStable: "0.0.4-alpha.1"
    });
    const ordered = [versions.previous, versions.n, versions.n1, versions.n2, versions.stable1, versions.stable2, versions.alphaAfterStable];
    for (let index = 1; index < ordered.length; index++) expect(compareVersions(parseVersion(ordered[index - 1]), parseVersion(ordered[index]))).toBeLessThan(0);
  });

  it("works from a stable desktop version too", () => {
    expect(deriveUpdateTestVersions("1.4.0")).toMatchObject({ n: "1.4.0-alpha.9001", stable1: "1.4.1" });
  });
});

describe("scenario matrix", () => {
  it("has unique ids and covers every checklist area", () => {
    const ids = UPGRADE_SCENARIOS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "n-to-n1",
        "skip-n-to-n2",
        "busy-turn",
        "cancel-restart",
        "alpha-offered-stable",
        "stable-not-offered-alpha",
        "no-downgrade",
        "feed-unavailable",
        "missing-manifest",
        "stale-manifest",
        "truncated-download",
        "corrupted-checksum",
        "installer-removed",
        "installer-denied",
        "differential-n1-n2",
        "differential-fallback",
        "custom-dir",
        "per-machine"
      ])
    );
  });

  it("only expects a new version when an install scenario can reach it", () => {
    for (const entry of UPGRADE_SCENARIOS) {
      if (entry.expect.outcome === "relaunched") {
        expect(entry.mode).toBe("install");
        expect(entry.expect.finalVersion).toBe(entry.feed.release);
      } else {
        expect(entry.expect.finalVersion).toBe(entry.install);
      }
    }
  });

  it("selects by id or group and skips elevated scenarios without elevation", () => {
    expect(selectScenarios(["n-to-n1", "transfer"], { elevated: false }).selected.map((entry) => entry.id)).toEqual([
      "n-to-n1",
      "differential-n1-n2",
      "differential-fallback"
    ]);
    const scope = selectScenarios(["scope"], { elevated: false });
    expect(scope.selected.map((entry) => entry.id)).toEqual(["custom-dir"]);
    expect(scope.skipped).toEqual([{ id: "per-machine", reason: "needs an elevated session" }]);
    expect(selectScenarios(["scope"], { elevated: true }).selected.map((entry) => entry.id)).toEqual(["custom-dir", "per-machine"]);
    expect(() => selectScenarios(["nope"], { elevated: true })).toThrow(/unknown scenario/);
  });

  it("lists the builds a selection needs", () => {
    expect(requiredBuilds([byId("n-to-n1")])).toEqual(["n", "n1"]);
    expect(requiredBuilds([byId("stable-not-offered-alpha")])).toEqual(["stable1", "stable2"]);
    expect(requiredBuilds(UPGRADE_SCENARIOS)).toEqual(["n", "n1", "n2", "stable1", "stable2"]);
  });
});

describe("fabricateManifest", () => {
  it("produces update info the release tools parse", () => {
    const text = fabricateManifest(versions.previous, { name: installerFileName(versions.n), sha512: "abc==", size: 42 });
    expect(parseUpdateInfo(text)).toEqual({
      version: versions.previous,
      path: installerFileName(versions.n),
      sha512: "abc==",
      files: [{ url: installerFileName(versions.n), sha512: "abc==", size: 42 }]
    });
  });
});

describe("autotest log helpers", () => {
  it("parses JSON lines, skipping blanks and partial lines", () => {
    const text = `${JSON.stringify(event("started"))}\n\n{"event": "trunc\n${JSON.stringify(event("result", { outcome: "ready" }))}\r\n`;
    expect(parseAutotestLog(text).map((entry) => entry.event)).toEqual(["started", "result"]);
  });

  it("splits the log into one run per started event", () => {
    const runs = splitRuns([event("started", { pid: 1 }), event("installing"), event("started", { pid: 2 }), event("relaunched")]);
    expect(runs.map((run) => run.map((entry) => entry.event))).toEqual([["started", "installing"], ["started", "relaunched"]]);
  });

  it("derives the outcome from the relaunch, the last result or a silent exit after installing", () => {
    expect(observedOutcome(observation())).toBe("relaunched");
    expect(observedOutcome({ events: [event("started"), event("result", { outcome: "up-to-date" })], relaunchEvents: [] })).toBe("up-to-date");
    expect(observedOutcome({ events: [event("started"), event("installing")], relaunchEvents: [] })).toBe("installer-did-not-start");
    expect(observedOutcome({ events: [event("started")], relaunchEvents: [] })).toBeNull();
  });
});

describe("classifyTransfer", () => {
  const name = "setup.exe";
  it("distinguishes no download, a differential download and a full download", () => {
    expect(classifyTransfer([], name, 100)).toBe("none");
    expect(classifyTransfer([{ path: name, requests: 1, rangeRequests: 1, bytes: 40, statuses: [206] }], name, 100)).toBe("differential");
    expect(classifyTransfer([{ path: name, requests: 1, rangeRequests: 0, bytes: 100, statuses: [200] }], name, 100)).toBe("full");
    expect(
      classifyTransfer(
        [
          { path: name, requests: 2, rangeRequests: 2, bytes: 30, statuses: [206] },
          { path: "other.exe", requests: 1, rangeRequests: 0, bytes: 100, statuses: [200] }
        ],
        name,
        100
      )
    ).toBe("differential");
    expect(classifyTransfer([{ path: name, requests: 1, rangeRequests: 0, bytes: 130, statuses: [206, 200] }], name, 100)).toBe("full");
  });
});

describe("evaluateScenario", () => {
  it("accepts a clean N to N+1 update", () => {
    expect(evaluateScenario(byId("n-to-n1"), versions, observation())).toEqual([]);
  });

  it("does not trust a process exit or installer exit code alone", () => {
    const problems = evaluateScenario(byId("n-to-n1"), versions, observation({ relaunchEvents: [], displayVersionAfter: versions.n }));
    expect(problems).toEqual(
      expect.arrayContaining([
        "outcome was installer-did-not-start, expected relaunched",
        `registry DisplayVersion is ${versions.n}, expected ${versions.n1}`,
        `relaunched as nothing, expected ${versions.n1}`
      ])
    );
  });

  it("flags a moved install, a recovery-mode relaunch, a full download and metadata problems", () => {
    const problems = evaluateScenario(
      byId("n-to-n1"),
      versions,
      observation({
        installLocationAfter: "C:\\Elsewhere",
        relaunchEvents: [event("started", { version: versions.n1, pid: 2 }), event("relaunched", { version: versions.n1, startupMode: "recovery", launchedByInstaller: true })],
        transfers: [{ path: installerFileName(versions.n1), requests: 1, rangeRequests: 0, bytes: 1000, statuses: [200] }],
        metadataProblems: ["session sess_fx000001 is missing after the update"]
      })
    );
    expect(problems).toEqual([
      "InstallLocation changed from C:\\Programs\\cw-code-updatetest to C:\\Elsewhere",
      "relaunched app started in recovery mode",
      "installer transfer was full, expected differential",
      "session sess_fx000001 is missing after the update"
    ]);
  });

  it("checks the error context and retry flag of failure scenarios and that nothing relaunched", () => {
    const failed = observation({
      events: [event("started", { version: versions.n }), event("result", { outcome: "download-failed", state: { error: { context: "download", retryable: false } } })],
      relaunchEvents: [],
      displayVersionAfter: versions.n
    });
    expect(evaluateScenario(byId("corrupted-checksum"), versions, failed)).toEqual(["the error is not marked retryable, so the UI offers no Retry"]);
    expect(evaluateScenario(byId("feed-unavailable"), versions, failed)).toEqual(
      expect.arrayContaining(["outcome was download-failed, expected check-failed", "error context was download, expected check"])
    );
  });

  it("requires the busy turn to be stopped exactly once", () => {
    const busy = observation({
      events: [event("started", { version: versions.n }), event("assessment", { activeTurns: [{ sessionId: "s", turnId: "t" }] }), event("installing")],
      fakeCli: { turnStarts: 2, stillRunning: [4242] }
    });
    expect(evaluateScenario(byId("busy-turn"), versions, busy)).toEqual([
      "the fake CLI saw 2 turn starts, expected exactly 1 (no resend)",
      "fake CLI processes still running: 4242"
    ]);
  });

  it("requires N to offer the update again after an installer that could not start", () => {
    const base = observation({ relaunchEvents: [], displayVersionAfter: versions.n });
    expect(evaluateScenario(byId("installer-denied"), versions, base)).toEqual(["N was not relaunched to confirm it still works"]);
    const recovered = { ...base, recoveryEvents: [event("started"), event("result", { outcome: "available" })] };
    expect(evaluateScenario(byId("installer-denied"), versions, recovered)).toEqual([]);
  });

  it("expects the in-app pre-check to send N back to available when the cached installer is gone", () => {
    const refused = observation({
      events: [
        event("started", { version: versions.n, pid: 1 }),
        event("installing"),
        event("result", {
          outcome: "install-failed",
          coordinatorIdle: true,
          state: { phase: "available", availableVersion: versions.n1, downloadedVersion: null, error: { context: "download", retryable: true } }
        })
      ],
      relaunchEvents: [],
      displayVersionAfter: versions.n
    });
    expect(evaluateScenario(byId("installer-removed"), versions, refused)).toEqual([]);
    const held = { ...refused, events: refused.events.map((entry) => (entry.event === "result" ? { ...entry, coordinatorIdle: false } : entry)) };
    expect(evaluateScenario(byId("installer-removed"), versions, held)).toEqual(["the shutdown coordinator still holds a reservation after the run"]);
  });

  it("requires a cancelled restart to keep the download ready and release the coordinator", () => {
    const cancelled = observation({
      events: [event("started", { version: versions.n, pid: 1 }), event("result", { outcome: "cancelled", coordinatorIdle: true, state: { phase: "ready", downloadedVersion: versions.n1 } })],
      relaunchEvents: [],
      displayVersionAfter: versions.n
    });
    expect(evaluateScenario(byId("cancel-restart"), versions, cancelled)).toEqual([]);
    const lost = { ...cancelled, events: [cancelled.events[0], event("result", { outcome: "cancelled", coordinatorIdle: false, state: { phase: "available", downloadedVersion: null } })] };
    expect(evaluateScenario(byId("cancel-restart"), versions, lost)).toEqual([
      "final phase was available, expected ready",
      `downloaded version was none, expected ${versions.n1}`,
      "the shutdown coordinator still holds a reservation after the run"
    ]);
  });

  it("proves the relaunch with a new pid, the installer flag and the isolated identity", () => {
    const suspicious = observation({
      relaunchEvents: [
        event("started", { version: versions.n1, pid: 1, cwCodeHome: "C:\\Users\\runner\\.cw-code" }),
        event("relaunched", { version: versions.n1, startupMode: "ready", launchedByInstaller: false }),
        event("result", { outcome: "relaunched", state: { phase: "up-to-date" } })
      ]
    });
    expect(evaluateScenario(byId("n-to-n1"), versions, suspicious)).toEqual([
      "the relaunched app was not started by the installer (no --updated)",
      "the relaunched app reports the same pid 1 as N",
      `the relaunched app used CW_CODE_HOME C:\\Users\\runner\\.cw-code, expected ${HOME}`
    ]);
    const wrongUserData = observation({ events: [event("started", { version: versions.n, pid: 1, userDataDir: "C:\\Users\\runner\\AppData\\Roaming\\@cw-code\\desktop" }), event("installing")] });
    expect(evaluateScenario(byId("n-to-n1"), versions, wrongUserData)).toEqual([
      `the installed app used userData C:\\Users\\runner\\AppData\\Roaming\\@cw-code\\desktop, expected ${USER_DATA}`
    ]);
  });

  it("checks the offered version for channel scenarios", () => {
    const offered = observation({
      events: [event("started", { version: versions.n }), event("result", { outcome: "available", state: { availableVersion: versions.stable2 } })],
      relaunchEvents: [],
      displayVersionAfter: versions.n,
      transfers: []
    });
    expect(evaluateScenario(byId("alpha-offered-stable"), versions, { ...offered, advertisedInstaller: installerFileName(versions.stable2) })).toEqual([]);
  });
});

describe("metadata projection", () => {
  const sessions = {
    projects: [{ id: "p1", rootPath: "C:\\work\\alpha\\" }, { id: "p2", rootPath: "/home/beta" }],
    sessions: [{ id: "s1", projectId: "p1", driver: "claude", resumeCursor: "cursor-1", worktreePath: "C:\\wt\\s1", branch: "cw/x", status: "working" }]
  };
  const settings = { claudeBinaryPath: "claude-fixture", unknownKey: { nested: true }, holdingHours: 12 };

  it("keeps identity fields and normalizes trailing separators", () => {
    expect(projectMetadata(sessions, settings, ["claudeBinaryPath", "unknownKey"])).toEqual({
      projects: [
        { id: "p1", rootPath: "C:\\work\\alpha" },
        { id: "p2", rootPath: "/home/beta" }
      ],
      sessions: [{ id: "s1", projectId: "p1", driver: "claude", resumeCursor: "cursor-1", worktreePath: "C:\\wt\\s1", branch: "cw/x" }],
      settings: { claudeBinaryPath: "claude-fixture", unknownKey: { nested: true } }
    });
  });

  it("reports lost records, changed cursors, roots and settings", () => {
    const before = projectMetadata(sessions, settings, ["claudeBinaryPath", "unknownKey"]);
    const after = projectMetadata(
      { projects: [{ id: "p1", rootPath: "C:\\moved" }], sessions: [{ ...sessions.sessions[0], resumeCursor: "cursor-2" }] },
      { claudeBinaryPath: "claude-fixture" },
      ["claudeBinaryPath", "unknownKey"]
    );
    expect(compareMetadata(before, after)).toEqual([
      "project p1 root changed from C:\\work\\alpha to C:\\moved",
      "project p2 is missing after the update",
      "session s1 resumeCursor changed from cursor-1 to cursor-2",
      "setting unknownKey changed after the update"
    ]);
    expect(compareMetadata(before, before)).toEqual([]);
  });

  it("tolerates documents with unexpected shapes", () => {
    expect(projectMetadata(null, "x", ["a"])).toEqual({ projects: [], sessions: [], settings: { a: undefined } });
  });
});

describe("evidence redaction", () => {
  it("replaces known roots in either slash style, user names and tokens", () => {
    const replacements = [
      ["C:\\runner\\work\\upgrade", "<work>"],
      ["C:\\runner\\work", "<repo>"]
    ] as const;
    expect(redactText("C:\\runner\\work\\upgrade\\n-to-n1\\out.jsonl and c:/runner/work/apps", replacements)).toBe("<work>\\n-to-n1\\out.jsonl and <repo>/apps");
    expect(redactText("C:\\Users\\alice\\AppData and D:/Users/bob/x", [])).toBe("C:\\Users\\<user>\\AppData and D:/Users/<user>/x");
    expect(redactText("token ghp_abcdef123", [])).toBe("token ghp_<redacted>");
  });

  it("walks nested values and drops sensitive keys", () => {
    expect(redactValue({ path: "C:\\Users\\alice\\x", env: { A: "1" }, list: ["C:\\Users\\bob"], count: 3 }, [])).toEqual({
      path: "C:\\Users\\<user>\\x",
      list: ["C:\\Users\\<user>"],
      count: 3
    });
  });
});

describe("contract with the desktop autotest module", () => {
  it("shares the relaunch handoff file name and the bundle marker", () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/desktop/src/main/updates/updateAutotest.ts"), "utf8");
    expect(source).toContain(`UPDATE_AUTOTEST_HANDOFF_FILE = "${UPDATE_AUTOTEST_HANDOFF_FILE}"`);
    expect(source).toContain('UPDATE_AUTOTEST_MARKER = "cw-update-autotest"');
  });
});