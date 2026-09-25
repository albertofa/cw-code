import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  ShutdownAssessment,
  ShutdownPrepareRequest,
  ShutdownPrepareResult,
  UpdateActionResult,
  UpdateChannel,
  UpdateState
} from "@cw-code/contracts";

export const UPDATE_AUTOTEST_MARKER = "cw-update-autotest";
export const UPDATE_AUTOTEST_HANDOFF_FILE = "cw-update-autotest-handoff.json";
export const BUSY_TURN_PROMPT = "cw-update-autotest busy turn";
export const UPDATE_TEST_HOME_DIR_NAME = ".cw-code-updatetest";

const MODES = ["install", "check-only", "download-only", "cancel"] as const;
const PROGRESS_MILESTONES = [25, 50, 75, 100];
const PREPARE_TIMEOUT_MS = 15_000;
const BUSY_WARMUP_MS = 3_000;
const PAUSE_TIMEOUT_MS = 180_000;
const PAUSE_POLL_MS = 500;

export type UpdateAutotestMode = (typeof MODES)[number];

export interface UpdateAutotestConfig {
  mode: UpdateAutotestMode | "relaunched";
  outPath: string;
  cwCodeHome: string | null;
  busySessionId: string | null;
  pauseFile: string | null;
  fromVersion: string | null;
}

export interface UpdateAutotestHandoff {
  marker: typeof UPDATE_AUTOTEST_MARKER;
  outPath: string;
  cwCodeHome: string | null;
  fromVersion: string;
}

export interface UpdateAutotestResolution {
  config: UpdateAutotestConfig | null;
  problem: string | null;
}

export interface UpdateAutotestIo {
  appendLine(path: string, line: string): void;
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, text: string): void;
  remove(path: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface UpdateAutotestHost {
  version: string;
  pid: number;
  launchedByInstaller: boolean;
  startupMode: "ready" | "recovery";
  userDataDir: string;
  cwCodeHome: string;
  updates: {
    getState(): UpdateState;
    subscribe(listener: (state: UpdateState) => void): () => void;
    check(): Promise<UpdateActionResult>;
    download(): Promise<UpdateActionResult>;
  } | null;
  shutdown: {
    assess(): ShutdownAssessment;
    prepare(request: ShutdownPrepareRequest): Promise<ShutdownPrepareResult>;
    force(token: string): Promise<ShutdownPrepareResult>;
    cancel(token: string): void;
    isIdle(): boolean;
  } | null;
  install(request: { version: string; channel: UpdateChannel; token: string }): Promise<UpdateActionResult>;
  startTurn(sessionId: string, prompt: string): Promise<string>;
  quit(): void;
}

type EventData = Record<string, unknown>;

export const nodeAutotestIo: UpdateAutotestIo = {
  appendLine: (path, line) => appendFileSync(path, line, "utf8"),
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, text) => writeFileSync(path, text, "utf8"),
  remove: (path) => rmSync(path, { force: true }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now()
};

function isMode(value: string): value is UpdateAutotestMode {
  return (MODES as readonly string[]).includes(value);
}

function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseHandoff(raw: unknown): UpdateAutotestHandoff | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.marker !== UPDATE_AUTOTEST_MARKER) return null;
  if (typeof record.outPath !== "string" || !isAbsolute(record.outPath)) return null;
  if (typeof record.fromVersion !== "string" || record.fromVersion === "") return null;
  if (record.cwCodeHome !== null && (typeof record.cwCodeHome !== "string" || !isAbsolute(record.cwCodeHome))) return null;
  return { marker: UPDATE_AUTOTEST_MARKER, outPath: record.outPath, cwCodeHome: record.cwCodeHome, fromVersion: record.fromVersion };
}

export function resolveUpdateAutotest(env: Record<string, string | undefined>, handoffRaw: unknown): UpdateAutotestResolution {
  if (handoffRaw !== null && handoffRaw !== undefined) {
    const handoff = parseHandoff(handoffRaw);
    if (!handoff) return { config: null, problem: "the relaunch handoff file is malformed" };
    return {
      config: {
        mode: "relaunched",
        outPath: handoff.outPath,
        cwCodeHome: handoff.cwCodeHome,
        busySessionId: null,
        pauseFile: null,
        fromVersion: handoff.fromVersion
      },
      problem: null
    };
  }
  const mode = optionalText(env.CW_UPDATE_AUTOTEST);
  if (mode === null) return { config: null, problem: null };
  if (!isMode(mode)) return { config: null, problem: `CW_UPDATE_AUTOTEST must be one of ${MODES.join(", ")}` };
  const outPath = optionalText(env.CW_UPDATE_AUTOTEST_OUT);
  if (outPath === null || !isAbsolute(outPath)) return { config: null, problem: "CW_UPDATE_AUTOTEST_OUT must be an absolute path" };
  const pauseFile = optionalText(env.CW_UPDATE_AUTOTEST_PAUSE_FILE);
  if (pauseFile !== null && !isAbsolute(pauseFile)) return { config: null, problem: "CW_UPDATE_AUTOTEST_PAUSE_FILE must be an absolute path" };
  const cwCodeHome = optionalText(env.CW_CODE_HOME);
  return {
    config: {
      mode,
      outPath,
      cwCodeHome: cwCodeHome !== null && isAbsolute(cwCodeHome) ? cwCodeHome : null,
      busySessionId: optionalText(env.CW_UPDATE_AUTOTEST_BUSY_SESSION),
      pauseFile,
      fromVersion: null
    },
    problem: null
  };
}

export function loadUpdateAutotest(options: {
  env: Record<string, string | undefined>;
  userDataDir: string;
  homeDir: string;
  io?: UpdateAutotestIo;
}): UpdateAutotestResolution {
  const io = options.io ?? nodeAutotestIo;
  const handoffPath = join(options.userDataDir, UPDATE_AUTOTEST_HANDOFF_FILE);
  let handoff: unknown = null;
  if (io.exists(handoffPath)) {
    try {
      handoff = JSON.parse(io.readText(handoffPath)) as unknown;
    } catch {
      handoff = {};
    }
    io.remove(handoffPath);
  }
  const resolution = resolveUpdateAutotest(options.env, handoff);
  const home = resolution.config?.cwCodeHome;
  if (home && !optionalText(options.env.CW_CODE_HOME)) options.env.CW_CODE_HOME = home;
  if (!optionalText(options.env.CW_CODE_HOME)) options.env.CW_CODE_HOME = join(options.homeDir, UPDATE_TEST_HOME_DIR_NAME);
  if (resolution.config && resolution.config.cwCodeHome === null) resolution.config.cwCodeHome = options.env.CW_CODE_HOME ?? null;
  return resolution;
}

function summarizeState(state: UpdateState): EventData {
  return {
    phase: state.phase,
    runningVersion: state.runningVersion,
    channel: state.channel,
    availableVersion: state.availableVersion,
    downloadedVersion: state.downloadedVersion,
    error: state.error,
    disabledReason: state.disabledReason
  };
}

function summarizeAction(result: UpdateActionResult): EventData {
  return result.ok
    ? { ok: true, state: summarizeState(result.state) }
    : { ok: false, code: result.code, message: result.message, state: summarizeState(result.state) };
}

function summarizeAssessment(assessment: ShutdownAssessment): EventData {
  return {
    activeTurns: assessment.activeTurns.map((turn) => ({ sessionId: turn.sessionId, turnId: turn.turnId })),
    backgroundTasks: assessment.backgroundTasks,
    terminals: assessment.terminals.length
  };
}

class AutotestLog {
  constructor(
    private readonly outPath: string,
    private readonly io: UpdateAutotestIo
  ) {}

  write(event: string, data: EventData = {}): void {
    try {
      this.io.appendLine(this.outPath, `${JSON.stringify({ at: new Date(this.io.now()).toISOString(), event, ...data })}\n`);
    } catch (error) {
      console.warn(`[updates] ${UPDATE_AUTOTEST_MARKER} could not write ${event}: ${(error as Error).message}`);
    }
  }
}

function watchState(updates: NonNullable<UpdateAutotestHost["updates"]>, log: AutotestLog): () => void {
  let lastKey = "";
  const reached = new Set<number>();
  return updates.subscribe((state) => {
    const key = JSON.stringify([state.phase, state.availableVersion, state.downloadedVersion, state.error?.message ?? null]);
    if (key !== lastKey) {
      lastKey = key;
      log.write("state", summarizeState(state));
    }
    if (state.phase !== "downloading" || !state.progress) return;
    for (const milestone of PROGRESS_MILESTONES) {
      if (state.progress.percent < milestone || reached.has(milestone)) continue;
      reached.add(milestone);
      log.write("progress", { percent: milestone, transferred: state.progress.transferred, total: state.progress.total });
    }
  });
}

async function waitForFile(path: string, io: UpdateAutotestIo): Promise<boolean> {
  const deadline = io.now() + PAUSE_TIMEOUT_MS;
  while (io.now() < deadline) {
    if (io.exists(path)) return true;
    await io.sleep(PAUSE_POLL_MS);
  }
  return io.exists(path);
}

async function runRelaunched(config: UpdateAutotestConfig, host: UpdateAutotestHost, log: AutotestLog): Promise<void> {
  log.write("relaunched", {
    fromVersion: config.fromVersion,
    version: host.version,
    sameVersion: config.fromVersion === host.version,
    startupMode: host.startupMode,
    launchedByInstaller: host.launchedByInstaller
  });
  if (!host.updates) {
    log.write("result", { outcome: "relaunched", startupMode: host.startupMode });
    return;
  }
  const check = await host.updates.check();
  log.write("check", summarizeAction(check));
  log.write("result", { outcome: "relaunched", startupMode: host.startupMode, state: summarizeState(check.state) });
}

async function prepareShutdown(host: UpdateAutotestHost, shutdown: NonNullable<UpdateAutotestHost["shutdown"]>, log: AutotestLog): Promise<string | null> {
  const assessment = shutdown.assess();
  log.write("assessment", summarizeAssessment(assessment));
  let prepared = await shutdown.prepare({
    reason: "update",
    stopActiveTurns: true,
    timeoutMs: PREPARE_TIMEOUT_MS,
    approvedTurnIds: assessment.activeTurns.map((turn) => turn.turnId)
  });
  log.write("prepare", prepared.ok ? { ok: true } : { ok: false, code: prepared.code });
  if (!prepared.ok && prepared.code === "timeout") {
    prepared = await shutdown.force(prepared.token);
    log.write("force", prepared.ok ? { ok: true } : { ok: false, code: prepared.code });
  }
  return prepared.ok ? prepared.token : null;
}

async function runMode(mode: UpdateAutotestMode, config: UpdateAutotestConfig, host: UpdateAutotestHost, log: AutotestLog, io: UpdateAutotestIo): Promise<void> {
  const { updates, shutdown } = host;
  if (host.startupMode !== "ready" || !updates || !shutdown) {
    log.write("result", { outcome: "recovery-mode", startupMode: host.startupMode });
    return;
  }
  const finish = (outcome: string, data: EventData = {}): void => log.write("result", { outcome, coordinatorIdle: shutdown.isIdle(), ...data });
  const initial = updates.getState();
  log.write("state", summarizeState(initial));
  if (initial.phase === "disabled") {
    finish("disabled", { state: summarizeState(initial) });
    return;
  }

  const check = await updates.check();
  log.write("check", summarizeAction(check));
  if (!check.ok) {
    finish("check-failed", { state: summarizeState(updates.getState()) });
    return;
  }
  if (check.state.phase !== "available" && check.state.phase !== "ready") {
    finish("up-to-date", { state: summarizeState(check.state) });
    return;
  }
  if (mode === "check-only") {
    finish("available", { state: summarizeState(check.state) });
    return;
  }

  const download = await updates.download();
  log.write("download", summarizeAction(download));
  const ready = updates.getState();
  if (!download.ok || ready.phase !== "ready" || ready.downloadedVersion === null) {
    finish("download-failed", { state: summarizeState(ready) });
    return;
  }
  if (mode === "download-only") {
    finish("ready", { state: summarizeState(ready) });
    return;
  }

  if (config.pauseFile) {
    log.write("paused", { version: ready.downloadedVersion });
    const resumed = await waitForFile(config.pauseFile, io);
    log.write(resumed ? "resumed" : "pause-timeout");
    if (!resumed) {
      finish("pause-timeout", { state: summarizeState(updates.getState()) });
      return;
    }
  }

  if (config.busySessionId) {
    const turnId = await host.startTurn(config.busySessionId, BUSY_TURN_PROMPT);
    log.write("busy-turn", { sessionId: config.busySessionId, turnId });
    await io.sleep(BUSY_WARMUP_MS);
  }

  const token = await prepareShutdown(host, shutdown, log);
  if (token === null) {
    finish("prepare-failed", { state: summarizeState(updates.getState()) });
    return;
  }

  if (mode === "cancel") {
    shutdown.cancel(token);
    log.write("cancelled", { coordinatorIdle: shutdown.isIdle(), assessment: summarizeAssessment(shutdown.assess()) });
    finish("cancelled", { state: summarizeState(updates.getState()) });
    return;
  }

  const handoffPath = join(host.userDataDir, UPDATE_AUTOTEST_HANDOFF_FILE);
  const handoff: UpdateAutotestHandoff = { marker: UPDATE_AUTOTEST_MARKER, outPath: config.outPath, cwCodeHome: config.cwCodeHome, fromVersion: host.version };
  io.writeText(handoffPath, JSON.stringify(handoff));
  log.write("installing", { version: ready.downloadedVersion, channel: ready.channel });
  const installed = await host.install({ version: ready.downloadedVersion, channel: ready.channel, token });
  io.remove(handoffPath);
  log.write("install", summarizeAction(installed));
  finish(installed.ok ? "install-returned" : "install-failed", { state: summarizeState(updates.getState()) });
}

export async function runUpdateAutotest(config: UpdateAutotestConfig, host: UpdateAutotestHost, io: UpdateAutotestIo = nodeAutotestIo): Promise<void> {
  const log = new AutotestLog(config.outPath, io);
  log.write("started", {
    marker: UPDATE_AUTOTEST_MARKER,
    mode: config.mode,
    version: host.version,
    pid: host.pid,
    launchedByInstaller: host.launchedByInstaller,
    startupMode: host.startupMode,
    cwCodeHome: host.cwCodeHome,
    userDataDir: host.userDataDir
  });
  const unwatch = host.updates ? watchState(host.updates, log) : () => undefined;
  try {
    if (config.mode === "relaunched") await runRelaunched(config, host, log);
    else await runMode(config.mode, config, host, log, io);
  } catch (error) {
    log.write("result", { outcome: "crashed", message: (error as Error).message });
  } finally {
    unwatch();
    log.write("quitting", { pid: host.pid });
    host.quit();
  }
}
