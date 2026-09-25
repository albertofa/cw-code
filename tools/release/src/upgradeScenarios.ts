import type { FeedTransferSummary } from "./feedServer.ts";
import { parseVersion } from "./semver.ts";

export type BuildKey = "n" | "n1" | "n2" | "stable1" | "stable2";
export type VersionKey = BuildKey | "previous" | "alphaAfterStable";
export type InstallScope = "per-user" | "per-machine" | "custom-dir";
export type AutotestMode = "install" | "check-only" | "download-only" | "cancel";
export type ScenarioGroup = "core" | "channels" | "faults" | "transfer" | "scope";
export type ScenarioOutcome =
  | "relaunched"
  | "up-to-date"
  | "available"
  | "ready"
  | "cancelled"
  | "check-failed"
  | "download-failed"
  | "install-failed"
  | "installer-did-not-start";
export type TransferKind = "none" | "differential" | "full";

export type UpdateTestVersions = Record<VersionKey, string>;

export interface RawFault {
  type: string;
  path: string;
  [key: string]: unknown;
}

export interface FabricatedManifest {
  channelFiles: string[];
  version: VersionKey;
  installer: BuildKey;
}

export interface ScenarioFeed {
  release: BuildKey | null;
  fabricated: FabricatedManifest | null;
  blockMaps: BuildKey[];
  staleManifestFrom: BuildKey | null;
  faults: RawFault[];
}

export interface ScenarioExpectation {
  outcome: ScenarioOutcome;
  finalVersion: BuildKey;
  errorContext: "check" | "download" | null;
  availableVersion: VersionKey | null;
  transfer: TransferKind | null;
  finalPhase: string | null;
  downloadedVersion: VersionKey | null;
  coordinatorIdle: boolean;
}

export interface UpgradeScenario {
  id: string;
  group: ScenarioGroup;
  title: string;
  install: BuildKey;
  scope: InstallScope;
  mode: AutotestMode;
  feed: ScenarioFeed;
  busyTurn: boolean;
  sabotage: "remove-installer" | "deny-installer" | null;
  requiresElevation: boolean;
  expect: ScenarioExpectation;
}

export interface ManualScenario {
  id: string;
  title: string;
}

export interface AutotestEvent {
  at: string;
  event: string;
  [key: string]: unknown;
}

export interface ScenarioObservation {
  events: AutotestEvent[];
  relaunchEvents: AutotestEvent[];
  displayVersionAfter: string | null;
  installLocationBefore: string | null;
  installLocationAfter: string | null;
  advertisedInstaller: string | null;
  advertisedInstallerSize: number | null;
  transfers: FeedTransferSummary[];
  metadataProblems: string[];
  fakeCli: { turnStarts: number; stillRunning: number[] } | null;
  recoveryEvents: AutotestEvent[] | null;
  expectedCwCodeHome: string;
  expectedUserDataDir: string;
}

export interface MetadataProjection {
  projects: Array<{ id: string; rootPath: string }>;
  sessions: Array<{ id: string; projectId: string; driver: string; resumeCursor: string | null; worktreePath: string | null; branch: string | null }>;
  settings: Record<string, unknown>;
}

export const UPDATE_TEST_APP_ID = "com.cwcode.app.updatetest";
export const UPDATE_TEST_PRODUCT_NAME = "cw-code-updatetest";
export const UPDATE_TEST_PACKAGE_NAME = "@cw-code/desktop-updatetest";
export const UPDATE_TEST_EXECUTABLE = "cw-code-updatetest.exe";
export const UPDATE_TEST_UNINSTALLER = "Uninstall cw-code-updatetest.exe";
export const UPDATE_AUTOTEST_HANDOFF_FILE = "cw-update-autotest-handoff.json";

const ALPHA_BASE = 9000;

export function deriveUpdateTestVersions(desktopVersion: string): UpdateTestVersions {
  const { major, minor, patch } = parseVersion(desktopVersion);
  const alpha = (number: number): string => `${major}.${minor}.${patch}-alpha.${number}`;
  const stable = (value: number): string => `${major}.${minor}.${value}`;
  return {
    previous: alpha(ALPHA_BASE),
    n: alpha(ALPHA_BASE + 1),
    n1: alpha(ALPHA_BASE + 2),
    n2: alpha(ALPHA_BASE + 3),
    stable1: stable(patch + 1),
    stable2: stable(patch + 2),
    alphaAfterStable: `${major}.${minor}.${patch + 3}-alpha.1`
  };
}

export const BUILD_KEYS: readonly BuildKey[] = ["n", "n1", "n2", "stable1", "stable2"];

export function installerFileName(version: string): string {
  return `${UPDATE_TEST_PRODUCT_NAME}-Setup-${version}-x64.exe`;
}

function feed(overrides: Partial<ScenarioFeed>): ScenarioFeed {
  return { release: null, fabricated: null, blockMaps: [], staleManifestFrom: null, faults: [], ...overrides };
}

function expectation(overrides: Partial<ScenarioExpectation> & Pick<ScenarioExpectation, "outcome" | "finalVersion">): ScenarioExpectation {
  return { errorContext: null, availableVersion: null, transfer: null, finalPhase: null, downloadedVersion: null, coordinatorIdle: false, ...overrides };
}

function scenario(
  overrides: Partial<UpgradeScenario> & Pick<UpgradeScenario, "id" | "group" | "title" | "install" | "mode" | "feed" | "expect">
): UpgradeScenario {
  return { scope: "per-user", busyTurn: false, sabotage: null, requiresElevation: false, ...overrides };
}

export const UPGRADE_SCENARIOS: readonly UpgradeScenario[] = [
  scenario({
    id: "n-to-n1",
    group: "core",
    title: "Installed N updates to N+1 with the real updater and relaunches",
    install: "n",
    mode: "install",
    feed: feed({ release: "n1", blockMaps: ["n"] }),
    expect: expectation({ outcome: "relaunched", finalVersion: "n1", transfer: "differential" })
  }),
  scenario({
    id: "skip-n-to-n2",
    group: "core",
    title: "Installed N skips N+1 and updates straight to N+2",
    install: "n",
    mode: "install",
    feed: feed({ release: "n2", blockMaps: ["n"] }),
    expect: expectation({ outcome: "relaunched", finalVersion: "n2" })
  }),
  scenario({
    id: "busy-turn",
    group: "core",
    title: "An active turn in an app-owned fake CLI is stopped by the coordinator and never resent",
    install: "n",
    mode: "install",
    busyTurn: true,
    feed: feed({ release: "n1", blockMaps: ["n"] }),
    expect: expectation({ outcome: "relaunched", finalVersion: "n1" })
  }),
  scenario({
    id: "cancel-restart",
    group: "core",
    title: "A prepared restart that is cancelled leaves N running with the update ready",
    install: "n",
    mode: "cancel",
    feed: feed({ release: "n1", blockMaps: ["n"] }),
    expect: expectation({ outcome: "cancelled", finalVersion: "n", finalPhase: "ready", downloadedVersion: "n1", coordinatorIdle: true })
  }),
  scenario({
    id: "stable-to-stable",
    group: "channels",
    title: "A stable client updates to the next stable release",
    install: "stable1",
    mode: "install",
    feed: feed({ release: "stable2", blockMaps: ["stable1"] }),
    expect: expectation({ outcome: "relaunched", finalVersion: "stable2" })
  }),
  scenario({
    id: "alpha-offered-stable",
    group: "channels",
    title: "An alpha client is offered a newer stable release",
    install: "n",
    mode: "check-only",
    feed: feed({ release: "stable2" }),
    expect: expectation({ outcome: "available", finalVersion: "n", availableVersion: "stable2", transfer: "none" })
  }),
  scenario({
    id: "stable-not-offered-alpha",
    group: "channels",
    title: "A stable client ignores a newer alpha even when latest.yml advertises it",
    install: "stable1",
    mode: "check-only",
    feed: feed({ fabricated: { channelFiles: ["latest.yml", "alpha.yml"], version: "alphaAfterStable", installer: "stable2" } }),
    expect: expectation({ outcome: "up-to-date", finalVersion: "stable1", transfer: "none" })
  }),
  scenario({
    id: "no-downgrade",
    group: "channels",
    title: "A feed that advertises an older version never downgrades N",
    install: "n",
    mode: "check-only",
    feed: feed({ fabricated: { channelFiles: ["alpha.yml"], version: "previous", installer: "n" } }),
    expect: expectation({ outcome: "up-to-date", finalVersion: "n", transfer: "none" })
  }),
  scenario({
    id: "feed-unavailable",
    group: "faults",
    title: "An unavailable feed leaves N installed with a retryable check error",
    install: "n",
    mode: "install",
    feed: feed({ release: "n1", faults: [{ type: "unavailable", path: "*.yml" }] }),
    expect: expectation({ outcome: "check-failed", finalVersion: "n", errorContext: "check", transfer: "none" })
  }),
  scenario({
    id: "missing-manifest",
    group: "faults",
    title: "A missing alpha.yml leaves N installed with a check error",
    install: "n",
    mode: "install",
    feed: feed({ release: "n1", faults: [{ type: "missing", path: "alpha.yml" }] }),
    expect: expectation({ outcome: "check-failed", finalVersion: "n", errorContext: "check", transfer: "none" })
  }),
  scenario({
    id: "stale-manifest",
    group: "faults",
    title: "A stale cached manifest that still advertises N reports up to date",
    install: "n",
    mode: "install",
    feed: feed({ release: "n1", staleManifestFrom: "n", faults: [{ type: "stale-manifest", path: "alpha.yml", serve: "stale/alpha.yml" }] }),
    expect: expectation({ outcome: "up-to-date", finalVersion: "n", transfer: "none" })
  }),
  scenario({
    id: "truncated-download",
    group: "faults",
    title: "A truncated installer download fails verification and N stays installed",
    install: "n",
    mode: "install",
    feed: feed({ release: "n1", faults: [{ type: "truncate", path: "*.exe", bytes: 4 * 1024 * 1024 }] }),
    expect: expectation({ outcome: "download-failed", finalVersion: "n", errorContext: "download" })
  }),
  scenario({
    id: "corrupted-checksum",
    group: "faults",
    title: "Corrupted installer bytes fail the sha512 check and N stays installed",
    install: "n",
    mode: "install",
    feed: feed({ release: "n1", faults: [{ type: "corrupt", path: "*.exe", offset: 1_048_576, length: 16 }] }),
    expect: expectation({ outcome: "download-failed", finalVersion: "n", errorContext: "download" })
  }),
  scenario({
    id: "installer-removed",
    group: "faults",
    title: "The downloaded installer disappears before Update and restart and the pre-check sends N back to available",
    install: "n",
    mode: "install",
    sabotage: "remove-installer",
    feed: feed({ release: "n1", blockMaps: ["n"] }),
    expect: expectation({
      outcome: "install-failed",
      finalVersion: "n",
      errorContext: "download",
      finalPhase: "available",
      availableVersion: "n1",
      coordinatorIdle: true
    })
  }),
  scenario({
    id: "installer-denied",
    group: "faults",
    title: "Execution of the downloaded installer is denied after the pre-check passed",
    install: "n",
    mode: "install",
    sabotage: "deny-installer",
    feed: feed({ release: "n1", blockMaps: ["n"] }),
    expect: expectation({ outcome: "installer-did-not-start", finalVersion: "n" })
  }),
  scenario({
    id: "differential-n1-n2",
    group: "transfer",
    title: "N+1 downloads N+2 differentially using both blockmaps",
    install: "n1",
    mode: "download-only",
    feed: feed({ release: "n2", blockMaps: ["n1"] }),
    expect: expectation({ outcome: "ready", finalVersion: "n1", transfer: "differential" })
  }),
  scenario({
    id: "differential-fallback",
    group: "transfer",
    title: "Without the old blockmap N+1 falls back to a full download of N+2",
    install: "n1",
    mode: "download-only",
    feed: feed({ release: "n2" }),
    expect: expectation({ outcome: "ready", finalVersion: "n1", transfer: "full" })
  }),
  scenario({
    id: "custom-dir",
    group: "scope",
    title: "An install in a custom directory is updated in place",
    install: "n",
    scope: "custom-dir",
    mode: "install",
    feed: feed({ release: "n1", blockMaps: ["n"] }),
    expect: expectation({ outcome: "relaunched", finalVersion: "n1" })
  }),
  scenario({
    id: "per-machine",
    group: "scope",
    title: "A per-machine install is updated in place by an elevated session",
    install: "n",
    scope: "per-machine",
    mode: "install",
    requiresElevation: true,
    feed: feed({ release: "n1", blockMaps: ["n"] }),
    expect: expectation({ outcome: "relaunched", finalVersion: "n1" })
  })
];

export const MANUAL_SCENARIOS: readonly ManualScenario[] = [
  { id: "per-machine-uac", title: "Per-machine install updated from a standard user session (UAC prompt)" },
  { id: "reboot-during-install", title: "Reboot while the NSIS installer is running" },
  { id: "shutdown-mid-install", title: "OS shutdown or sign-out in the middle of the install" },
  { id: "insufficient-disk", title: "Insufficient disk space for the download or the install" },
  { id: "dirty-buffers", title: "Update and restart with unsaved editor buffers and open terminals" },
  { id: "real-cli-smoke", title: "Real claude/opencode/codex smoke in an isolated project after the update" },
  { id: "legacy-identity", title: "Legacy com.cwcode.app install updated with production bytes" },
  { id: "signed-wrong-publisher", title: "Signed installer from a different publisher is rejected (controlled fixture, step 09)" }
];

export function selectScenarios(filter: readonly string[] | null, options: { elevated: boolean }): { selected: UpgradeScenario[]; skipped: Array<{ id: string; reason: string }> } {
  const known = new Set<string>([...UPGRADE_SCENARIOS.map((entry) => entry.id), ...UPGRADE_SCENARIOS.map((entry) => entry.group)]);
  for (const name of filter ?? []) {
    if (!known.has(name)) throw new Error(`unknown scenario or group "${name}"`);
  }
  const wanted = UPGRADE_SCENARIOS.filter((entry) => filter === null || filter.includes(entry.id) || filter.includes(entry.group));
  const selected: UpgradeScenario[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const entry of wanted) {
    if (entry.requiresElevation && !options.elevated) skipped.push({ id: entry.id, reason: "needs an elevated session" });
    else selected.push(entry);
  }
  return { selected, skipped };
}

export function requiredBuilds(scenarios: readonly UpgradeScenario[]): BuildKey[] {
  const needed = new Set<BuildKey>();
  for (const entry of scenarios) {
    needed.add(entry.install);
    if (entry.feed.release) needed.add(entry.feed.release);
    if (entry.feed.fabricated) needed.add(entry.feed.fabricated.installer);
    if (entry.feed.staleManifestFrom) needed.add(entry.feed.staleManifestFrom);
    for (const key of entry.feed.blockMaps) needed.add(key);
  }
  return BUILD_KEYS.filter((key) => needed.has(key));
}

export function fabricateManifest(version: string, installer: { name: string; sha512: string; size: number }): string {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${installer.name}`,
    `    sha512: ${installer.sha512}`,
    `    size: ${installer.size}`,
    `path: ${installer.name}`,
    `sha512: ${installer.sha512}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    ""
  ].join("\n");
}

export function classifyTransfer(transfers: readonly FeedTransferSummary[], installer: string | null, installerSize: number | null): TransferKind {
  if (installer === null) return "none";
  const bytes = transfers.filter((entry) => entry.path === installer).reduce((total, entry) => total + entry.bytes, 0);
  if (bytes === 0) return "none";
  if (installerSize !== null && bytes < installerSize) return "differential";
  return "full";
}

export function parseAutotestLog(text: string): AutotestEvent[] {
  const events: AutotestEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).event === "string") events.push(parsed as AutotestEvent);
    } catch {
      continue;
    }
  }
  return events;
}

export function splitRuns(events: readonly AutotestEvent[]): AutotestEvent[][] {
  const runs: AutotestEvent[][] = [];
  for (const event of events) {
    if (event.event === "started" || runs.length === 0) runs.push([]);
    runs[runs.length - 1].push(event);
  }
  return runs;
}

function lastResult(events: readonly AutotestEvent[]): AutotestEvent | null {
  return [...events].reverse().find((event) => event.event === "result") ?? null;
}

export function observedOutcome(observation: Pick<ScenarioObservation, "events" | "relaunchEvents">): string | null {
  if (observation.relaunchEvents.some((event) => event.event === "relaunched")) return "relaunched";
  const result = lastResult(observation.events);
  if (result) return String(result.outcome);
  return observation.events.some((event) => event.event === "installing") ? "installer-did-not-start" : null;
}

function stateOf(event: AutotestEvent | null): Record<string, unknown> | null {
  const value = event?.state;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function samePath(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const normalize = (value: string): string => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

function identityProblems(label: string, started: AutotestEvent | undefined, observation: ScenarioObservation): string[] {
  if (!started) return [];
  const problems: string[] = [];
  if (!samePath(started.cwCodeHome, observation.expectedCwCodeHome)) {
    problems.push(`${label} used CW_CODE_HOME ${String(started.cwCodeHome ?? "unknown")}, expected ${observation.expectedCwCodeHome}`);
  }
  if (!samePath(started.userDataDir, observation.expectedUserDataDir)) {
    problems.push(`${label} used userData ${String(started.userDataDir ?? "unknown")}, expected ${observation.expectedUserDataDir}`);
  }
  return problems;
}

function errorContextOf(event: AutotestEvent | null): string | null {
  const error = stateOf(event)?.error;
  if (!error || typeof error !== "object") return null;
  const context = (error as Record<string, unknown>).context;
  return typeof context === "string" ? context : null;
}

export function evaluateScenario(entry: UpgradeScenario, versions: UpdateTestVersions, observation: ScenarioObservation): string[] {
  const problems: string[] = [];
  const expected = entry.expect;
  const started = observation.events.find((event) => event.event === "started");
  if (!started) problems.push("the installed app never wrote the autotest started event");
  else if (started.version !== versions[entry.install]) problems.push(`started as ${String(started.version)}, expected ${versions[entry.install]}`);
  problems.push(...identityProblems("the installed app", started, observation));

  const outcome = observedOutcome(observation);
  if (outcome !== expected.outcome) problems.push(`outcome was ${outcome ?? "missing"}, expected ${expected.outcome}`);

  const finalVersion = versions[expected.finalVersion];
  if (observation.displayVersionAfter !== finalVersion) {
    problems.push(`registry DisplayVersion is ${observation.displayVersionAfter ?? "missing"}, expected ${finalVersion}`);
  }
  if (observation.installLocationBefore === null) problems.push("InstallLocation was missing before the update");
  else if (observation.installLocationAfter !== observation.installLocationBefore) {
    problems.push(`InstallLocation changed from ${observation.installLocationBefore} to ${observation.installLocationAfter ?? "missing"}`);
  }

  if (expected.outcome === "relaunched") {
    const relaunched = observation.relaunchEvents.find((event) => event.event === "relaunched");
    if (relaunched?.version !== finalVersion) problems.push(`relaunched as ${String(relaunched?.version ?? "nothing")}, expected ${finalVersion}`);
    if (relaunched && relaunched.startupMode !== "ready") problems.push(`relaunched app started in ${String(relaunched.startupMode)} mode`);
    if (relaunched && relaunched.launchedByInstaller !== true) problems.push("the relaunched app was not started by the installer (no --updated)");
    const relaunchStarted = observation.relaunchEvents.find((event) => event.event === "started");
    if (relaunchStarted && started && relaunchStarted.pid === started.pid) problems.push(`the relaunched app reports the same pid ${String(started.pid)} as N`);
    problems.push(...identityProblems("the relaunched app", relaunchStarted, observation));
    const postCheck = stateOf(lastResult(observation.relaunchEvents));
    if (postCheck && postCheck.phase !== "up-to-date") problems.push(`relaunched app reported ${String(postCheck.phase)} instead of up-to-date`);
  } else if (observation.relaunchEvents.length > 0) {
    problems.push("the app relaunched although no update should have been installed");
  }

  const result = lastResult(observation.events);
  if (expected.errorContext !== null) {
    const context = errorContextOf(result);
    if (context !== expected.errorContext) problems.push(`error context was ${context ?? "none"}, expected ${expected.errorContext}`);
    const error = stateOf(result)?.error as Record<string, unknown> | undefined;
    if (error && error.retryable !== true) problems.push("the error is not marked retryable, so the UI offers no Retry");
  }
  if (expected.availableVersion !== null) {
    const available = stateOf(result)?.availableVersion;
    if (available !== versions[expected.availableVersion]) {
      problems.push(`available version was ${String(available ?? "none")}, expected ${versions[expected.availableVersion]}`);
    }
  }
  const finalState = stateOf(result);
  if (expected.finalPhase !== null && finalState?.phase !== expected.finalPhase) {
    problems.push(`final phase was ${String(finalState?.phase ?? "none")}, expected ${expected.finalPhase}`);
  }
  if (expected.downloadedVersion !== null && finalState?.downloadedVersion !== versions[expected.downloadedVersion]) {
    problems.push(`downloaded version was ${String(finalState?.downloadedVersion ?? "none")}, expected ${versions[expected.downloadedVersion]}`);
  }
  if (expected.coordinatorIdle && result?.coordinatorIdle !== true) problems.push("the shutdown coordinator still holds a reservation after the run");
  if (expected.transfer !== null) {
    const transfer = classifyTransfer(observation.transfers, observation.advertisedInstaller, observation.advertisedInstallerSize);
    if (transfer !== expected.transfer) problems.push(`installer transfer was ${transfer}, expected ${expected.transfer}`);
  }

  if (entry.busyTurn) {
    const assessment = observation.events.find((event) => event.event === "assessment");
    const turns = Array.isArray(assessment?.activeTurns) ? assessment.activeTurns.length : 0;
    if (turns === 0) problems.push("the busy turn was not active when the restart was prepared");
    if (!observation.fakeCli) problems.push("the fake CLI never started");
    else {
      if (observation.fakeCli.turnStarts !== 1) problems.push(`the fake CLI saw ${observation.fakeCli.turnStarts} turn starts, expected exactly 1 (no resend)`);
      if (observation.fakeCli.stillRunning.length > 0) problems.push(`fake CLI processes still running: ${observation.fakeCli.stillRunning.join(", ")}`);
    }
  }

  if (expected.outcome === "installer-did-not-start") {
    const recovery = observation.recoveryEvents;
    if (recovery === null) problems.push("N was not relaunched to confirm it still works");
    else {
      const recovered = lastResult(recovery);
      if (recovered?.outcome !== "available") problems.push(`after the failed install N reported ${String(recovered?.outcome ?? "nothing")} instead of offering the update again`);
    }
  }

  problems.push(...observation.metadataProblems);
  return problems;
}

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object") : [];
}

export function projectMetadata(sessionsDocument: unknown, settingsDocument: unknown, settingsKeys: readonly string[]): MetadataProjection {
  const sessionsRoot = sessionsDocument && typeof sessionsDocument === "object" ? (sessionsDocument as Record<string, unknown>) : {};
  const settingsRoot = settingsDocument && typeof settingsDocument === "object" ? (settingsDocument as Record<string, unknown>) : {};
  const projects = records(sessionsRoot.projects)
    .map((project) => ({ id: text(project.id) ?? "", rootPath: stripTrailingSeparators(text(project.rootPath) ?? "") }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const sessions = records(sessionsRoot.sessions)
    .map((session) => ({
      id: text(session.id) ?? "",
      projectId: text(session.projectId) ?? "",
      driver: text(session.driver) ?? "",
      resumeCursor: text(session.resumeCursor),
      worktreePath: text(session.worktreePath) === null ? null : stripTrailingSeparators(text(session.worktreePath) ?? ""),
      branch: text(session.branch)
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const settings: Record<string, unknown> = {};
  for (const key of settingsKeys) settings[key] = settingsRoot[key];
  return { projects, sessions, settings };
}

export function compareMetadata(before: MetadataProjection, after: MetadataProjection): string[] {
  const problems: string[] = [];
  const afterProjects = new Map(after.projects.map((project) => [project.id, project]));
  for (const project of before.projects) {
    const match = afterProjects.get(project.id);
    if (!match) problems.push(`project ${project.id} is missing after the update`);
    else if (match.rootPath !== project.rootPath) problems.push(`project ${project.id} root changed from ${project.rootPath} to ${match.rootPath}`);
  }
  const afterSessions = new Map(after.sessions.map((session) => [session.id, session]));
  for (const session of before.sessions) {
    const match = afterSessions.get(session.id);
    if (!match) {
      problems.push(`session ${session.id} is missing after the update`);
      continue;
    }
    for (const field of ["projectId", "driver", "resumeCursor", "worktreePath", "branch"] as const) {
      if (match[field] !== session[field]) problems.push(`session ${session.id} ${field} changed from ${String(session[field])} to ${String(match[field])}`);
    }
  }
  for (const [key, value] of Object.entries(before.settings)) {
    if (JSON.stringify(after.settings[key]) !== JSON.stringify(value)) problems.push(`setting ${key} changed after the update`);
  }
  return problems;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(value: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  let result = value;
  const ordered = [...replacements].filter(([from]) => from.length > 0).sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of ordered) {
    const variants = new Set([from, from.replaceAll("\\", "/"), from.replaceAll("/", "\\"), from.replaceAll("\\", "\\\\")]);
    for (const variant of variants) result = result.replace(new RegExp(escapeRegExp(variant), "gi"), to);
  }
  return result
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)(?!<user>)[^\\/"'\s]+/gi, "$1<user>")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1<redacted>");
}

export function redactValue(value: unknown, replacements: ReadonlyArray<readonly [string, string]>): unknown {
  if (typeof value === "string") return redactText(value, replacements);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, replacements));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^(env|token|authorization|password|secret)$/i.test(key)) continue;
      result[key] = redactValue(entry, replacements);
    }
    return result;
  }
  return value;
}
