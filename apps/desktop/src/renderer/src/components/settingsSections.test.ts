// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { AppSettings } from "../cw.js";
import { useSettingsDraftStore } from "../stores/settingsDraftStore.js";
import { useNotifs } from "./Notifications.js";
import {
  changedSections,
  filterSettingsNav,
  navIdOf,
  sameValue,
  sectionSummary,
  SETTINGS_NAV,
  settingsPatch,
  unsavedSectionLabels,
  viewOfNavId
} from "./settingsSections.js";

function settingsFixture(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    claudeBinaryPath: "claude",
    opencodeBinaryPath: "opencode",
    codexBinaryPath: "codex",
    claudeExtraArgs: "",
    opencodeExtraArgs: "",
    codexExtraArgs: "",
    claudeDefaultModel: "",
    codexDefaultModel: "",
    opencodeDefaultModel: "",
    claudeEnabledModels: ["claude-opus-5-5", "claude-sonnet-5-5"],
    claudeCustomModel: { id: "", name: "" },
    claudeReasoningExpanded: false,
    opencodeReasoningExpanded: false,
    codexReasoningExpanded: false,
    gitBinaryPath: "git",
    githubCliBinaryPath: "gh",
    sourceControlRefreshIntervalSeconds: 30,
    defaultUseWorktree: true,
    holdingAutoExpireEnabled: true,
    holdingHours: 24,
    prFinishedSessionStatus: "idle",
    idleResolveAfterDays: 30,
    autoTitleEnabled: true,
    autoTitleDriver: "claude",
    autoTitleModel: "",
    autoTitleEffort: "low",
    prRefreshIntervalSeconds: 120,
    prCloneRoot: "",
    prCloneIncludeOwner: true,
    prAttributionEnabled: true,
    prAttributionText: "— {{harness}} via cw-code",
    prWorkflows: [
      {
        id: "review",
        label: "Review",
        description: "",
        icon: "eye",
        builtIn: true,
        enabled: true,
        suggestWhen: ["review-requested"],
        workspace: "checkout",
        startPrompt: "start",
        updatePrompt: "update"
      }
    ],
    opencodeGoUsage: false,
    updateChannel: null,
    updateBackgroundDownload: true,
    fontFamilySans: "",
    fontFamilyMono: "",
    fontFamilyPrompt: "",
    fontFamilyTerminal: "",
    fontSizeInterface: 16,
    fontSizeCode: 14,
    fontSizePrompt: 14,
    fontSizeTerminal: 14,
    typographyAdvanced: false,
    panelAnimationMs: 180,
    ...overrides
  };
}

describe("sameValue", () => {
  it("compares objects by structure regardless of key order", () => {
    expect(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
  });

  it("treats a missing key and an undefined value as equal", () => {
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it("detects changed nested values, array order and length", () => {
    expect(sameValue({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue([1], [1, 1])).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });
});

describe("changedSections", () => {
  it("is empty when the draft only went through edits that were undone", () => {
    const saved = settingsFixture();
    const draft = { ...settingsFixture(), prWorkflows: saved.prWorkflows.map((w) => ({ ...w })) };
    expect(changedSections(saved, draft)).toEqual([]);
  });

  it("maps each changed key to its page in navigation order", () => {
    const saved = settingsFixture();
    const draft = settingsFixture({ codexExtraArgs: "--x", holdingHours: 12, fontSizeCode: 15, opencodeGoUsage: true });
    expect(changedSections(saved, draft)).toEqual(["general", "appearance", "opencode", "codex"]);
  });

  it("attributes workflow edits to PR workflows", () => {
    const saved = settingsFixture();
    const draft = settingsFixture({ prWorkflows: [{ ...saved.prWorkflows[0], startPrompt: "changed" }] });
    expect(changedSections(saved, draft)).toEqual(["prWorkflows"]);
  });
});

describe("settingsPatch", () => {
  it("holds only the keys whose values changed", () => {
    const saved = settingsFixture();
    const draft = settingsFixture({ holdingHours: 12, prWorkflows: [{ ...saved.prWorkflows[0], label: "Deep review" }] });
    expect(settingsPatch(saved, draft)).toEqual({ holdingHours: 12, prWorkflows: draft.prWorkflows });
    expect(settingsPatch(saved, settingsFixture())).toEqual({});
  });
});

describe("unsaved section labels", () => {
  it("names Source control when only the repository draft changed", () => {
    const saved = settingsFixture();
    expect(unsavedSectionLabels(saved, saved, true)).toEqual(["Source control"]);
    expect(unsavedSectionLabels(saved, settingsFixture({ holdingHours: 12 }), true)).toEqual(["General", "Source control"]);
    expect(unsavedSectionLabels(null, null, false)).toEqual([]);
  });

  it("joins section names for sentences", () => {
    expect(sectionSummary(["General"])).toBe("General");
    expect(sectionSummary(["General", "Updates"])).toBe("General and Updates");
    expect(sectionSummary(["General", "Updates", "Codex"])).toBe("General, Updates and Codex");
  });
});

describe("settings navigation", () => {
  it("filters items by label, case-insensitively", () => {
    expect(filterSettingsNav(SETTINGS_NAV, "  CODE ").map((item) => item.id)).toEqual(["claude", "opencode", "codex"]);
    expect(filterSettingsNav(SETTINGS_NAV, "source").map((item) => item.id)).toEqual(["sourceControl"]);
    expect(filterSettingsNav(SETTINGS_NAV, "")).toBe(SETTINGS_NAV);
    expect(filterSettingsNav(SETTINGS_NAV, "nothing")).toEqual([]);
  });

  it("round-trips harness pages and app sections", () => {
    expect(viewOfNavId("codex")).toEqual({ section: "harness", harness: "codex" });
    expect(viewOfNavId("prWorkflows")).toEqual({ section: "prWorkflows" });
    expect(navIdOf("harness", "opencode")).toBe("opencode");
    expect(navIdOf("harness", undefined)).toBe("claude");
    expect(navIdOf("updates", "codex")).toBe("updates");
  });
});

describe("settingsDraftStore", () => {
  const repo = { projectId: "p1", account: "", userName: "Ana", userEmail: "ana@example.com", identityEditable: true };

  beforeEach(() => {
    const saved = settingsFixture();
    useSettingsDraftStore.setState({ saved, draft: saved, dirty: false, repoSaved: null, repoDraft: null, saveError: null });
  });

  it("marks the draft dirty on a change and clean again when the change is undone", () => {
    const store = useSettingsDraftStore.getState();
    store.set({ holdingHours: 12 });
    expect(useSettingsDraftStore.getState().dirty).toBe(true);
    store.set({ holdingHours: 24 });
    expect(useSettingsDraftStore.getState().dirty).toBe(false);
  });

  it("keeps immediate-apply settings out of the unsaved changes", () => {
    const store = useSettingsDraftStore.getState();
    store.applied({ claudeBinaryPath: "C:/bin/claude.exe", updateChannel: "alpha" });
    const state = useSettingsDraftStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.draft?.claudeBinaryPath).toBe("C:/bin/claude.exe");
    expect(state.saved?.updateChannel).toBe("alpha");
  });

  it("keeps pending edits when an immediate setting applies", () => {
    const store = useSettingsDraftStore.getState();
    store.set({ codexExtraArgs: "--x" });
    store.applied({ gitBinaryPath: "C:/git/git.exe" });
    const state = useSettingsDraftStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.draft?.codexExtraArgs).toBe("--x");
    expect(state.draft?.gitBinaryPath).toBe("C:/git/git.exe");
  });

  it("tracks repository edits and discards them with the settings draft", () => {
    const store = useSettingsDraftStore.getState();
    store.setRepoBaseline(repo);
    expect(useSettingsDraftStore.getState().dirty).toBe(false);
    store.setRepo({ userName: "Bea" });
    store.set({ fontSizeCode: 15 });
    expect(useSettingsDraftStore.getState().dirty).toBe(true);
    useSettingsDraftStore.getState().discard();
    const state = useSettingsDraftStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.repoDraft).toEqual(repo);
    expect(state.draft?.fontSizeCode).toBe(14);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface SaveBridge {
  patches: Array<Partial<AppSettings>>;
  pending: Array<Deferred<AppSettings>>;
  identityCalls: Array<{ projectId: string; name: string; email: string }>;
  identityError: Error | null;
}

function installSaveBridge(): SaveBridge {
  const bridge: SaveBridge = { patches: [], pending: [], identityCalls: [], identityError: null };
  (window as unknown as { cw: unknown }).cw = {
    setSettings: (patch: Partial<AppSettings>) => {
      bridge.patches.push(patch);
      const next = deferred<AppSettings>();
      bridge.pending.push(next);
      return next.promise;
    },
    setRepositoryGitIdentity: async (projectId: string, name: string, email: string) => {
      bridge.identityCalls.push({ projectId, name, email });
      if (bridge.identityError) throw bridge.identityError;
    }
  };
  return bridge;
}

describe("settingsDraftStore save", () => {
  const repo = { projectId: "p1", account: "", userName: "Ana", userEmail: "ana@example.com", identityEditable: true };
  let bridge: SaveBridge;

  beforeEach(() => {
    bridge = installSaveBridge();
    useNotifs.setState({ notifs: [] });
    const saved = settingsFixture();
    useSettingsDraftStore.setState({ saved, draft: saved, dirty: false, saving: false, repoSaved: null, repoDraft: null, saveError: null });
  });

  it("sends only the changed keys and re-syncs saved from the stored value", async () => {
    const store = useSettingsDraftStore.getState();
    store.set({ holdingHours: 12, codexExtraArgs: " --x " });
    const saving = useSettingsDraftStore.getState().save();
    expect(bridge.patches).toEqual([{ holdingHours: 12, codexExtraArgs: " --x " }]);
    bridge.pending[0].resolve(settingsFixture({ holdingHours: 12, codexExtraArgs: "--x" }));
    await saving;
    const state = useSettingsDraftStore.getState();
    expect(state.saved?.codexExtraArgs).toBe("--x");
    expect(state.draft?.codexExtraArgs).toBe("--x");
    expect(state.dirty).toBe(false);
    expect(state.saving).toBe(false);
  });

  it("keeps edits and immediate settings made while the save is in flight", async () => {
    useSettingsDraftStore.getState().set({ holdingHours: 12 });
    const saving = useSettingsDraftStore.getState().save();
    useSettingsDraftStore.getState().set({ fontSizeCode: 15 });
    useSettingsDraftStore.getState().applied({ claudeBinaryPath: "C:/bin/claude.exe" });
    bridge.pending[0].resolve(settingsFixture({ holdingHours: 12 }));
    await saving;
    const state = useSettingsDraftStore.getState();
    expect(state.saved?.holdingHours).toBe(12);
    expect(state.saved?.claudeBinaryPath).toBe("C:/bin/claude.exe");
    expect(state.saved?.fontSizeCode).toBe(14);
    expect(state.draft?.fontSizeCode).toBe(15);
    expect(state.draft?.claudeBinaryPath).toBe("C:/bin/claude.exe");
    expect(state.dirty).toBe(true);
  });

  it("settles on the stored value when the draft is discarded during the save", async () => {
    const store = useSettingsDraftStore.getState();
    store.setRepoBaseline(repo);
    useSettingsDraftStore.getState().set({ holdingHours: 12 });
    useSettingsDraftStore.getState().setRepo({ userName: "Bea" });
    const saving = useSettingsDraftStore.getState().save();
    useSettingsDraftStore.getState().set({ fontSizeCode: 15 });
    useSettingsDraftStore.getState().discard();
    bridge.pending[0].resolve(settingsFixture({ holdingHours: 12 }));
    await saving;
    const state = useSettingsDraftStore.getState();
    expect(state.saved?.holdingHours).toBe(12);
    expect(state.draft).toEqual(state.saved);
    expect(state.repoDraft).toEqual(repo);
    expect(state.dirty).toBe(false);
    expect(bridge.identityCalls).toEqual([]);
  });

  it("keeps the repository dirty and says the settings were saved when only the repository step fails", async () => {
    useSettingsDraftStore.getState().setRepoBaseline(repo);
    useSettingsDraftStore.getState().set({ holdingHours: 12 });
    useSettingsDraftStore.getState().setRepo({ userName: "Bea" });
    bridge.identityError = new Error("config locked");
    const saving = useSettingsDraftStore.getState().save();
    bridge.pending[0].resolve(settingsFixture({ holdingHours: 12 }));
    await saving;
    const state = useSettingsDraftStore.getState();
    const expected = "Settings saved, but updating the repository failed: config locked";
    expect(bridge.identityCalls).toEqual([{ projectId: "p1", name: "Bea", email: "ana@example.com" }]);
    expect(state.saved?.holdingHours).toBe(12);
    expect(state.repoSaved).toEqual(repo);
    expect(state.repoDraft?.userName).toBe("Bea");
    expect(state.dirty).toBe(true);
    expect(state.saveError).toBe(expected);
    expect(useNotifs.getState().notifs.at(-1)?.message).toBe(expected);
    expect(unsavedSectionLabels(state.saved, state.draft, !sameValue(state.repoDraft, state.repoSaved))).toEqual(["Source control"]);
  });

  it("skips the settings write when only the repository changed", async () => {
    useSettingsDraftStore.getState().setRepoBaseline(repo);
    useSettingsDraftStore.getState().setRepo({ userEmail: "bea@example.com" });
    await useSettingsDraftStore.getState().save();
    const state = useSettingsDraftStore.getState();
    expect(bridge.patches).toEqual([]);
    expect(state.repoSaved?.userEmail).toBe("bea@example.com");
    expect(state.dirty).toBe(false);
  });
});
