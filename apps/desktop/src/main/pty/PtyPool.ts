import { randomUUID } from "node:crypto";
import type { AppSettings } from "@cw-code/contracts";
import { toShellTarget } from "./resolve.js";
import { parseExtraArgs } from "../settings/settingsUtils.js";
import { traceHarnessCall, truncateError } from "../debug/harnessTrace.js";

export type PtyKind = "claude" | "opencode" | "codex" | "shell";

interface PtyInstance {
  onData(cb: (data: string) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface PtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string }): PtyInstance;
}

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

export class PtyPool {
  private ptys = new Map<string, PtyInstance>();

  constructor(private getSettings: () => AppSettings) {}

  async open(
    _sessionId: string,
    cwd: string,
    kind: PtyKind,
    onData: (ptyId: string, data: string) => void
  ): Promise<string> {
    const ptyId = `pty_${randomUUID().slice(0, 8)}`;
    const start = Date.now();
    const operation = "pty.open";
    let pty: PtyModule;
    try {
      pty = await loadPty();
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
    let target: { file: string; args: string[] };
    try {
      target = toShellTarget(file, extra);
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
      proc = pty.spawn(target.file, target.args, { name: "xterm-256color", cols: 120, rows: 30, cwd });
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
    proc.onData((data) => onData(ptyId, data));
    this.ptys.set(ptyId, proc);
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
    return ptyId;
  }

  write(ptyId: string, data: string): void {
    this.ptys.get(ptyId)?.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.ptys.get(ptyId)?.resize(cols, rows);
  }

  kill(ptyId: string): void {
    try {
      this.ptys.get(ptyId)?.kill();
    } finally {
      this.ptys.delete(ptyId);
    }
  }

  dispose(): void {
    for (const ptyId of [...this.ptys.keys()]) this.kill(ptyId);
  }
}
