// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShutdownAssessment, UpdateActionResult, UpdateInstallRequest, UpdateState } from "../cw.js";
import { useNotifs } from "../components/Notifications.js";
import { useAppStore } from "./appStore.js";
import { useEditorBuffers } from "./editorBuffers.js";
import { runShutdownFlow, shutdownCancel } from "./shutdownFlow.js";
import { restartToUpdate } from "./updateFlow.js";

const EMPTY: ShutdownAssessment = { activeTurns: [], backgroundTasks: 0, terminals: [] };
const BUSY: ShutdownAssessment = {
  activeTurns: [{ sessionId: "sess_a", turnId: "t1", title: "work", startedAt: 1 }],
  backgroundTasks: 0,
  terminals: []
};

function ready(seq: number, patch: Partial<UpdateState> = {}): UpdateState {
  return {
    seq,
    phase: "ready",
    runningVersion: "1.0.0",
    channel: "stable",
    availableVersion: "1.1.0",
    downloadedVersion: "1.1.0",
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    checkedAt: 1,
    error: null,
    disabledReason: null,
    autoDownload: true,
    ...patch
  };
}

interface FakeBridge {
  states: UpdateState[];
  assessments: ShutdownAssessment[];
  installs: UpdateInstallRequest[];
  installResult: UpdateActionResult | Error;
  prepares: number;
  cancels: string[];
}

function installBridge(): FakeBridge {
  const bridge: FakeBridge = {
    states: [],
    assessments: [],
    installs: [],
    installResult: new Error("not configured"),
    prepares: 0,
    cancels: []
  };
  (window as unknown as { cw: unknown }).cw = {
    updates: {
      getState: async () => bridge.states.shift() ?? ready(1),
      install: async (request: UpdateInstallRequest) => {
        bridge.installs.push(request);
        if (bridge.installResult instanceof Error) throw bridge.installResult;
        return bridge.installResult;
      }
    },
    shutdown: {
      assess: async () => bridge.assessments.shift() ?? EMPTY,
      prepare: async () => {
        bridge.prepares += 1;
        return { ok: true, token: `token-${bridge.prepares}` };
      },
      cancel: async (token: string) => {
        bridge.cancels.push(token);
      }
    }
  };
  return bridge;
}

function notifs() {
  return useNotifs.getState().notifs;
}

describe("restartToUpdate", () => {
  let bridge: FakeBridge;

  beforeEach(() => {
    bridge = installBridge();
    useAppStore.setState({ updates: ready(1), updateRestartPending: false, shutdown: null, busyTurns: {} });
    useEditorBuffers.setState({ buffers: {} });
    useNotifs.setState({ notifs: [] });
  });

  afterEach(async () => {
    await shutdownCancel();
  });

  it("installs the downloaded version with the prepared token", async () => {
    bridge.installResult = { ok: true, state: ready(3, { phase: "installing" }) };
    await restartToUpdate();
    expect(bridge.prepares).toBe(1);
    expect(bridge.installs).toEqual([{ version: "1.1.0", channel: "stable", token: "token-1" }]);
    expect(bridge.cancels).toEqual([]);
    expect(useAppStore.getState().updateRestartPending).toBe(false);
  });

  it("does not stop anything when the update already changed before preparing", async () => {
    bridge.states = [ready(2, { downloadedVersion: "1.2.0", availableVersion: "1.2.0" })];
    await restartToUpdate();
    expect(bridge.prepares).toBe(0);
    expect(bridge.installs).toEqual([]);
    expect(notifs()[0]).toMatchObject({ title: "The update changed" });
  });

  it("releases the token when the update changed while preparing", async () => {
    bridge.states = [ready(2), ready(3, { phase: "available", availableVersion: "1.2.0" })];
    await restartToUpdate();
    expect(bridge.prepares).toBe(1);
    expect(bridge.cancels).toEqual(["token-1"]);
    expect(bridge.installs).toEqual([]);
  });

  it("releases the token when the install call throws", async () => {
    bridge.installResult = new Error("channel closed");
    await restartToUpdate();
    expect(bridge.cancels).toEqual(["token-1"]);
    expect(notifs()).toHaveLength(1);
    expect(notifs()[0]).toMatchObject({ kind: "error", message: "channel closed" });
  });

  it("raises a single toast for a repeated install failure", async () => {
    bridge.installResult = { ok: false, code: "failed", message: "installer missing", state: ready(5, { error: { message: "installer missing", context: "install", retryable: true } }) };
    await restartToUpdate();
    bridge.installResult = { ok: false, code: "failed", message: "installer missing", state: ready(6, { error: { message: "installer missing", context: "install", retryable: true } }) };
    await restartToUpdate();
    expect(bridge.installs).toHaveLength(2);
    expect(notifs().filter((notif) => notif.kind === "error")).toHaveLength(1);
    expect(useAppStore.getState().updates?.error?.context).toBe("install");
  });

  it("does nothing while a restart is pending, before an update is ready, or after the installer started", async () => {
    useAppStore.setState({ updateRestartPending: true });
    await restartToUpdate();
    useAppStore.setState({ updateRestartPending: false, updates: ready(2, { phase: "available", downloadedVersion: null }) });
    await restartToUpdate();
    useAppStore.setState({ updates: ready(3, { error: { message: "started", context: "install", retryable: false } }) });
    await restartToUpdate();
    expect(bridge.prepares).toBe(0);
    expect(bridge.installs).toEqual([]);
  });

  it("refuses while another quit or restart flow is open", async () => {
    bridge.assessments = [BUSY];
    void runShutdownFlow("quit");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await restartToUpdate();
    expect(bridge.prepares).toBe(0);
    expect(notifs()[0]).toMatchObject({ title: "Already closing" });
  });
});
