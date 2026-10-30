import type { CliVersionCheck, DriverKind, HarnessUpdateInfo, HarnessUpdates } from "@cw-code/contracts";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import { traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";
import type { InstallPlan } from "./installMethod.js";
import { packageFor } from "./latestVersion.js";
import { lastOutputLine, type UpdateCommand, type UpdateRunner } from "./runUpdateCommand.js";
import { isBehind } from "./versionCompare.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export type HarnessCheck = CliVersionCheck & { skipped: boolean };

export interface HarnessUpdateDeps {
  initial: HarnessUpdates;
  checks(): readonly HarnessCheck[];
  enabled(): boolean;
  plan(binary: DriverKind, binaryPath: string, packageName: string): Promise<InstallPlan>;
  latest(packageName: string, opts: { fresh: boolean }): Promise<string | null>;
  run: UpdateRunner;
  activity(kind: DriverKind): { busy: number };
  onActivity(listener: () => void): () => void;
  release(kind: DriverKind): Promise<void>;
  recheck(): Promise<unknown>;
  publish(updates: HarnessUpdates): void;
  now?(): number;
}

interface KnownPlan {
  plan: InstallPlan;
  binaryPath: string;
  packageName: string;
}

type PhaseFields = Pick<HarnessUpdateInfo, "phase" | "phaseMessage" | "startedAt" | "finishedAt" | "output">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function phaseFields(info: HarnessUpdateInfo): PhaseFields {
  return { phase: info.phase, phaseMessage: info.phaseMessage, startedAt: info.startedAt, finishedAt: info.finishedAt, output: info.output };
}

export class HarnessUpdateService {
  private state: HarnessUpdates;
  private readonly plans = new Map<DriverKind, KnownPlan>();
  private readonly active = new Set<DriverKind>();
  private readonly running = new Set<DriverKind>();
  private readonly locks = new Map<string, Promise<void>>();
  private latestRefresh = 0;
  private newestRefresh: Promise<HarnessUpdates> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private readonly deps: HarnessUpdateDeps) {
    this.state = deps.initial;
  }

  get updates(): HarnessUpdates {
    return this.state;
  }

  turnGate(kind: DriverKind): string | null {
    return this.running.has(kind) ? `${harnessLabel(kind)} is updating. Try again when the update finishes.` : null;
  }

  harnessChecked(): void {
    if (!this.started) {
      this.started = true;
      this.startTimer();
    }
    void this.refresh({ fresh: false });
  }

  resume(): void {
    if (this.started) this.startTimer();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(opts: { fresh: boolean }): Promise<HarnessUpdates> {
    const run = ++this.latestRefresh;
    const own = this.evaluateAll(run, opts.fresh);
    this.newestRefresh = own;
    let current = own;
    let result = await current;
    while (this.newestRefresh !== null && this.newestRefresh !== current) {
      current = this.newestRefresh;
      result = await current;
    }
    return result;
  }

  async update(binaries: readonly DriverKind[]): Promise<HarnessUpdates> {
    const targets = [...new Set(binaries)].filter((binary) => {
      const info = this.state[binary];
      return info.canUpdate && info.latestVersion !== null && !this.active.has(binary) && this.plans.get(binary)?.plan.command;
    });
    for (const binary of targets) this.active.add(binary);
    await Promise.all(targets.map((binary) => this.start(binary)));
    return this.state;
  }

  private startTimer(): void {
    this.dispose();
    this.timer = setInterval(() => void this.refresh({ fresh: true }), REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private patch(binary: DriverKind, fields: Partial<HarnessUpdateInfo>): void {
    this.state = { ...this.state, [binary]: { ...this.state[binary], ...fields } };
    this.deps.publish(this.state);
  }

  private async evaluateAll(run: number, fresh: boolean): Promise<HarnessUpdates> {
    const enabled = this.deps.enabled();
    const evaluated = await Promise.all(this.deps.checks().map((check) => this.evaluate(check, enabled, fresh)));
    if (run !== this.latestRefresh) return this.state;
    let next = this.state;
    for (const info of evaluated) next = { ...next, [info.binary]: { ...info, ...phaseFields(this.state[info.binary]) } };
    this.state = next;
    this.deps.publish(next);
    return next;
  }

  private async evaluate(check: HarnessCheck, enabled: boolean, fresh: boolean): Promise<HarnessUpdateInfo> {
    const { binary, actual, binaryPath } = check;
    const base: HarnessUpdateInfo = {
      ...this.state[binary],
      status: "unknown",
      currentVersion: actual,
      latestVersion: null,
      installMethod: "unknown",
      canUpdate: false,
      updateCommand: null,
      message: null,
      checkedAt: this.now()
    };
    if (check.skipped || actual === null) {
      this.plans.delete(binary);
      return base;
    }
    const packageName = packageFor(binary, actual);
    let plan: InstallPlan;
    try {
      plan = await this.deps.plan(binary, binaryPath, packageName);
    } catch (error) {
      console.warn(`[harness-updates] could not resolve how ${binary} was installed: ${errorMessage(error)}`);
      this.plans.delete(binary);
      return base;
    }
    this.plans.set(binary, { plan, binaryPath, packageName });
    const withPlan: HarnessUpdateInfo = { ...base, installMethod: plan.method };
    if (!enabled) return withPlan;
    const latest = await this.deps.latest(packageName, { fresh });
    if (latest === null) return withPlan;
    if (!isBehind(actual, latest)) return { ...withPlan, status: "current", latestVersion: latest };
    const behind: HarnessUpdateInfo = { ...withPlan, status: "behind", latestVersion: latest, updateCommand: plan.display };
    if (plan.command) return { ...behind, canUpdate: true };
    return { ...behind, message: `Version ${latest} is out. Update it with the tool that installed ${binaryPath}.` };
  }

  private async start(binary: DriverKind): Promise<void> {
    const known = this.plans.get(binary);
    const latest = this.state[binary].latestVersion;
    const previousVersion = this.state[binary].currentVersion;
    if (!known?.plan.command || latest === null) {
      this.active.delete(binary);
      return;
    }
    let plan: InstallPlan;
    try {
      plan = await this.deps.plan(binary, known.binaryPath, known.packageName);
    } catch (error) {
      this.fail(binary, known.plan.command, this.now(), errorMessage(error), null, null);
      this.active.delete(binary);
      return;
    }
    if (!plan.command || plan.lockKey !== known.plan.lockKey) {
      this.fail(binary, known.plan.command, this.now(), "The installation changed. Recheck and try again.", null, null);
      this.active.delete(binary);
      return;
    }
    void this.execute(binary, plan.command, plan.lockKey ?? binary, latest, previousVersion);
  }

  private async execute(binary: DriverKind, command: UpdateCommand, lockKey: string, latest: string, previousVersion: string | null): Promise<void> {
    const startedAt = this.now();
    const previous = this.locks.get(lockKey);
    let unlock: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const chain = (previous ?? Promise.resolve()).then(() => mine);
    this.locks.set(lockKey, chain);
    try {
      this.patch(binary, { phase: "queued", phaseMessage: previous ? "Waiting for another update to finish" : null, startedAt, finishedAt: null, output: null });
      if (previous) await previous;
      await this.waitForIdle(binary);
      this.running.add(binary);
      await this.deps.release(binary);
      this.patch(binary, { phase: "running", phaseMessage: `Updating to ${latest}`, startedAt: this.now() });
      const result = await this.deps.run(command, (line) => this.patch(binary, { output: line }));
      await this.deps.release(binary);
      const output = result.output || null;
      if (result.error !== null || result.code !== 0) {
        const message = result.error ?? `Update command exited with code ${result.code}: ${lastOutputLine(result.output) ?? ""}`.trimEnd();
        this.fail(binary, command, startedAt, message, output, result.code);
        return;
      }
      await this.deps.recheck();
      await this.refresh({ fresh: true });
      this.finish(binary, command, startedAt, latest, previousVersion, output);
    } catch (error) {
      this.fail(binary, command, startedAt, errorMessage(error), null, null);
    } finally {
      this.running.delete(binary);
      this.active.delete(binary);
      unlock();
      if (this.locks.get(lockKey) === chain) this.locks.delete(lockKey);
    }
  }

  private waitForIdle(binary: DriverKind): Promise<void> {
    if (this.deps.activity(binary).busy === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        const { busy } = this.deps.activity(binary);
        if (busy === 0) {
          unsubscribe();
          resolve();
          return;
        }
        const phaseMessage = `Waiting for ${busy} running turn(s) to finish`;
        if (this.state[binary].phaseMessage !== phaseMessage) this.patch(binary, { phase: "queued", phaseMessage });
      };
      const unsubscribe = this.deps.onActivity(check);
      check();
    });
  }

  private finish(binary: DriverKind, command: UpdateCommand, startedAt: number, latest: string, previousVersion: string | null, output: string | null): void {
    const version = this.state[binary].currentVersion;
    const finishedAt = this.now();
    if (version !== null && !isBehind(version, latest) && (version !== previousVersion || version === latest)) {
      this.patch(binary, { phase: "succeeded", phaseMessage: `Updated to ${version}`, finishedAt, output });
      this.trace(binary, command, startedAt, true, null, 0);
      return;
    }
    const phaseMessage =
      version === null
        ? "Update finished, but the version could not be verified."
        : `Update finished, but ${harnessLabel(binary)} still reports ${version}.`;
    this.patch(binary, { phase: "unchanged", phaseMessage, finishedAt, output });
    console.warn(`[harness-updates] ${binary}: ${phaseMessage}`);
    this.trace(binary, command, startedAt, false, phaseMessage, 0);
  }

  private fail(binary: DriverKind, command: UpdateCommand, startedAt: number, message: string, output: string | null, exitCode: number | null): void {
    this.patch(binary, { phase: "failed", phaseMessage: message, startedAt, finishedAt: this.now(), output });
    console.warn(`[harness-updates] ${binary} update failed: ${message}`);
    this.trace(binary, command, startedAt, false, message, exitCode);
  }

  private trace(binary: DriverKind, command: UpdateCommand, startedAt: number, ok: boolean, error: string | null, exitCode: number | null): void {
    traceHarnessCall({
      harness: binary,
      operation: "cli.update",
      binary: command.file,
      args: command.args,
      durationMs: this.now() - startedAt,
      ok,
      exitCode,
      ...(error === null ? {} : { error: truncateError(error) })
    });
  }
}
