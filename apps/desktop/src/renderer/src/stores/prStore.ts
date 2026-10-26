import { create } from "zustand";
import type { DriverName, GitHubKind, PrRef, WorkflowSubject } from "../cw.js";
import { prKey } from "../components/prInbox.js";
import type { SettingsSection } from "../components/settingsSections.js";
import { errorMessage } from "../components/errorMessage.js";
import { requestPrDetail } from "../components/usePrs.js";
import { useGitHubStore } from "./githubStore.js";

export type PrDetailTab = "conversation" | "commits" | "checks" | "files";

export type MainView =
  | { kind: "session" }
  | { kind: "github" }
  | { kind: "pr"; ref: PrRef; tab: PrDetailTab }
  | { kind: "usage" }
  | { kind: "settings"; section: SettingsSection; harness?: DriverName; workflowId?: string; projectId?: string };

export interface RunModalState {
  workflowId: string;
  subject: WorkflowSubject;
  continueSessionId?: string;
  promptOverride?: string;
}

interface PrState {
  diffByKey: Record<string, string>;
  diffLoadingByKey: Record<string, boolean>;
  diffErrorByKey: Record<string, string>;
  mainView: MainView;
  selectedPrKeyBySession: Record<string, string>;
  runModal: RunModalState | null;
  loadDiff(ref: PrRef, force?: boolean): Promise<void>;
  openGitHub(kind?: GitHubKind): void;
  openPr(ref: PrRef, tab?: PrDetailTab): void;
  selectSessionPr(sessionId: string, key: string | null): void;
  setPrTab(tab: PrDetailTab): void;
  openSessionView(): void;
  openUsage(): void;
  openSettings(section?: SettingsSection, harness?: DriverName): void;
  openWorkflowSettings(workflowId: string): void;
  openProjectSettings(projectId?: string): void;
  openRunModal(state: RunModalState): void;
  closeRunModal(): void;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const usePrStore = create<PrState>((set, get) => ({
  diffByKey: {},
  diffLoadingByKey: {},
  diffErrorByKey: {},
  mainView: { kind: "session" },
  selectedPrKeyBySession: {},
  runModal: null,

  async loadDiff(ref: PrRef, force?: boolean) {
    const key = prKey(ref);
    if (get().diffLoadingByKey[key]) return;
    if (!force && get().diffByKey[key] !== undefined) return;
    set({ diffLoadingByKey: { ...get().diffLoadingByKey, [key]: true } });
    try {
      const diff = await window.cw.getPrDiff(ref);
      set({
        diffByKey: { ...get().diffByKey, [key]: diff },
        diffLoadingByKey: without(get().diffLoadingByKey, key),
        diffErrorByKey: without(get().diffErrorByKey, key)
      });
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[pr] diff load failed for ${key}: ${message}`);
      set({
        diffLoadingByKey: without(get().diffLoadingByKey, key),
        diffErrorByKey: { ...get().diffErrorByKey, [key]: message }
      });
    }
  },

  openGitHub(kind?: GitHubKind) {
    if (kind) useGitHubStore.getState().setKind(kind);
    set({ mainView: { kind: "github" } });
  },

  openPr(ref: PrRef, tab: PrDetailTab = "conversation") {
    set({ mainView: { kind: "pr", ref, tab } });
    void requestPrDetail(ref);
  },

  selectSessionPr(sessionId: string, key: string | null) {
    const current = get().selectedPrKeyBySession;
    if (key === null) {
      set({ selectedPrKeyBySession: without(current, sessionId) });
      return;
    }
    if (current[sessionId] === key) return;
    set({ selectedPrKeyBySession: { ...current, [sessionId]: key } });
  },

  setPrTab(tab: PrDetailTab) {
    const view = get().mainView;
    if (view.kind !== "pr") return;
    set({ mainView: { ...view, tab } });
  },

  openSessionView() {
    if (get().mainView.kind === "session") return;
    set({ mainView: { kind: "session" } });
  },

  openUsage() {
    set({ mainView: { kind: "usage" } });
  },

  openSettings(section?: SettingsSection, harness?: DriverName) {
    set({ mainView: { kind: "settings", section: section ?? (harness ? "harness" : "general"), harness } });
  },

  openWorkflowSettings(workflowId: string) {
    set({ mainView: { kind: "settings", section: "prWorkflows", workflowId } });
  },

  openProjectSettings(projectId?: string) {
    set({ mainView: { kind: "settings", section: "projects", projectId } });
  },

  openRunModal(state: RunModalState) {
    set({ runModal: state });
  },

  closeRunModal() {
    set({ runModal: null });
  }
}));
