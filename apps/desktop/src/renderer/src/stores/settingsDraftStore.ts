import { create } from "zustand";
import type { AppSettings, CwApi } from "../cw.js";
import { errorMessage } from "../components/errorMessage.js";
import { useNotifs } from "../components/Notifications.js";
import { sameValue } from "../components/settingsSections.js";
import { useAppStore } from "./appStore.js";

export type HarnessCheck = Awaited<ReturnType<CwApi["checkVersions"]>>[number];

export interface RepoDraft {
  projectId: string;
  account: string;
  userName: string;
  userEmail: string;
  identityEditable: boolean;
}

interface SettingsDraftState {
  saved: AppSettings | null;
  draft: AppSettings | null;
  dirty: boolean;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  saveError: string | null;
  repoSaved: RepoDraft | null;
  repoDraft: RepoDraft | null;
  harnessChecks: HarnessCheck[] | null;
  harnessChecksLoading: boolean;
  harnessChecksError: string | null;
  load(): Promise<void>;
  set(patch: Partial<AppSettings>): void;
  applied(patch: Partial<AppSettings>): void;
  setRepoBaseline(repo: RepoDraft | null): void;
  setRepo(patch: Partial<RepoDraft>): void;
  discard(): void;
  save(): Promise<void>;
  recheckHarnesses(): Promise<void>;
}

function isDirty(state: Pick<SettingsDraftState, "saved" | "draft" | "repoSaved" | "repoDraft">): boolean {
  return !sameValue(state.draft, state.saved) || !sameValue(state.repoDraft, state.repoSaved);
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

let loadSeq = 0;
let checkSeq = 0;

export const useSettingsDraftStore = create<SettingsDraftState>((set, get) => ({
  saved: null,
  draft: null,
  dirty: false,
  loading: false,
  loadError: null,
  saving: false,
  saveError: null,
  repoSaved: null,
  repoDraft: null,
  harnessChecks: null,
  harnessChecksLoading: false,
  harnessChecksError: null,

  async load() {
    const request = ++loadSeq;
    set({ loading: true, loadError: null, saveError: null, saved: null, draft: null, repoSaved: null, repoDraft: null, dirty: false });
    try {
      const settings = await window.cw.getSettings();
      if (request !== loadSeq) return;
      set({ saved: settings, draft: settings, loading: false, dirty: false });
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

  discard() {
    set({ draft: get().saved, repoDraft: get().repoSaved, dirty: false, saveError: null });
  },

  async save() {
    const { draft, repoDraft, repoSaved, saving } = get();
    if (!draft || saving) return;
    set({ saving: true, saveError: null });
    try {
      const stored = await useAppStore.getState().saveSettings(draft);
      const current = get();
      const nextDraft = sameValue(current.draft, draft) ? stored : current.draft;
      set({ saved: stored, draft: nextDraft, dirty: isDirty({ ...current, saved: stored, draft: nextDraft }) });
      if (repoDraft && !sameValue(repoDraft, repoSaved)) {
        await saveRepo(repoDraft, repoSaved);
        const after = get();
        set({ repoSaved: repoDraft, dirty: isDirty({ ...after, repoSaved: repoDraft }) });
      }
      set({ saving: false });
    } catch (err) {
      const message = errorMessage(err);
      set({ saving: false, saveError: message });
      useNotifs.getState().push({ kind: "error", title: "Could not save settings", message });
    }
  },

  async recheckHarnesses() {
    const request = ++checkSeq;
    set({ harnessChecksLoading: true, harnessChecksError: null });
    try {
      const checks = await window.cw.checkVersions();
      if (request !== checkSeq) return;
      set({ harnessChecks: checks, harnessChecksLoading: false });
    } catch (err) {
      if (request !== checkSeq) return;
      const message = errorMessage(err);
      console.warn(`[settings] harness version check failed: ${message}`);
      set({ harnessChecksLoading: false, harnessChecksError: message || "Could not check installed harnesses" });
    }
  }
}));
