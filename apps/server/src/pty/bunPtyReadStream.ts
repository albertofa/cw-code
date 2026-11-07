import { close } from "node:fs";
import { Readable } from "node:stream";
import tty from "node:tty";
import type { PtyModule } from "./PtyPool.js";

/**
 * Reads a PTY master fd through Bun's poll-driven file reader.
 *
 * node-pty reads the master with `new tty.ReadStream(fd)`. Under Bun that stream treats the
 * EAGAIN of the non-blocking master as fatal: it emits `error`, destroys itself and closes the
 * fd, so the kernel hangs up the child right after spawn. `Bun.file(fd).stream()` waits for
 * readiness instead and, like Node, fails with EIO once the child side closes, which node-pty
 * already handles as a normal close. The fd is ours to close, as `tty.ReadStream` would.
 */
export class BunPtyReadStream extends Readable {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private reading = false;

  constructor(readonly fd: number) {
    super();
    this.reader = Bun.file(fd).stream().getReader();
  }

  override _read(): void {
    const reader = this.reader;
    if (!reader || this.reading) return;
    this.reading = true;
    reader.read().then(
      ({ done, value }) => {
        this.reading = false;
        if (this.destroyed) return;
        this.push(done ? null : Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      },
      (err: unknown) => {
        this.reading = false;
        if (!this.destroyed) this.destroy(err as Error);
      }
    );
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    const reader = this.reader;
    this.reader = null;
    const finish = () => close(this.fd, () => callback(err));
    if (!reader) return finish();
    reader.cancel().then(finish, finish);
  }
}

type TtyModule = { ReadStream: unknown };

/**
 * Wraps node-pty so each spawn reads its master through {@link BunPtyReadStream}. node-pty
 * constructs the read stream synchronously inside `spawn` through the shared `tty` module, so
 * the swap is confined to that call.
 */
export function withBunPtyReader(mod: PtyModule): PtyModule {
  return {
    spawn(file, args, opts) {
      const ttyModule = tty as unknown as TtyModule;
      const original = ttyModule.ReadStream;
      ttyModule.ReadStream = BunPtyReadStream;
      try {
        return mod.spawn(file, args, opts);
      } finally {
        ttyModule.ReadStream = original;
      }
    }
  };
}
