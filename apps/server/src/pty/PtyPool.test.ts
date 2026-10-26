import { describe, expect, it } from "bun:test";
import type { AppSettings } from "@cw-code/contracts";
import { buildResumeArgs, PtyPool, type PtyInstance, type PtyModule } from "./PtyPool.js";
import { SHUTDOWN_RESERVED_MESSAGE } from "../shutdown/shutdownReservation.js";

describe("buildResumeArgs", () => {
  it("resumes claude sessions with --resume", () => {
    expect(buildResumeArgs("claude", "sess-1")).toEqual(["--resume", "sess-1"]);
  });

  it("resumes opencode sessions with --session", () => {
    expect(buildResumeArgs("opencode", "ses_1")).toEqual(["--session", "ses_1"]);
  });

  it("resumes codex sessions with the resume subcommand", () => {
    expect(buildResumeArgs("codex", "thread-1")).toEqual(["resume", "thread-1"]);
  });

  it("never resumes shell sessions", () => {
    expect(buildResumeArgs("shell", "sess-1")).toEqual([]);
  });

  it("adds no args when there is no cursor", () => {
    expect(buildResumeArgs("claude", "")).toEqual([]);
    expect(buildResumeArgs("opencode", "")).toEqual([]);
    expect(buildResumeArgs("codex", "")).toEqual([]);
  });
});

class FakePty implements PtyInstance {
  kills = 0;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  private dataHandlers: Array<(data: string) => void> = [];
  private exitHandlers: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (data: string) => void): void {
    this.dataHandlers.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitHandlers.push(cb);
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  emit(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }
  kill(): void {
    this.kills += 1;
  }
  exit(code: number): void {
    for (const handler of this.exitHandlers) handler({ exitCode: code });
  }
}

const SETTINGS = {
  claudeBinaryPath: process.execPath,
  opencodeBinaryPath: process.execPath,
  codexBinaryPath: process.execPath,
  claudeExtraArgs: "",
  opencodeExtraArgs: "",
  codexExtraArgs: ""
} as AppSettings;

function makePool() {
  const spawned: FakePty[] = [];
  let release: () => void = () => {};
  let gate: Promise<void> | null = null;
  const module: PtyModule = {
    spawn: () => {
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    }
  };
  const pool = new PtyPool(
    () => SETTINGS,
    async () => {
      if (gate) await gate;
      return module;
    }
  );
  const holdLoads = () => {
    gate = new Promise((resolve) => {
      release = resolve;
    });
  };
  return { pool, spawned, holdLoads, release: () => release() };
}

const noData = (): void => {};

describe("PtyPool shutdown support", () => {
  it("lists open terminals with their session and kind", async () => {
    const { pool } = makePool();
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    await pool.open("sess_b", ".", "claude", "cursor", undefined, noData);
    expect(pool.list()).toEqual([
      { ptyId: "sess_a:shell", sessionId: "sess_a", kind: "shell" },
      { ptyId: "sess_b:claude", sessionId: "sess_b", kind: "claude" }
    ]);
  });

  it("drops terminals that exit on their own from the list", async () => {
    const { pool, spawned } = makePool();
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    spawned[0].exit(0);
    expect(pool.list()).toEqual([]);
  });

  it("blocks new terminals during a shutdown reservation but still reattaches open ones", async () => {
    const { pool, spawned } = makePool();
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    pool.beginShutdownReservation();
    await expect(pool.open("sess_b", ".", "shell", "", undefined, noData)).rejects.toThrow(SHUTDOWN_RESERVED_MESSAGE);
    await expect(pool.open("sess_a", ".", "shell", "", undefined, noData)).resolves.toMatchObject({ ptyId: "sess_a:shell" });
    expect(spawned).toHaveLength(1);
    pool.clearShutdownReservation();
    await pool.open("sess_b", ".", "shell", "", undefined, noData);
    expect(spawned).toHaveLength(2);
  });

  it("refuses to spawn a terminal whose open was in flight when the reservation began", async () => {
    const { pool, spawned, holdLoads, release } = makePool();
    holdLoads();
    const pending = pool.open("sess_a", ".", "shell", "", undefined, noData);
    pool.beginShutdownReservation();
    release();
    await expect(pending).rejects.toThrow(SHUTDOWN_RESERVED_MESSAGE);
    expect(spawned).toHaveLength(0);
  });

  it("refuses to spawn a terminal whose open was in flight across a dispose and reopen", async () => {
    const { pool, spawned, holdLoads, release } = makePool();
    holdLoads();
    const pending = pool.open("sess_a", ".", "shell", "", undefined, noData);
    pool.dispose();
    pool.reopen();
    release();
    await expect(pending).rejects.toThrow("pty pool disposed");
    expect(spawned).toHaveLength(0);
    expect(pool.list()).toEqual([]);
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    expect(spawned).toHaveLength(1);
  });

  it("kills a terminal by its handle when the pool is disposed while it spawns", async () => {
    const spawned: FakePty[] = [];
    let pool: PtyPool | null = null;
    const module: PtyModule = {
      spawn: () => {
        const pty = new FakePty();
        spawned.push(pty);
        pool?.dispose();
        pool?.reopen();
        return pty;
      }
    };
    pool = new PtyPool(() => SETTINGS, async () => module);
    await expect(pool.open("sess_a", ".", "shell", "", undefined, noData)).rejects.toThrow("pty pool disposed");
    expect(spawned.map((pty) => pty.kills)).toEqual([1]);
    expect(pool.list()).toEqual([]);
  });

  it("kills each owned terminal once on dispose and accepts terminals again after reopen", async () => {
    const { pool, spawned } = makePool();
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    await pool.open("sess_a", ".", "codex", "", undefined, noData);
    pool.dispose();
    pool.dispose();
    expect(spawned.map((pty) => pty.kills)).toEqual([1, 1]);
    expect(pool.list()).toEqual([]);
    await expect(pool.open("sess_a", ".", "shell", "", undefined, noData)).rejects.toThrow("pty pool disposed");
    pool.beginShutdownReservation();
    await expect(pool.open("sess_a", ".", "shell", "", undefined, noData)).rejects.toThrow(SHUTDOWN_RESERVED_MESSAGE);
    pool.clearShutdownReservation();
    pool.reopen();
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    expect(pool.list()).toEqual([{ ptyId: "sess_a:shell", sessionId: "sess_a", kind: "shell" }]);
  });
});

describe("PtyPool reattach", () => {
  it("reattaches only the terminal with the same token and replays its output", async () => {
    const { pool, spawned } = makePool();
    const opened = await pool.open("sess_a", ".", "shell", "", undefined, noData);
    spawned[0].emit("hello");
    expect(pool.reattach("sess_a", "shell", opened.token)).toEqual({ ptyId: "sess_a:shell", token: opened.token, replay: "hello" });
    expect(pool.reattach("sess_a", "shell", "pty-other")).toBeNull();
    expect(pool.reattach("sess_a", "codex", opened.token)).toBeNull();
  });

  it("does not respawn a terminal that exited or was replaced", async () => {
    const { pool, spawned } = makePool();
    const first = await pool.open("sess_a", ".", "shell", "", undefined, noData);
    spawned[0].exit(0);
    expect(pool.reattach("sess_a", "shell", first.token)).toBeNull();
    const second = await pool.open("sess_a", ".", "shell", "", undefined, noData);
    expect(second.token).not.toBe(first.token);
    expect(pool.reattach("sess_a", "shell", first.token)).toBeNull();
    expect(spawned).toHaveLength(2);
  });
});

describe("PtyPool change notifications", () => {
  it("notifies when a terminal is added, exits, is killed or the pool is disposed", async () => {
    const { pool, spawned } = makePool();
    let changes = 0;
    const stop = pool.onChanged(() => (changes += 1));
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    expect(changes).toBe(1);
    spawned[0].exit(0);
    expect(changes).toBe(2);
    await pool.open("sess_a", ".", "codex", "", undefined, noData);
    pool.kill("sess_a:codex");
    expect(changes).toBe(4);
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    pool.dispose();
    expect(changes).toBe(6);
    stop();
    pool.reopen();
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    expect(changes).toBe(6);
  });
});

describe("PtyPool terminal launch", () => {
  function recordingPool(fail = false) {
    const spawns: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const ptys: FakePty[] = [];
    const pool = new PtyPool(
      () => SETTINGS,
      async () => ({
        spawn: (_file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
          if (fail) throw new Error("no pty");
          spawns.push({ args, env: opts.env });
          const pty = new FakePty();
          ptys.push(pty);
          return pty;
        }
      })
    );
    return { pool, spawns, ptys };
  }

  it("puts the driver's server arguments before the resume arguments and adds its env", async () => {
    const { pool, spawns } = recordingPool();
    let released = 0;
    await pool.open("s1", process.cwd(), "opencode", "ses_1", { BASE: "1" }, () => {}, async () => ({
      args: ["--server", "http://127.0.0.1:4100"],
      env: { OPENCODE_PASSWORD: "pw" },
      release: () => {
        released += 1;
      }
    }));
    expect(spawns[0].args.slice(-4)).toEqual(["--server", "http://127.0.0.1:4100", "--session", "ses_1"]);
    expect(spawns[0].env).toMatchObject({ BASE: "1", OPENCODE_PASSWORD: "pw" });
    expect(released).toBe(0);
  });

  it("releases the driver's lease once when the terminal exits or is killed", async () => {
    const { pool, ptys } = recordingPool();
    let released = 0;
    const launch = async () => ({ args: [], env: {}, release: () => (released += 1) });
    await pool.open("s1", process.cwd(), "opencode", "ses_1", undefined, () => {}, launch);
    ptys[0].exit(0);
    ptys[0].exit(0);
    expect(released).toBe(1);
    await pool.open("s2", process.cwd(), "opencode", "ses_2", undefined, () => {}, launch);
    pool.kill("s2:opencode");
    ptys[1].exit(1);
    expect(released).toBe(2);
  });

  it("releases the lease when the terminal fails to spawn", async () => {
    const { pool } = recordingPool(true);
    let released = 0;
    await expect(
      pool.open("s1", process.cwd(), "opencode", "ses_1", undefined, () => {}, async () => ({
        args: [],
        env: {},
        release: () => (released += 1)
      }))
    ).rejects.toThrow("PTY spawn failed");
    expect(released).toBe(1);
  });

  it("never asks the driver for shell terminals", async () => {
    const { pool } = recordingPool();
    let asked = false;
    await pool.open("s1", process.cwd(), "shell", "", undefined, () => {}, async () => {
      asked = true;
      return null;
    });
    expect(asked).toBe(false);
  });
});

describe("PtyPool clients", () => {
  it("forwards every chunk and returns everything so far as the replay", async () => {
    const { pool, spawned } = makePool();
    const forwarded: string[] = [];
    await pool.open("sess_a", ".", "shell", "", undefined, (_ptyId, data) => forwarded.push(data));
    spawned[0].emit("one ");
    spawned[0].emit("two");
    expect(forwarded).toEqual(["one ", "two"]);
    await expect(pool.open("sess_a", ".", "shell", "", undefined, noData)).resolves.toMatchObject({ replay: "one two" });
  });

  it("records a resize from a client that is not the latest without applying it", async () => {
    const { pool, spawned } = makePool();
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    pool.resize("sess_a:shell", "a", 100, 40);
    pool.resize("sess_a:shell", "b", 80, 24);
    expect(spawned[0].resizes).toEqual([[100, 40]]);
    pool.write("sess_a:shell", "b", "ls");
    expect(spawned[0].resizes).toEqual([[100, 40], [80, 24]]);
    expect(spawned[0].writes).toEqual(["ls"]);
    pool.detach("sess_a:shell", "b");
    expect(spawned[0].resizes).toEqual([[100, 40], [80, 24], [100, 40]]);
  });

  it("ignores sizes that are not integers between 1 and 1000", async () => {
    const { pool, spawned } = makePool();
    await pool.open("sess_a", ".", "shell", "", undefined, noData);
    pool.resize("sess_a:shell", "a", 0, 24);
    pool.resize("sess_a:shell", "a", 80, 1001);
    pool.resize("sess_a:shell", "a", 80.5, 24);
    expect(spawned[0].resizes).toEqual([]);
  });
});
