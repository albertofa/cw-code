import "../../tests/dom.js";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AppSettings, Project, ProjectSettings } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { projectDirty, useSettingsDraftStore } from "../stores/settingsDraftStore.js";
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
    claudeChromeEnabled: false,
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
        target: "pr",
        suggestWhen: ["review-requested"],
        workspace: "checkout",
        harness: { driver: null, model: "", effort: null, permissionMode: null },
        startPrompt: "start",
        updatePrompt: "update"
      }
    ],
    githubSavedViews: [],
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
    notificationSounds: {
      done: { enabled: true, sound: "felt-chord", volume: 60 },
      question: { enabled: true, sound: "triple-tap", volume: 60 },
      prUpdate: { enabled: true, sound: "tock-down", volume: 60 }
    },
    themeId: "dark",
    customThemes: [],
    serverBindHost: "",
    keepServerRunning: false,
    serverPublicUrl: "",
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

  it("attributes workflow edits to the Workflows page", () => {
    const saved = settingsFixture();
    const draft = settingsFixture({ prWorkflows: [{ ...saved.prWorkflows[0], startPrompt: "changed" }] });
    expect(changedSections(saved, draft)).toEqual(["prWorkflows"]);
  });

  it("attributes theme edits to the Appearance page", () => {
    const saved = settingsFixture();
    const customThemes = [{ id: "custom-a", name: "A", base: "light" as const, colors: { bg: "#ffffff" } }];
    const draft = settingsFixture({ themeId: "custom-a", customThemes });
    expect(changedSections(saved, draft)).toEqual(["appearance"]);
    expect(settingsPatch(saved, draft)).toEqual({ themeId: "custom-a", customThemes });
  });
});

describe("settingsPatch", () => {
  it("holds only the keys whose values changed", () => {
    const saved = settingsFixture();
    const draft = settingsFixture({ holdingHours: 12, prWorkflows: [{ ...saved.prWorkflows[0], label: "Deep review" }] });
    expect(settingsPatch(saved, draft)).toEqual({ holdingHours: 12, prWorkflows: draft.prWorkflows });
    expect(settingsPatch(saved, settingsFixture())).toEqual({});
  });

  it("never carries the saved views owned by the GitHub hub", () => {
    const saved = settingsFixture();
    const draft = settingsFixture({ githubSavedViews: [{ id: "v1", kind: "pr", name: "Mine", query: "author:@me", group: "none" }] });
    expect(settingsPatch(saved, draft)).toEqual({});
    expect(changedSections(saved, draft)).toEqual([]);
  });
});

describe("unsaved section labels", () => {
  it("names Projects when only a project draft changed", () => {
    const saved = settingsFixture();
    expect(unsavedSectionLabels(saved, saved, true)).toEqual(["Projects"]);
    expect(unsavedSectionLabels(saved, settingsFixture({ holdingHours: 12 }), true)).toEqual(["General", "Projects"]);
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
  projectCalls: Array<{ projectId: string; settings: ProjectSettings }>;
  projectError: Error | null;
}

const PROJECT: Project = { id: "p1", rootPath: "C:/code/app", name: "app" };

function installSaveBridge(): SaveBridge {
  const bridge: SaveBridge = { patches: [], pending: [], identityCalls: [], identityError: null, projectCalls: [], projectError: null };
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
    },
    updateProjectSettings: async (projectId: string, settings: ProjectSettings): Promise<Project> => {
      bridge.projectCalls.push({ projectId, settings });
      if (bridge.projectError) throw bridge.projectError;
      const trimmed = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]));
      return { ...PROJECT, settings: trimmed };
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
    useSettingsDraftStore.setState({
      saved,
      draft: saved,
      dirty: false,
      saving: false,
      repoSaved: null,
      repoDraft: null,
      projectSaved: null,
      projectDraft: null,
      saveError: null,
      invalidWorkflowId: null
    });
    useAppStore.setState({ projects: [PROJECT] });
  });

  it("saves project settings, drops cleared fields and rebases on the stored value", async () => {
    const store = useSettingsDraftStore.getState();
    store.setProjectBaseline({ projectId: "p1", settings: { setupScript: "bun install", titleInstructions: "" } });
    expect(useSettingsDraftStore.getState().dirty).toBe(false);
    store.setProjectSettings({ setupScript: "", branchInstructions: "feat/<summary>  ", defaultDriver: "codex" });
    expect(useSettingsDraftStore.getState().projectDraft?.settings).toEqual({ branchInstructions: "feat/<summary>  ", defaultDriver: "codex" });
    expect(useSettingsDraftStore.getState().dirty).toBe(true);
    await useSettingsDraftStore.getState().save();
    const state = useSettingsDraftStore.getState();
    expect(bridge.patches).toEqual([]);
    expect(bridge.projectCalls).toEqual([{ projectId: "p1", settings: { branchInstructions: "feat/<summary>  ", defaultDriver: "codex" } }]);
    expect(state.projectSaved).toEqual({ projectId: "p1", settings: { branchInstructions: "feat/<summary>", defaultDriver: "codex" } });
    expect(state.projectDraft).toEqual(state.projectSaved);
    expect(state.dirty).toBe(false);
    expect(useAppStore.getState().projects[0].settings?.defaultDriver).toBe("codex");
  });

  it("keeps the project draft dirty when saving the project settings fails", async () => {
    useSettingsDraftStore.getState().setProjectBaseline({ projectId: "p1", settings: {} });
    useSettingsDraftStore.getState().setProjectSettings({ destroyScript: "docker compose down" });
    bridge.projectError = new Error("disk full");
    await useSettingsDraftStore.getState().save();
    const state = useSettingsDraftStore.getState();
    expect(state.projectSaved?.settings).toEqual({});
    expect(state.projectDraft?.settings).toEqual({ destroyScript: "docker compose down" });
    expect(state.dirty).toBe(true);
    expect(state.saveError).toBe("disk full");
    expect(unsavedSectionLabels(state.saved, state.draft, projectDirty(state))).toEqual(["Projects"]);
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
    expect(unsavedSectionLabels(state.saved, state.draft, projectDirty(state))).toEqual(["Projects"]);
  });

  it("blocks the save and names the workflow when an edited prompt uses another target's variables", async () => {
    const saved = settingsFixture();
    useSettingsDraftStore.getState().set({ prWorkflows: [{ ...saved.prWorkflows[0], startPrompt: "{{issue.title}}" }] });
    await useSettingsDraftStore.getState().save();
    const state = useSettingsDraftStore.getState();
    expect(bridge.patches).toEqual([]);
    expect(state.invalidWorkflowId).toBe("review");
    expect(state.saveError).toContain("{{issue.title}}");
    expect(state.dirty).toBe(true);
  });

  it("saves an edited prompt whose unknown variables sit outside every target namespace", async () => {
    const saved = settingsFixture();
    const prWorkflows = [{ ...saved.prWorkflows[0], startPrompt: "{{ github.sha }}" }];
    useSettingsDraftStore.getState().set({ prWorkflows });
    const saving = useSettingsDraftStore.getState().save();
    expect(bridge.patches).toEqual([{ prWorkflows }]);
    bridge.pending[0].resolve(settingsFixture({ prWorkflows }));
    await saving;
    expect(useSettingsDraftStore.getState().invalidWorkflowId).toBeNull();
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
