import type { AppSettings } from "@cw-code/contracts";
import { toShellTarget } from "./resolve.js";
import { parseExtraArgs } from "../settings/settingsUtils.js";
import { traceHarnessCall, truncateError } from "../debug/harnessTrace.js";
import { shutdownReservedError } from "../shutdown/shutdownReservation.js";

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
  kill(): void;
}

export interface PtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env?: Record<string, string> }): PtyInstance;
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
  attachedCount: number;
}

const REPLAY_LIMIT_CHARS = 262_144;

let cachedPty: PtyModule | null = null;
let loadError: string | null = null;

async function loadPty(): Promise<PtyModule> {
  if (cachedPty) return cachedPty;
  if (loadError) throw new Error(loadError);
  try {
    cachedPty = (await import("node-pty")) as unknown as PtyModule;
    return cachedPty;
  } catch (err) {
    loadError =
      "PTY unavailable: node-pty was built for a different runtime. " +
      "Install VS C++ build tools and run electron-rebuild, then restart. " +
      `(${(err as Error).message.split("\n")[0]})`;
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
  private shutdownReserved = false;
  private onExit: (ptyId: string, token: string, exitCode: number) => void = () => {};

  constructor(
    private getSettings: () => AppSettings,
    private loadModule: () => Promise<PtyModule> = loadPty
  ) {}

  setExitEmitter(onExit: (ptyId: string, token: string, exitCode: number) => void): void {
    this.onExit = onExit;
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

  private assertCanOpen(): void {
    if (this.disposed) throw new Error("pty pool disposed");
    if (this.shutdownReserved) throw shutdownReservedError();
  }

  async open(
    sessionId: string,
    cwd: string,
    kind: PtyKind,
    resumeCursor: string,
    env: Record<string, string> | undefined,
    onData: (ptyId: string, data: string) => void
  ): Promise<PtyAttachResult> {
    if (this.disposed) throw new Error("pty pool disposed");
    const ptyId = `${sessionId}:${kind}`;
    const existing = this.ptys.get(ptyId);
    if (existing) return this.attach(existing, ptyId);
    this.assertCanOpen();
    let task = this.openings.get(ptyId);
    if (!task) {
      task = this.spawn(ptyId, sessionId, cwd, kind, resumeCursor, env, onData);
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
    entry.attachedCount += 1;
    if (this.pendingKills.delete(ptyId)) this.kill(ptyId);
    return { ptyId, token: entry.token, replay: entry.replay };
  }

  detach(ptyId: string, token: string): void {
    const entry = this.ptys.get(ptyId);
    if (entry && entry.token === token && entry.attachedCount > 0) entry.attachedCount -= 1;
  }

  detachAll(): void {
    for (const entry of this.ptys.values()) entry.attachedCount = 0;
  }

  private async spawn(
    ptyId: string,
    sessionId: string,
    cwd: string,
    kind: PtyKind,
    resumeCursor: string,
    env: Record<string, string> | undefined,
    onData: (ptyId: string, data: string) => void
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
    this.assertCanOpen();
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
      file = process.platform === "win32" ? "powershell.exe" : "bash";
    }
    const args = [...buildResumeArgs(kind, resumeCursor), ...extra];
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
        cols: 120,
        rows: 30,
        cwd,
        ...(env ? { env } : {})
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
    const entry: PtyEntry = { sessionId, kind, proc, replay: "", token: `pty-${this.nextToken++}`, attachedCount: 0 };
    this.ptys.set(ptyId, entry);
    if (this.disposed) {
      this.ptys.delete(ptyId);
      try {
        proc.kill();
      } catch {
      }
      throw new Error("pty pool disposed");
    }
    proc.onData((data) => {
      appendReplay(entry, data);
      if (entry.attachedCount > 0) onData(ptyId, data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.ptys.get(ptyId) === entry) this.ptys.delete(ptyId);
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

  write(ptyId: string, data: string): void {
    this.ptys.get(ptyId)?.proc.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.ptys.get(ptyId)?.proc.resize(cols, rows);
  }

  kill(ptyId: string): void {
    const entry = this.ptys.get(ptyId);
    if (!entry) return;
    this.ptys.delete(ptyId);
    entry.proc.kill();
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
    for (const ptyId of [...this.ptys.keys()]) this.kill(ptyId);
    this.pendingKills.clear();
  }

  reopen(): void {
    this.disposed = false;
  }
}
