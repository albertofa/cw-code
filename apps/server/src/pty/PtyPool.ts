import type { AppSettings, TerminalLaunch } from "@cw-code/contracts";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { toShellTarget } from "./resolve.js";
import { parseExtraArgs } from "../settings/settingsUtils.js";
import { traceHarnessCall, truncateError } from "../debug/harnessTrace.js";
import { shutdownReservedError } from "../shutdown/shutdownReservation.js";
import { sanitizedChildEnv } from "../shellEnvironment.js";
import { detachProcessGroup, killProcessTreeByPid } from "../processTree.js";
import { LatestClientSize, type PtySize } from "./ptySize.js";

export type PtyKind = "claude" | "opencode" | "codex" | "shell";

export interface PtyAttachResult {
  ptyId: string;
  token: string;
  replay: string;
}

export interface PtyInstance {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  readonly pid?: number;
  kill(): void;
}

export interface PtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env?: NodeJS.ProcessEnv }): PtyInstance;
}

export interface PtyListEntry {
  ptyId: string;
  sessionId: string;
  kind: PtyKind;
}

interface PtyEntry {
  sessionId: string;
  kind: PtyKind;
  proc: PtyInstance;
  replay: string;
  token: string;
  sizes: LatestClientSize;
  release?: () => void;
}

const REPLAY_LIMIT_CHARS = 262_144;
const INITIAL_SIZE: PtySize = { cols: 120, rows: 30 };
const MAX_DIMENSION = 1000;

function isDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_DIMENSION;
}

let cachedPty: PtyModule | null = null;
let loadError: string | null = null;

function bundledPtyEntry(): string | null {
  const explicit = process.env.CW_NODE_PTY?.trim();
  if (explicit) return explicit;
  const sibling = join(dirname(process.execPath), "node_modules", "node-pty", "lib", "index.js");
  return existsSync(sibling) ? sibling : null;
}

async function importPty(): Promise<PtyModule> {
  const entry = bundledPtyEntry();
  if (entry) return createRequire(entry)(entry) as PtyModule;
  return (await import("node-pty")) as unknown as PtyModule;
}

export async function loadPty(): Promise<PtyModule> {
  if (cachedPty) return cachedPty;
  if (loadError) throw new Error(loadError);
  try {
    cachedPty = await importPty();
    return cachedPty;
  } catch (err) {
    loadError =
      `PTY unavailable: could not load node-pty (${(err as Error).message.split("\n")[0]}). ` +
      "Reinstall cw-code or set CW_NODE_PTY to node-pty/lib/index.js.";
    throw new Error(loadError);
  }
}

export function buildResumeArgs(kind: PtyKind, cursor: string): string[] {
  if (!cursor) return [];
  if (kind === "claude") return ["--resume", cursor];
  if (kind === "opencode") return ["--session", cursor];
  if (kind === "codex") return ["resume", cursor];
  return [];
}

function appendReplay(entry: PtyEntry, data: string): void {
  entry.replay += data;
  const over = entry.replay.length - REPLAY_LIMIT_CHARS;
  if (over <= 0) return;
  const cut = entry.replay.indexOf("\n", over);
  entry.replay = cut >= 0 ? entry.replay.slice(cut + 1) : entry.replay.slice(over);
}

export class PtyPool {
  private ptys = new Map<string, PtyEntry>();
  private openings = new Map<string, Promise<PtyEntry>>();
  private pendingKills = new Set<string>();
  private nextToken = 1;
  private disposed = false;
  private generation = 0;
  private shutdownReserved = false;
  private onExit: (ptyId: string, token: string, exitCode: number) => void = () => {};
  private readonly changeListeners = new Set<() => void>();

  constructor(
    private getSettings: () => AppSettings,
    private loadModule: () => Promise<PtyModule> = loadPty
  ) {}

  setExitEmitter(onExit: (ptyId: string, token: string, exitCode: number) => void): void {
    this.onExit = onExit;
  }

  onChanged(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private notifyChanged(): void {
    for (const cb of [...this.changeListeners]) {
      try {
        cb();
      } catch (err) {
        console.warn(`[pty] change listener failed: ${(err as Error).message}`);
      }
    }
  }

  list(): PtyListEntry[] {
    return [...this.ptys].map(([ptyId, entry]) => ({ ptyId, sessionId: entry.sessionId, kind: entry.kind }));
  }

  beginShutdownReservation(): void {
    this.shutdownReserved = true;
  }

  clearShutdownReservation(): void {
    this.shutdownReserved = false;
  }

  private assertCanOpen(generation = this.generation): void {
    if (this.shutdownReserved) throw shutdownReservedError();
    if (this.disposed || generation !== this.generation) throw new Error("pty pool disposed");
  }

  async open(
    sessionId: string,
    cwd: string,
    kind: PtyKind,
    resumeCursor: string,
    env: Record<string, string> | undefined,
    onData: (ptyId: string, data: string) => void,
    launch: () => Promise<TerminalLaunch | null> = async () => null
  ): Promise<PtyAttachResult> {
    const ptyId = `${sessionId}:${kind}`;
    const existing = this.disposed ? undefined : this.ptys.get(ptyId);
    if (existing) return this.attach(existing, ptyId);
    this.assertCanOpen();
    const generation = this.generation;
    let task = this.openings.get(ptyId);
    if (!task) {
      task = this.spawn(generation, ptyId, sessionId, cwd, kind, resumeCursor, env, onData, launch);
      this.openings.set(ptyId, task);
      task.finally(() => {
        if (this.openings.get(ptyId) === task) this.openings.delete(ptyId);
        if (!this.ptys.has(ptyId)) this.pendingKills.delete(ptyId);
      }).catch(() => {});
    }
    const entry = await task;
    return this.attach(entry, ptyId);
  }

  private attach(entry: PtyEntry, ptyId: string): PtyAttachResult {
    if (this.pendingKills.delete(ptyId)) this.kill(ptyId);
    return { ptyId, token: entry.token, replay: entry.replay };
  }

  detach(ptyId: string, clientId: string): void {
    const entry = this.ptys.get(ptyId);
    if (entry) this.applySize(entry, entry.sizes.remove(clientId));
  }

  private applySize(entry: PtyEntry, size: PtySize | null): void {
    if (size) entry.proc.resize(size.cols, size.rows);
  }

  private async spawn(
    generation: number,
    ptyId: string,
    sessionId: string,
    cwd: string,
    kind: PtyKind,
    resumeCursor: string,
    env: Record<string, string> | undefined,
    onData: (ptyId: string, data: string) => void,
    launch: () => Promise<TerminalLaunch | null>
  ): Promise<PtyEntry> {
    const attached = kind === "shell" ? null : await launch();
    try {
      const entry = await this.spawnProcess(generation, ptyId, sessionId, cwd, kind, resumeCursor, env, onData, attached);
      if (attached) entry.release = attached.release;
      return entry;
    } catch (err) {
      attached?.release();
      throw err;
    }
  }

  private async spawnProcess(
    generation: number,
    ptyId: string,
    sessionId: string,
    cwd: string,
    kind: PtyKind,
    resumeCursor: string,
    env: Record<string, string> | undefined,
    onData: (ptyId: string, data: string) => void,
    attached: TerminalLaunch | null
  ): Promise<PtyEntry> {
    const start = Date.now();
    const operation = "pty.open";
    let pty: PtyModule;
    try {
      pty = await this.loadModule();
    } catch (err) {
      traceHarnessCall({
        harness: kind === "shell" ? "system" : kind,
        operation,
        cwd,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message),
        extra: { kind, ptyId }
      });
      throw err;
    }
    this.assertCanOpen(generation);
    let file: string;
    let extra: string[] = [];
    if (kind === "claude") {
      const s = this.getSettings();
      file = s.claudeBinaryPath;
      extra = parseExtraArgs(s.claudeExtraArgs);
    } else if (kind === "opencode") {
      const s = this.getSettings();
      file = s.opencodeBinaryPath;
      extra = parseExtraArgs(s.opencodeExtraArgs);
    } else if (kind === "codex") {
      const s = this.getSettings();
      file = s.codexBinaryPath;
      extra = parseExtraArgs(s.codexExtraArgs);
    } else {
      file = process.platform === "win32" ? "powershell.exe" : process.env["SHELL"] || "/bin/bash";
    }
    const args = [...(attached?.args ?? []), ...buildResumeArgs(kind, resumeCursor), ...extra];
    let target: { file: string; args: string[] };
    try {
      target = toShellTarget(file, args);
    } catch (err) {
      traceHarnessCall({
        harness: kind === "shell" ? "system" : kind,
        operation,
        cwd,
        binary: file,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message),
        extra: { kind, ptyId }
      });
      throw err;
    }
    let proc: PtyInstance;
    try {
      proc = pty.spawn(target.file, target.args, {
        name: "xterm-256color",
        cols: INITIAL_SIZE.cols,
        rows: INITIAL_SIZE.rows,
        cwd,
        env: sanitizedChildEnv({ ...(env ?? process.env), ...(attached?.env ?? {}) }, process.platform)
      });
    } catch (err) {
      traceHarnessCall({
        harness: kind === "shell" ? "system" : kind,
        operation,
        cwd,
        binary: target.file,
        args: target.args,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError(`PTY spawn failed for '${file}': ${(err as Error).message}`),
        extra: { kind, ptyId }
      });
      throw new Error(`PTY spawn failed for '${file}': ${(err as Error).message}`);
    }
    if (this.disposed || generation !== this.generation) {
      this.killPty(proc);
      throw new Error("pty pool disposed");
    }
    const entry: PtyEntry = { sessionId, kind, proc, replay: "", token: `pty-${this.nextToken++}`, sizes: new LatestClientSize(INITIAL_SIZE) };
    this.ptys.set(ptyId, entry);
    this.notifyChanged();
    proc.onData((data) => {
      appendReplay(entry, data);
      onData(ptyId, data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.ptys.get(ptyId) === entry) {
        this.ptys.delete(ptyId);
        this.notifyChanged();
      }
      this.releaseEntry(entry);
      this.onExit(ptyId, entry.token, exitCode);
    });
    traceHarnessCall({
      harness: kind === "shell" ? "system" : kind,
      operation,
      cwd,
      binary: target.file,
      args: target.args,
      durationMs: Date.now() - start,
      ok: true,
      extra: { kind, ptyId }
    });
    return entry;
  }

  has(ptyId: string): boolean {
    return this.ptys.has(ptyId);
  }

  write(ptyId: string, clientId: string, data: string): void {
    const entry = this.ptys.get(ptyId);
    if (!entry) return;
    this.applySize(entry, entry.sizes.input(clientId));
    entry.proc.write(data);
  }

  resize(ptyId: string, clientId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(ptyId);
    if (!entry || !isDimension(cols) || !isDimension(rows)) return;
    this.applySize(entry, entry.sizes.resize(clientId, { cols, rows }));
  }

  kill(ptyId: string): void {
    const entry = this.ptys.get(ptyId);
    if (!entry) return;
    this.ptys.delete(ptyId);
    this.notifyChanged();
    this.killPty(entry.proc);
    this.releaseEntry(entry);
  }

  private releaseEntry(entry: PtyEntry): void {
    const release = entry.release;
    entry.release = undefined;
    release?.();
  }

  private killPty(proc: PtyInstance): void {
    try {
      proc.kill();
    } catch {
    }
    if (detachProcessGroup) killProcessTreeByPid(proc.pid);
  }

  killSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const ptyId of [...this.ptys.keys()]) {
      if (ptyId.startsWith(prefix)) this.kill(ptyId);
    }
    for (const ptyId of [...this.openings.keys()]) {
      if (ptyId.startsWith(prefix)) this.pendingKills.add(ptyId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const ptyId of [...this.ptys.keys()]) this.kill(ptyId);
    this.openings.clear();
    this.pendingKills.clear();
  }

  reopen(): void {
    this.disposed = false;
  }
}
