import "../../../../tests/dom.js";
import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { SessionMeta, SessionRow, UpdateActionResult, UpdateState } from "@cw-code/contracts";
import { DEFAULT_COMPOSER, useAppStore } from "./appStore.js";
import { applyAvailableHarnesses } from "../server/appBridge.js";
import { useNotifs } from "../components/Notifications.js";

const pushRecentModel = vi.fn(async () => {});

function installPushRecentModel(): void {
  pushRecentModel.mockClear();
  (window as unknown as { cw: unknown }).cw = { ...(window as unknown as { cw: object }).cw, pushRecentModel };
}

describe("appStore pending model per harness", () => {
  beforeEach(() => {
    installPushRecentModel();
    useAppStore.setState({
      activeProjectId: "proj_1",
      pendingDriver: "opencode",
      lastDriver: "opencode",
      availableHarnesses: null,
      pendingPrefs: { ...DEFAULT_COMPOSER }
    });
  });

  it("remembers the outgoing model and leaves the next harness model for the composer to pick", () => {
    useAppStore.setState({ pendingPrefs: { ...DEFAULT_COMPOSER, model: "alpha/m1" } });
    useAppStore.getState().setPendingDriver("claude");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
    expect(pushRecentModel).toHaveBeenCalledWith("opencode", "alpha/m1");
  });

  it("clears the model when the next harness has no remembered model", () => {
    useAppStore.setState({ pendingPrefs: { ...DEFAULT_COMPOSER, model: "sonnet" } });
    useAppStore.getState().setPendingDriver("codex");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
  });

  it("does not seed a recent model over the harness default when opening a new session", () => {
    useAppStore.setState({
      pendingDriver: "claude",
      lastDriver: "claude",
      pendingPrefs: { ...DEFAULT_COMPOSER, model: "sonnet" },
      defaultModelByDriver: { claude: "", opencode: "beta/m2", codex: "" }
    });
    useAppStore.getState().startNewSession("opencode");
    expect(useAppStore.getState().pendingDriver).toBe("opencode");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
    expect(pushRecentModel).toHaveBeenCalledWith("claude", "sonnet");
  });

  it("opens a new session on an installed harness when the requested one is not installed", () => {
    useAppStore.setState({ availableHarnesses: ["claude"] });
    useAppStore.getState().startNewSession("codex");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
  });

  it("moves the pending harness when availability drops it", () => {
    applyAvailableHarnesses(["claude", "codex"]);
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().lastDriver).toBe("claude");
  });
});

describe("appStore applySidebar", () => {
  const alpha = { id: "proj_a", rootPath: "C:/code/alpha", name: "alpha" };
  const beta = { id: "proj_b", rootPath: "C:/code/beta", name: "beta" };

  function row(session: SessionMeta): SessionRow {
    return {
      session,
      busy: false,
      branch: null,
      attention: null,
      babysit: null,
      prBadge: null,
      pendingQuestionIds: [],
      latestUnseenPrUpdateAt: null,
      prMuted: false
    };
  }

  function session(id: string, projectId: string, updatedAt: number, status: SessionMeta["status"] = "idle"): SessionMeta {
    return { id, projectId, driver: "claude", title: id, status, resumeCursor: "", createdAt: 1, updatedAt };
  }

  const opened: string[] = [];

  beforeEach(() => {
    opened.length = 0;
    (window as unknown as { cw: unknown }).cw = {
      openSession: async (sessionId: string, reason: string) => {
        opened.push(`${sessionId}:${reason}`);
      },
      getComposer: async () => ({})
    };
    useAppStore.setState({
      projects: [],
      sessionsByProject: {},
      projectsByRecency: [],
      sidebarLoaded: false,
      activeProjectId: null,
      activeSessionId: null,
      pendingDriver: null,
      lastDriver: "codex"
    });
  });

  it("groups rows by project, newest first, and keeps unchanged lists", () => {
    const older = session("sess_old", "proj_a", 1);
    const newer = session("sess_new", "proj_a", 2);
    const other = session("sess_b", "proj_b", 3);
    useAppStore.getState().applySidebar([alpha, beta], [row(older), row(other), row(newer)], null);
    const first = useAppStore.getState().sessionsByProject;
    expect(first.proj_a.map((s) => s.id)).toEqual(["sess_new", "sess_old"]);
    expect(first.proj_b.map((s) => s.id)).toEqual(["sess_b"]);

    const renamed = { ...other, title: "Renamed" };
    useAppStore.getState().applySidebar([alpha, beta], [row(older), row(renamed), row(newer)], null);
    const second = useAppStore.getState().sessionsByProject;
    expect(second.proj_a).toBe(first.proj_a);
    expect(second.proj_b).toEqual([renamed]);
  });

  it("keeps session identity when only the row fields change", () => {
    const stable = session("sess_a", "proj_a", 1);
    useAppStore.getState().applySidebar([alpha], [row(stable)], null);
    const first = useAppStore.getState().sessionsByProject;
    useAppStore.getState().applySidebar([alpha], [{ ...row({ ...stable }), busy: true, branch: "main" }], null);
    const second = useAppStore.getState().sessionsByProject;
    expect(second).toBe(first);
    expect(second.proj_a[0]).toBe(first.proj_a[0]);
  });

  it("waits for a snapshot with data before choosing the initial session", () => {
    const empty = { restoreSessionId: null, restoreProjectId: null, projectsByRecency: [] };
    useAppStore.getState().applySidebar([], [], empty);
    expect(useAppStore.getState()).toMatchObject({ sidebarLoaded: false, activeProjectId: null });
    useAppStore.getState().applySidebar([alpha, beta], [], { ...empty, restoreProjectId: "proj_b" });
    expect(useAppStore.getState()).toMatchObject({ sidebarLoaded: true, activeProjectId: "proj_b", activeSessionId: null });
  });

  it("restores the server's pick once and opens a finished session for restore", () => {
    const done = session("sess_done", "proj_b", 5, "done");
    const defaults = { restoreSessionId: "sess_done", restoreProjectId: "proj_b", projectsByRecency: ["proj_b", "proj_a"] };
    useAppStore.getState().applySidebar([alpha, beta], [row(done)], defaults);
    expect(useAppStore.getState()).toMatchObject({ activeProjectId: "proj_b", activeSessionId: "sess_done", pendingDriver: null });
    expect(useAppStore.getState().projectsByRecency).toEqual(["proj_b", "proj_a"]);
    expect(opened).toEqual(["sess_done:restore"]);

    useAppStore.setState({ activeProjectId: null, activeSessionId: null });
    useAppStore.getState().applySidebar([alpha, beta], [row(done)], defaults);
    expect(useAppStore.getState().activeSessionId).toBeNull();
    expect(opened).toEqual(["sess_done:restore"]);
  });

  it("opens the new-session form on the server's project when nothing can be restored", () => {
    const defaults = { restoreSessionId: null, restoreProjectId: "proj_b", projectsByRecency: [] };
    useAppStore.getState().applySidebar([alpha, beta], [], defaults);
    expect(useAppStore.getState()).toMatchObject({ activeProjectId: "proj_b", activeSessionId: null, pendingDriver: "codex" });
  });

  it("starts a new session in the most recent project when none is active", () => {
    installPushRecentModel();
    useAppStore.setState({ projects: [alpha, beta], projectsByRecency: ["proj_b", "proj_a"], activeProjectId: null });
    useAppStore.getState().startNewSession();
    expect(useAppStore.getState().activeProjectId).toBe("proj_b");
  });
});

describe("appStore preview per session", () => {
  beforeEach(() => {
    useAppStore.setState({ previewBySession: {} });
  });

  it("keeps preview targets independent and closes only the requested session", () => {
    useAppStore.getState().openPreview("sess_a", "src/a.ts", "C:\\a");
    useAppStore.getState().openPreview("sess_b", "src/b.ts", "C:\\b");
    const previews = useAppStore.getState().previewBySession;
    expect(previews.sess_a.path).toBe("src/a.ts");
    expect(previews.sess_b.path).toBe("src/b.ts");

    useAppStore.getState().closePreview("sess_a");
    const remaining = useAppStore.getState().previewBySession;
    expect(remaining.sess_a).toBeUndefined();
    expect(remaining.sess_b.path).toBe("src/b.ts");
  });
});

describe("appStore updates slice", () => {
  function updateState(seq: number, phase: UpdateState["phase"] = "idle"): UpdateState {
    return {
      seq,
      phase,
      runningVersion: "1.0.0",
      channel: "stable",
      availableVersion: null,
      downloadedVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      progress: null,
      checkedAt: null,
      error: null,
      disabledReason: null,
      autoDownload: false
    };
  }

  function installUpdatesBridge(snapshot: Promise<UpdateState>, result?: UpdateActionResult) {
    const calls: string[] = [];
    let emit: (state: UpdateState) => void = () => {};
    const updates = {
      onChanged: (cb: (state: UpdateState) => void) => {
        calls.push("onChanged");
        emit = cb;
        return () => calls.push("off");
      },
      getState: () => {
        calls.push("getState");
        return snapshot;
      },
      check: async () => result,
      download: async () => result,
      setChannel: async () => result
    };
    (window as unknown as { cw: { updates: typeof updates } }).cw = { updates };
    return { calls, emit: (state: UpdateState) => emit(state) };
  }

  beforeEach(() => {
    useAppStore.setState({ updates: null });
  });

  it("subscribes before fetching the snapshot and keeps the newest state", async () => {
    let resolveSnapshot: (state: UpdateState) => void = () => {};
    const bridge = installUpdatesBridge(new Promise((resolve) => (resolveSnapshot = resolve)));
    const off = useAppStore.getState().subscribeUpdates();
    expect(bridge.calls).toEqual(["onChanged", "getState"]);
    bridge.emit(updateState(3, "checking"));
    resolveSnapshot(updateState(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().updates).toMatchObject({ seq: 3, phase: "checking" });
    bridge.emit(updateState(1, "up-to-date"));
    expect(useAppStore.getState().updates?.seq).toBe(3);
    bridge.emit(updateState(4, "available"));
    expect(useAppStore.getState().updates).toMatchObject({ seq: 4, phase: "available" });
    off();
    expect(bridge.calls).toContain("off");
  });

  it("applies the state carried by action results through the same ordering rule", async () => {
    installUpdatesBridge(Promise.resolve(updateState(0)), {
      ok: false,
      code: "busy",
      message: "An update is downloading",
      state: updateState(7, "downloading")
    });
    useAppStore.getState().applyUpdateState(updateState(9, "ready"));
    const result = await useAppStore.getState().checkForUpdates();
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(useAppStore.getState().updates).toMatchObject({ seq: 9, phase: "ready" });
  });
});

describe("appStore project defaults", () => {
  const plain = { id: "proj_1", rootPath: "C:/code/plain", name: "plain" };
  const tuned = {
    id: "proj_2",
    rootPath: "C:/code/tuned",
    name: "tuned",
    settings: { defaultDriver: "claude" as const, defaultModel: "claude-opus-5-5[1m]", defaultEffort: "high" as const, defaultPermissionMode: "acceptEdits" as const }
  };

  beforeEach(() => {
    installPushRecentModel();
    useAppStore.setState({
      projects: [plain, tuned],
      sessionsByProject: { proj_1: [], proj_2: [] },
      activeProjectId: "proj_2",
      activeSessionId: null,
      pendingDriver: null,
      lastDriver: "opencode",
      availableHarnesses: null,
      pendingPrefs: { ...DEFAULT_COMPOSER, model: "alpha/m1" }
    });
  });

  it("starts a new session with the project's harness, model, effort and permission mode", () => {
    useAppStore.getState().startNewSession();
    const state = useAppStore.getState();
    expect(state.pendingDriver).toBe("claude");
    expect(state.pendingPrefs).toEqual({ model: "claude-opus-5-5[1m]", effort: "high", permissionMode: "acceptEdits" });
  });

  it("lets an explicit harness win and leaves its model to the composer", () => {
    useAppStore.getState().startNewSession("codex");
    const state = useAppStore.getState();
    expect(state.pendingDriver).toBe("codex");
    expect(state.pendingPrefs).toEqual({ model: undefined, effort: "high", permissionMode: "acceptEdits" });
  });

  it("applies the defaults when the new-session composer switches to the project, and keeps choices for projects without them", async () => {
    useAppStore.setState({ activeProjectId: "proj_1", pendingDriver: "opencode" });
    await useAppStore.getState().setPendingProject("proj_2");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().pendingPrefs.model).toBe("claude-opus-5-5[1m]");
    useAppStore.getState().setPendingPrefs({ effort: "low" });
    await useAppStore.getState().setPendingProject("proj_1");
    expect(useAppStore.getState().pendingDriver).toBe("claude");
    expect(useAppStore.getState().pendingPrefs).toEqual({ model: "claude-opus-5-5[1m]", effort: "low", permissionMode: "acceptEdits" });
  });

  it("falls back to an installed harness when the project's default is missing", () => {
    useAppStore.setState({ availableHarnesses: ["codex"] });
    useAppStore.getState().startNewSession();
    expect(useAppStore.getState().pendingDriver).toBe("codex");
    expect(useAppStore.getState().pendingPrefs.model).toBeUndefined();
  });
});

describe("appStore composer prefs loading", () => {
  const started: Array<{ sessionId: string; prefs: unknown }> = [];
  let composer: () => Promise<object>;

  beforeEach(() => {
    started.length = 0;
    composer = async () => {
      throw new Error("server down");
    };
    useNotifs.setState({ notifs: [] });
    useAppStore.setState({ composerBySession: {}, composerLoadedBySession: {} });
    (window as unknown as { cw: unknown }).cw = {
      getComposer: () => composer(),
      startTurn: async (sessionId: string, _prompt: string, input: { prefs: unknown }) => {
        started.push({ sessionId, prefs: input.prefs });
      }
    };
  });

  it("does not send with default prefs when they never loaded, and notifies once", async () => {
    await useAppStore.getState().ensureComposer("s1");
    await useAppStore.getState().ensureComposer("s1");
    expect(useNotifs.getState().notifs).toHaveLength(1);
    const [result] = await Promise.allSettled([useAppStore.getState().sendPromptTo("s1", "hello")]);
    expect(result.status).toBe("rejected");
    expect(started).toEqual([]);
  });

  it("retries an unloaded session before sending and on reconnect", async () => {
    await useAppStore.getState().ensureComposer("s1");
    composer = async () => ({ model: "opus", effort: "high" });
    await useAppStore.getState().reloadComposers();
    expect(useAppStore.getState().composerLoadedBySession.s1).toBe(true);
    await useAppStore.getState().sendPromptTo("s1", "hello");
    expect(started).toEqual([{ sessionId: "s1", prefs: { ...DEFAULT_COMPOSER, model: "opus", effort: "high" } }]);
  });

  it("loads unloaded prefs on send", async () => {
    composer = async () => ({ model: "sonnet" });
    await useAppStore.getState().sendPromptTo("s2", "hello");
    expect(started).toEqual([{ sessionId: "s2", prefs: { ...DEFAULT_COMPOSER, model: "sonnet" } }]);
  });
});
