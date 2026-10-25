import { describe, expect, test } from "bun:test";
import type { AppTopicData, ShutdownActiveTurn, TopicPatch } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { PtyPool, type PtyInstance, type PtyModule } from "../pty/PtyPool.js";
import { ShutdownCoordinator } from "../shutdown/ShutdownCoordinator.js";
import { TopicHub } from "../topics/TopicHub.js";
import type { CallContext } from "../transport/Router.js";
import { AppTopic } from "./AppTopic.js";
import { ShutdownPublisher } from "./ShutdownPublisher.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };
const SETTINGS = { ...DEFAULT_SETTINGS, claudeBinaryPath: process.execPath, codexBinaryPath: process.execPath };

class FakePty implements PtyInstance {
  private exitHandlers: Array<(e: { exitCode: number }) => void> = [];
  onData(): void {}
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitHandlers.push(cb);
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  exit(): void {
    for (const handler of this.exitHandlers) handler({ exitCode: 0 });
  }
}

function setup() {
  const spawned: FakePty[] = [];
  const module: PtyModule = {
    spawn: () => {
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    }
  };
  const ptys = new PtyPool(() => SETTINGS, async () => module);
  let activeTurns: ShutdownActiveTurn[] = [];
  const runtimeListeners = new Set<() => void>();
  const coordinator = new ShutdownCoordinator({
    sessions: {
      listShutdownTurns: () => activeTurns,
      backgroundTaskCount: () => 0,
      beginShutdownReservation() {},
      clearShutdownReservation() {},
      interrupt() {},
      cancelBackgroundWork() {},
      flush() {},
      shutdownDrivers: async () => ({ timedOut: [] }),
      forceStopDrivers() {},
      reinitializeDrivers() {}
    },
    ptys: {
      list: () => ptys.list(),
      beginShutdownReservation: () => ptys.beginShutdownReservation(),
      clearShutdownReservation: () => ptys.clearShutdownReservation(),
      dispose: () => ptys.dispose(),
      reopen: () => ptys.reopen()
    }
  });
  const patches: TopicPatch[] = [];
  const hub = new TopicHub((_clientIds, frame) => patches.push(JSON.parse(frame) as TopicPatch));
  const app = new AppTopic(hub, {
    settings: DEFAULT_SETTINGS,
    homeDir: "/home/me",
    shutdown: { status: { idle: true, committed: false, reason: null }, assessment: coordinator.assess() }
  });
  hub.register(app);
  const publisher = new ShutdownPublisher(() =>
    app.setShutdown({ idle: coordinator.isIdle(), committed: coordinator.isCommitted(), reason: coordinator.currentReason() }, coordinator.assess())
  );
  publisher.watch(
    (onChange) => {
      runtimeListeners.add(onChange);
      return () => runtimeListeners.delete(onChange);
    },
    (onChange) => ptys.onChanged(onChange)
  );
  const initial = hub.subscribe(ctx, [APP_TOPIC])[APP_TOPIC]?.data as AppTopicData;
  const settled = async () => {
    await Promise.resolve();
    patches.length = 0;
  };
  return {
    ptys,
    spawned,
    patches,
    publisher,
    initial,
    settled,
    setTurns: (turns: ShutdownActiveTurn[]) => {
      activeTurns = turns;
      for (const listener of runtimeListeners) listener();
    }
  };
}

const TURN: ShutdownActiveTurn = { sessionId: "s1", turnId: "t1", title: "One", startedAt: 5 };

function shutdownUpserts(patches: TopicPatch[]) {
  return patches.flatMap((patch) => patch.ops.filter((op) => op.op === "upsert" && op.key === "shutdown"));
}

describe("ShutdownPublisher", () => {
  test("a runtime change republishes app.shutdown with the new active turns", async () => {
    const { patches, setTurns, settled } = setup();
    await settled();
    setTurns([TURN]);
    await Promise.resolve();
    expect(shutdownUpserts(patches)).toMatchObject([{ value: { assessment: { activeTurns: [{ turnId: "t1" }] } } }]);
    setTurns([]);
    await Promise.resolve();
    expect(shutdownUpserts(patches)).toMatchObject([
      { value: { assessment: { activeTurns: [{ turnId: "t1" }] } } },
      { value: { assessment: { activeTurns: [] } } }
    ]);
  });

  test("pty changes republish the terminal list", async () => {
    const { ptys, spawned, patches, settled } = setup();
    await settled();
    await ptys.open("s1", ".", "shell", "", undefined, () => {});
    await Promise.resolve();
    expect(shutdownUpserts(patches)).toMatchObject([{ value: { assessment: { terminals: [{ ptyId: "s1:shell" }] } } }]);
    spawned[0].exit();
    await Promise.resolve();
    expect(shutdownUpserts(patches)).toMatchObject([
      { value: { assessment: { terminals: [{ ptyId: "s1:shell" }] } } },
      { value: { assessment: { terminals: [] } } }
    ]);
  });

  test("several changes in one tick publish once and an unchanged assessment publishes nothing", async () => {
    const { setTurns, patches, settled } = setup();
    await settled();
    setTurns([TURN]);
    setTurns([TURN]);
    setTurns([TURN]);
    await Promise.resolve();
    expect(shutdownUpserts(patches)).toHaveLength(1);
    setTurns([TURN]);
    await Promise.resolve();
    expect(shutdownUpserts(patches)).toHaveLength(1);
  });

  test("stops publishing after dispose", async () => {
    const { setTurns, publisher, patches, settled } = setup();
    await settled();
    publisher.dispose();
    setTurns([TURN]);
    await Promise.resolve();
    expect(shutdownUpserts(patches)).toEqual([]);
  });
});
