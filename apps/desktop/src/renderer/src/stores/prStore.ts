import { create } from "zustand";
import type { PrDetail, PrInboxResult, PrRef, ProjectGitHubRepo } from "../cw.js";
import { prKey } from "../components/prInbox.js";
import { errorMessage } from "../components/errorMessage.js";

export type PrDetailTab = "conversation" | "commits" | "checks" | "files";

export type MainView = { kind: "session" } | { kind: "inbox" } | { kind: "pr"; ref: PrRef; tab: PrDetailTab };

export interface RunModalState {
  workflowId: string;
  ref: PrRef;
  continueSessionId?: string;
  promptOverride?: string;
}

interface PrState {
  inbox: PrInboxResult | null;
  inboxLoading: boolean;
  inboxError: string | null;
  detailByKey: Record<string, PrDetail>;
  detailLoadingByKey: Record<string, boolean>;
  detailErrorByKey: Record<string, string>;
  diffByKey: Record<string, string>;
  diffLoadingByKey: Record<string, boolean>;
  diffErrorByKey: Record<string, string>;
  mainView: MainView;
  projectRepos: ProjectGitHubRepo[];
  runModal: RunModalState | null;
  refreshInbox(force?: boolean): Promise<void>;
  loadDetail(ref: PrRef): Promise<void>;
  loadDiff(ref: PrRef, force?: boolean): Promise<void>;
  openInbox(): void;
  openPr(ref: PrRef, tab?: PrDetailTab): void;
  setPrTab(tab: PrDetailTab): void;
  openSessionView(): void;
  refreshProjectRepos(): Promise<void>;
  projectIdForRef(ref: PrRef): string | null;
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
  inbox: null,
  inboxLoading: false,
  inboxError: null,
  detailByKey: {},
  detailLoadingByKey: {},
  detailErrorByKey: {},
  diffByKey: {},
  diffLoadingByKey: {},
  diffErrorByKey: {},
  mainView: { kind: "session" },
  projectRepos: [],
  runModal: null,

  async refreshInbox(force?: boolean) {
    if (get().inboxLoading) return;
    set({ inboxLoading: true });
    void get().refreshProjectRepos();
    try {
      const inbox = await window.cw.getPrInbox(force);
      set({ inbox, inboxLoading: false, inboxError: null });
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[pr] inbox refresh failed: ${message}`);
      set({ inboxLoading: false, inboxError: message });
    }
  },

  async loadDetail(ref: PrRef) {
    const key = prKey(ref);
    if (get().detailLoadingByKey[key]) return;
    set({ detailLoadingByKey: { ...get().detailLoadingByKey, [key]: true } });
    try {
      const detail = await window.cw.getPrDetail(ref);
      set({
        detailByKey: { ...get().detailByKey, [key]: detail },
        detailLoadingByKey: without(get().detailLoadingByKey, key),
        detailErrorByKey: without(get().detailErrorByKey, key)
      });
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[pr] detail load failed for ${key}: ${message}`);
      set({
        detailLoadingByKey: without(get().detailLoadingByKey, key),
        detailErrorByKey: { ...get().detailErrorByKey, [key]: message }
      });
    }
  },

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

  openInbox() {
    set({ mainView: { kind: "inbox" } });
    if (!get().inbox && !get().inboxLoading) void get().refreshInbox();
  },

  openPr(ref: PrRef, tab: PrDetailTab = "conversation") {
    set({ mainView: { kind: "pr", ref, tab } });
    void get().loadDetail(ref);
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

  async refreshProjectRepos() {
    try {
      set({ projectRepos: await window.cw.getProjectGitHubRepos() });
    } catch (err) {
      console.warn(`[pr] project repo lookup failed: ${errorMessage(err)}`);
    }
  },

  projectIdForRef(ref: PrRef) {
    const owner = ref.owner.toLowerCase();
    const repo = ref.repo.toLowerCase();
    const match = get().projectRepos.find(
      (item) => item.host.toLowerCase() === ref.host.toLowerCase() && item.owner.toLowerCase() === owner && item.repo.toLowerCase() === repo
    );
    return match?.projectId ?? null;
  },

  openRunModal(state: RunModalState) {
    set({ runModal: state });
  },

  closeRunModal() {
    set({ runModal: null });
  }
}));
