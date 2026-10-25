import { create } from "zustand";
import type { AppTopicData, HarnessAvailability } from "@cw-code/contracts";
import type { AppSettings, ProjectSettings } from "../cw.js";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { errorMessage } from "../components/errorMessage.js";
import { useNotifs } from "../components/Notifications.js";
import { workflowsValidationError } from "../components/prWorkflowEditor.js";
import { copySetting, SETTING_KEYS, sameValue, settingsPatch } from "../components/settingsSections.js";
import { readTopic } from "../server/topics.js";
import { useAppStore } from "./appStore.js";

export type HarnessCheck = HarnessAvailability["checks"][number];

export interface RepoDraft {
  projectId: string;
  account: string;
  userName: string;
  userEmail: string;
  identityEditable: boolean;
}

export interface ProjectDraft {
  projectId: string;
  settings: ProjectSettings;
}

interface SettingsDraftState {
  saved: AppSettings | null;
  draft: AppSettings | null;
  dirty: boolean;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  saveError: string | null;
  invalidWorkflowId: string | null;
  repoSaved: RepoDraft | null;
  repoDraft: RepoDraft | null;
  projectSaved: ProjectDraft | null;
  projectDraft: ProjectDraft | null;
  harnessChecks: HarnessCheck[] | null;
  harnessChecksLoading: boolean;
  harnessChecksError: string | null;
  load(): Promise<void>;
  set(patch: Partial<AppSettings>): void;
  applied(patch: Partial<AppSettings>): void;
  applyStored(stored: AppSettings): void;
  applyHarnesses(availability: HarnessAvailability): void;
  setRepoBaseline(repo: RepoDraft | null): void;
  setRepo(patch: Partial<RepoDraft>): void;
  setProjectBaseline(project: ProjectDraft | null): void;
  setProjectSettings(patch: Partial<ProjectSettings>): void;
  discard(): void;
  save(): Promise<void>;
  clearInvalidWorkflow(): void;
  recheckHarnesses(): Promise<void>;
}

type DraftSnapshot = Pick<SettingsDraftState, "saved" | "draft" | "repoSaved" | "repoDraft" | "projectSaved" | "projectDraft">;

export function projectDirty(state: Omit<DraftSnapshot, "saved" | "draft">): boolean {
  return !sameValue(state.repoDraft, state.repoSaved) || !sameValue(state.projectDraft, state.projectSaved);
}

function isDirty(state: DraftSnapshot): boolean {
  return !sameValue(state.draft, state.saved) || projectDirty(state);
}

function withoutEmpty(settings: ProjectSettings): ProjectSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined && value !== "")) as ProjectSettings;
}

export function accountKey(account: { host: string; login: string } | undefined): string {
  return account ? `${account.host}\t${account.login}` : "";
}

async function saveRepo(next: RepoDraft, previous: RepoDraft | null): Promise<void> {
  const app = useAppStore.getState();
  if (next.account !== (previous?.account ?? "")) {
    const [host, login] = next.account.split("\t");
    await app.setProjectGitHubAccount(next.projectId, host && login ? { host, login } : null);
  }
  const name = next.userName.trim();
  const email = next.userEmail.trim();
  if (next.identityEditable && (name !== (previous?.userName.trim() ?? "") || email !== (previous?.userEmail.trim() ?? ""))) {
    await window.cw.setRepositoryGitIdentity(next.projectId, name, email);
  }
}

function rebaseOnStored(
  stored: AppSettings,
  patch: Partial<AppSettings>,
  start: { saved: AppSettings; draft: AppSettings },
  current: { saved: AppSettings; draft: AppSettings }
): { saved: AppSettings; draft: AppSettings } {
  const saved = { ...stored };
  const draft = { ...stored };
  for (const key of SETTING_KEYS) {
    if (!(key in patch) && !sameValue(current.saved[key], start.saved[key])) copySetting(saved, current.saved, key);
    copySetting(draft, sameValue(current.draft[key], start.draft[key]) ? saved : current.draft, key);
  }
  return { saved, draft };
}

let loadSeq = 0;
let checkSeq = 0;
let discardedDuringSave = false;

export const useSettingsDraftStore = create<SettingsDraftState>((set, get) => ({
  saved: null,
  draft: null,
  dirty: false,
  loading: false,
  loadError: null,
  saving: false,
  saveError: null,
  invalidWorkflowId: null,
  repoSaved: null,
  repoDraft: null,
  projectSaved: null,
  projectDraft: null,
  harnessChecks: null,
  harnessChecksLoading: false,
  harnessChecksError: null,

  async load() {
    const request = ++loadSeq;
    set({ loading: true, loadError: null, saveError: null, invalidWorkflowId: null, saved: null, draft: null, repoSaved: null, repoDraft: null, projectSaved: null, projectDraft: null, dirty: false });
    try {
      const state = readTopic<Partial<AppTopicData>>(APP_TOPIC);
      if (state?.status === "error" && !state.data.settings) throw new Error(state.error ?? "Settings are unavailable");
      if (request !== loadSeq) return;
      if (state?.data.settings) set({ saved: state.data.settings, draft: state.data.settings, loading: false, dirty: false });
    } catch (err) {
      if (request !== loadSeq) return;
      const message = errorMessage(err);
      console.warn(`[settings] load failed: ${message}`);
      set({ loading: false, loadError: message });
    }
  },

  set(patch: Partial<AppSettings>) {
    const draft = get().draft;
    if (!draft) return;
    const next = { ...get(), draft: { ...draft, ...patch } };
    set({ draft: next.draft, dirty: isDirty(next) });
  },

  applied(patch: Partial<AppSettings>) {
    const { saved, draft } = get();
    if (!saved || !draft) return;
    const next = { ...get(), saved: { ...saved, ...patch }, draft: { ...draft, ...patch } };
    set({ saved: next.saved, draft: next.draft, dirty: isDirty(next) });
  },

  applyStored(stored: AppSettings) {
    const { saved, draft, saving } = get();
    if (!saved || !draft) {
      set({ saved: stored, draft: stored, loading: false, loadError: null, dirty: false });
      return;
    }
    if (saving) return;
    const next = { saved: { ...stored }, draft: { ...stored } };
    for (const key of SETTING_KEYS) {
      if (!sameValue(draft[key], saved[key])) copySetting(next.draft, draft, key);
    }
    set({ saved: next.saved, draft: next.draft, dirty: isDirty({ ...get(), saved: next.saved, draft: next.draft }) });
  },

  applyHarnesses(availability: HarnessAvailability) {
    if (availability.checkedAt === null && availability.error === null) return;
    set({
      ...(availability.checkedAt !== null ? { harnessChecks: availability.checks } : {}),
      harnessChecksError: availability.error
    });
  },

  setRepoBaseline(repo: RepoDraft | null) {
    const next = { ...get(), repoSaved: repo, repoDraft: repo };
    set({ repoSaved: repo, repoDraft: repo, dirty: isDirty(next) });
  },

  setRepo(patch: Partial<RepoDraft>) {
    const repoDraft = get().repoDraft;
    if (!repoDraft) return;
    const next = { ...get(), repoDraft: { ...repoDraft, ...patch } };
    set({ repoDraft: next.repoDraft, dirty: isDirty(next) });
  },

  setProjectBaseline(project: ProjectDraft | null) {
    const baseline = project ? { projectId: project.projectId, settings: withoutEmpty(project.settings) } : null;
    const next = { ...get(), projectSaved: baseline, projectDraft: baseline };
    set({ projectSaved: baseline, projectDraft: baseline, dirty: isDirty(next) });
  },

  setProjectSettings(patch: Partial<ProjectSettings>) {
    const projectDraft = get().projectDraft;
    if (!projectDraft) return;
    const next = { ...get(), projectDraft: { ...projectDraft, settings: withoutEmpty({ ...projectDraft.settings, ...patch }) } };
    set({ projectDraft: next.projectDraft, dirty: isDirty(next) });
  },

  discard() {
    if (get().saving) discardedDuringSave = true;
    set({ draft: get().saved, repoDraft: get().repoSaved, projectDraft: get().projectSaved, dirty: false, saveError: null, invalidWorkflowId: null });
  },

  async save() {
    const { saved, draft, repoDraft, repoSaved, projectDraft, projectSaved, saving } = get();
    if (!saved || !draft || saving) return;
    const workflowError = workflowsValidationError(draft.prWorkflows, saved.prWorkflows);
    if (workflowError) {
      set({ saveError: workflowError.message, invalidWorkflowId: workflowError.workflowId });
      return;
    }
    const patch = settingsPatch(saved, draft);
    const settingsChanged = Object.keys(patch).length > 0;
    discardedDuringSave = false;
    set({ saving: true, saveError: null, invalidWorkflowId: null });
    try {
      if (settingsChanged) {
        const stored = await useAppStore.getState().saveSettings(patch);
        const current = get();
        if (current.saved && current.draft) {
          const next = rebaseOnStored(stored, patch, { saved, draft }, { saved: current.saved, draft: current.draft });
          const nextDraft = discardedDuringSave ? next.saved : next.draft;
          set({ saved: next.saved, draft: nextDraft, dirty: isDirty({ ...current, saved: next.saved, draft: nextDraft }) });
        }
      }
    } catch (err) {
      const message = errorMessage(err);
      set({ saving: false, saveError: message });
      useNotifs.getState().push({ kind: "error", title: "Could not save settings", message });
      return;
    }
    if (repoDraft && !discardedDuringSave && !sameValue(repoDraft, repoSaved)) {
      try {
        await saveRepo(repoDraft, repoSaved);
        const after = get();
        const nextRepoDraft = discardedDuringSave ? repoDraft : after.repoDraft;
        set({ repoSaved: repoDraft, repoDraft: nextRepoDraft, dirty: isDirty({ ...after, repoSaved: repoDraft, repoDraft: nextRepoDraft }) });
      } catch (err) {
        const reason = errorMessage(err);
        const message = settingsChanged ? `Settings saved, but updating the repository failed: ${reason}` : reason;
        set({ saving: false, saveError: message });
        useNotifs.getState().push({ kind: "error", title: "Could not update the repository", message });
        return;
      }
    }
    if (projectDraft && !discardedDuringSave && !sameValue(projectDraft, projectSaved)) {
      try {
        await useAppStore.getState().updateProjectSettings(projectDraft.projectId, projectDraft.settings);
        const stored = useAppStore.getState().projects.find((project) => project.id === projectDraft.projectId)?.settings ?? {};
        const baseline = { projectId: projectDraft.projectId, settings: withoutEmpty(stored) };
        const after = get();
        const nextProjectDraft = discardedDuringSave || sameValue(after.projectDraft, projectDraft) ? baseline : after.projectDraft;
        set({ projectSaved: baseline, projectDraft: nextProjectDraft, dirty: isDirty({ ...after, projectSaved: baseline, projectDraft: nextProjectDraft }) });
      } catch (err) {
        const message = errorMessage(err);
        set({ saving: false, saveError: message });
        useNotifs.getState().push({ kind: "error", title: "Could not save the project settings", message });
        return;
      }
    }
    set({ saving: false });
  },

  clearInvalidWorkflow() {
    set({ invalidWorkflowId: null });
  },

  async recheckHarnesses() {
    const request = ++checkSeq;
    set({ harnessChecksLoading: true, harnessChecksError: null });
    try {
      const availability = await window.cw.recheckClis();
      if (request !== checkSeq) return;
      if (availability.error !== null) throw new Error(availability.error);
      set({ harnessChecks: availability.checks, harnessChecksLoading: false });
    } catch (err) {
      if (request !== checkSeq) return;
      const message = errorMessage(err);
      console.warn(`[settings] harness version check failed: ${message}`);
      set({ harnessChecksLoading: false, harnessChecksError: message || "Could not check installed harnesses" });
    }
  }
}));
