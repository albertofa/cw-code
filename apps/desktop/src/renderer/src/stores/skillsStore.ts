import { create } from "zustand";
import type { HarnessId, SkillDetail, SkillMeta, SkillSaveInput } from "@cw-code/contracts";
import { useNotifs } from "../components/Notifications.js";

export type SkillsStatus = "idle" | "loading" | "ready" | "error";

export function toggleKey(name: string, harness: HarnessId): string {
  return `${name}:${harness}`;
}

function detailToDraft(detail: SkillDetail): SkillSaveInput {
  return {
    name: detail.name,
    description: detail.description,
    body: detail.body,
    enabled: { ...detail.enabled }
  };
}

function newDraft(): SkillSaveInput {
  return {
    name: "",
    description: "",
    body: "",
    enabled: { claude: true, opencode: true, codex: true }
  };
}

function upsertItem(items: SkillMeta[], meta: SkillMeta): SkillMeta[] {
  const idx = items.findIndex((item) => item.name === meta.name);
  if (idx < 0) return [...items, meta].sort((a, b) => a.name.localeCompare(b.name));
  return items.map((item) => (item.name === meta.name ? meta : item));
}

interface SkillsState {
  items: SkillMeta[];
  filter: string;
  selectedName: string | null;
  detail: SkillDetail | null;
  draft: SkillSaveInput | null;
  dirty: boolean;
  pending: Record<string, boolean>;
  error: string | null;
  status: SkillsStatus;
  load(): Promise<void>;
  select(name: string | null): Promise<void>;
  setFilter(filter: string): void;
  setDraft(patch: Partial<SkillSaveInput>): void;
  toggle(name: string, harness: HarnessId, on: boolean): Promise<void>;
  saveDraft(input?: SkillSaveInput): Promise<void>;
  createNew(): void;
  importAll(): Promise<void>;
  clearError(): void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  items: [],
  filter: "",
  selectedName: null,
  detail: null,
  draft: null,
  dirty: false,
  pending: {},
  error: null,
  status: "idle",

  async load() {
    set({ status: get().items.length > 0 ? get().status : "loading", error: null });
    try {
      const result = await window.cw.skills.list();
      set({ items: result.skills, status: "ready", error: null });
    } catch (err) {
      const message = (err as Error).message;
      set({ status: "error", error: message });
      useNotifs.getState().push({ kind: "error", title: "Could not load skills", message });
    }
  },

  async select(name) {
    if (name === null) {
      set({ selectedName: null, detail: null, draft: null, dirty: false, error: null });
      return;
    }
    set({ selectedName: name, error: null });
    try {
      const detail = await window.cw.skills.get(name);
      if (get().selectedName !== name) return;
      set({ detail, draft: detailToDraft(detail), dirty: false, error: null });
    } catch (err) {
      const message = (err as Error).message;
      if (get().selectedName !== name) return;
      set({ detail: null, draft: null, dirty: false, error: message });
      useNotifs.getState().push({ kind: "error", title: `Could not load skill '${name}'`, message });
    }
  },

  setFilter(filter: string) {
    set({ filter });
  },

  setDraft(patch: Partial<SkillSaveInput>) {
    const current = get().draft;
    if (!current) return;
    set({
      draft: {
        ...current,
        ...patch,
        ...(patch.enabled ? { enabled: { ...current.enabled, ...patch.enabled } } : {})
      },
      dirty: true
    });
  },

  async toggle(name, harness, on) {
    const key = toggleKey(name, harness);
    const prevItems = get().items;
    const prevDetail = get().detail;
    const prev = prevItems.find((item) => item.name === name);
    if (!prev || prev.enabled[harness] === on) return;
    set({
      pending: { ...get().pending, [key]: true },
      error: null,
      items: prevItems.map((item) =>
        item.name === name ? { ...item, enabled: { ...item.enabled, [harness]: on } } : item
      ),
      ...(prevDetail && prevDetail.name === name
        ? {
            detail: { ...prevDetail, enabled: { ...prevDetail.enabled, [harness]: on } },
            draft: get().draft && get().draft?.name === name
              ? { ...get().draft as SkillSaveInput, enabled: { ...(get().draft as SkillSaveInput).enabled, [harness]: on } }
              : get().draft
          }
        : {})
    });
    try {
      const updated = await window.cw.skills.setEnabled(name, harness, on);
      const pending = { ...get().pending };
      delete pending[key];
      set({
        pending,
        items: upsertItem(get().items, updated),
        ...(get().detail && get().detail?.name === name
          ? { detail: { ...get().detail as SkillDetail, enabled: { ...updated.enabled } } }
          : {})
      });
    } catch (err) {
      const message = (err as Error).message;
      const pending = { ...get().pending };
      delete pending[key];
      set({ pending, items: prevItems, error: message, ...(prevDetail && prevDetail.name === name ? { detail: prevDetail } : {}) });
      useNotifs.getState().push({ kind: "error", title: `Could not ${on ? "enable" : "disable"} '${name}'`, message });
    }
  },

  async saveDraft(input) {
    const payload = input ?? get().draft;
    if (!payload) return;
    try {
      const saved = await window.cw.skills.save(payload);
      set({
        items: upsertItem(get().items, saved),
        selectedName: saved.name,
        detail: saved,
        draft: detailToDraft(saved),
        dirty: false,
        error: null
      });
    } catch (err) {
      const message = (err as Error).message;
      set({ error: message });
      useNotifs.getState().push({ kind: "error", title: `Could not save skill '${payload.name || "(new)"}'`, message });
    }
  },

  createNew() {
    set({ selectedName: null, detail: null, draft: newDraft(), dirty: false, error: null });
  },

  async importAll() {
    try {
      const result = await window.cw.skills.importAll();
      set({ items: result.skills, status: "ready", error: null });
    } catch (err) {
      const message = (err as Error).message;
      set({ error: message });
      useNotifs.getState().push({ kind: "error", title: "Could not import skills", message });
    }
  },

  clearError() {
    set({ error: null });
  }
}));
