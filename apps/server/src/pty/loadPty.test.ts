import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { waitFor } from "../../tests/testing.js";
import { loadPty } from "./PtyPool.js";

describe.skipIf(process.platform === "win32")("loadPty on POSIX", () => {
  it("keeps a spawned shell attached to its terminal and reports its exit code", async () => {
    const pty = await loadPty();
    const proc = pty.spawn("/bin/sh", [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ " }
    });
    let output = "";
    proc.onData((data) => {
      output += data;
    });
    const exited = new Promise<number>((resolve) => proc.onExit(({ exitCode }) => resolve(exitCode)));

    proc.resize(100, 30);
    proc.write("[ -t 0 ] && echo tty-$((40+2)); stty size\r");
    await waitFor(
      () => {
        expect(output).toContain("tty-42");
        expect(output).toContain("30 100");
      },
      { timeout: 5000 }
    );

    proc.write("exit 7\r");
    expect(await exited).toBe(7);
  });
});
