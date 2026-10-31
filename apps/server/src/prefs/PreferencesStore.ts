import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { ComposerDraft, DriverKind, LegacyPreferences, SidebarOrderPrefs } from "@cw-code/contracts";
import { DRIVER_KINDS } from "@cw-code/shared/driverKinds";
import { readBytesIfExists, writeFileAtomic } from "../storage/atomicFile.js";

export { DRIVER_KINDS };

export const PREFERENCES_VERSION = 1;
export const RECENT_MODELS_MAX = 3;
export const MAX_DRAFTS = 50;
export const DRAFT_FLUSH_MS = 1_000;

const CONTEXT_SUFFIX = /\[1m\]$/i;
const BYTE_ORDER_MARK = /^﻿/;

export type LegacyImportField = "sidebarOrder" | "recentModels";

export type PreferencesChange =
  | { kind: "sidebarOrder" }
  | { kind: "recentModels"; driver: DriverKind }
  | { kind: "draft"; key: string; draft: ComposerDraft | null };

interface PreferencesDocument {
  version: typeof PREFERENCES_VERSION;
  sidebarOrder: SidebarOrderPrefs | null;
  recentModels: Record<DriverKind, string[]>;
  drafts: Record<string, ComposerDraft>;
  legacyImported: boolean;
}

export interface PreferencesStoreOptions {
  now?: () => number;
  warn?: (message: string) => void;
  draftFlushMs?: number;
}

export function normalizeRecentModel(driver: DriverKind, model: string): string {
  return driver === "claude" ? model.replace(CONTEXT_SUFFIX, "") : model;
}

function emptyRecentModels(): Record<DriverKind, string[]> {
  return { claude: [], opencode: [], codex: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sanitizeSidebarOrder(value: unknown): SidebarOrderPrefs | null {
  if (!isRecord(value)) return null;
  return { main: stringList(value.main), resolved: stringList(value.resolved), pinned: stringList(value.pinned) };
}

function sanitizeRecentModels(driver: DriverKind, value: unknown): string[] {
  const ids = stringList(value)
    .filter((id) => id.length > 0)
    .map((id) => normalizeRecentModel(driver, id));
  return [...new Set(ids)].slice(0, RECENT_MODELS_MAX);
}

function sanitizeDraft(value: unknown): ComposerDraft | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
  return { text: value.text, attachments: stringList(value.attachments), updatedAt };
}

function isEmptyDraft(text: string, attachments: readonly string[]): boolean {
  return !text.trim() && attachments.length === 0;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function cloneSidebarOrder(order: SidebarOrderPrefs): SidebarOrderPrefs {
  return { main: [...order.main], resolved: [...order.resolved], pinned: [...order.pinned] };
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return { ...draft, attachments: [...draft.attachments] };
}

export class PreferencesStore {
  private sidebar: SidebarOrderPrefs | null = null;
  private recents = emptyRecentModels();
  private draftEntries = new Map<string, ComposerDraft>();
  private imported = false;
  private dirty = false;
  private loadFailed = false;
  private failureWarned = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(change: PreferencesChange) => void>();
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly draftFlushMs: number;

  constructor(
    private readonly filePath: string,
    options: PreferencesStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.draftFlushMs = options.draftFlushMs ?? DRAFT_FLUSH_MS;
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
  }

  sidebarOrder(): SidebarOrderPrefs | null {
    return this.sidebar ? cloneSidebarOrder(this.sidebar) : null;
  }

  recentModels(): Record<DriverKind, string[]> {
    return { claude: [...this.recents.claude], opencode: [...this.recents.opencode], codex: [...this.recents.codex] };
  }

  drafts(): Record<string, ComposerDraft> {
    const result: Record<string, ComposerDraft> = {};
    for (const [key, draft] of this.draftEntries) result[key] = cloneDraft(draft);
    return result;
  }

  legacyImported(): boolean {
    return this.imported;
  }

  setSidebarOrder(order: SidebarOrderPrefs): void {
    this.sidebar = cloneSidebarOrder(order);
    this.persistNow();
    this.emit({ kind: "sidebarOrder" });
  }

  pushRecentModel(driver: DriverKind, model: string): void {
    const normalized = normalizeRecentModel(driver, model);
    if (!normalized) return;
    const current = this.recents[driver];
    if (current[0] === normalized) return;
    this.recents[driver] = [normalized, ...current.filter((existing) => existing !== normalized)].slice(0, RECENT_MODELS_MAX);
    this.persistNow();
    this.emit({ kind: "recentModels", driver });
  }

  setDraft(key: string, text: string, attachments: readonly string[]): void {
    if (isEmptyDraft(text, attachments)) {
      if (this.draftEntries.delete(key)) {
        this.scheduleFlush();
        this.emit({ kind: "draft", key, draft: null });
      }
      return;
    }
    const existing = this.draftEntries.get(key);
    if (existing && existing.text === text && sameList(existing.attachments, attachments)) return;
    const draft: ComposerDraft = { text, attachments: [...attachments], updatedAt: this.now() };
    this.draftEntries.delete(key);
    this.draftEntries.set(key, draft);
    const evicted = this.evictOldestDrafts(key);
    this.scheduleFlush();
    this.emit({ kind: "draft", key, draft: cloneDraft(draft) });
    for (const evictedKey of evicted) this.emit({ kind: "draft", key: evictedKey, draft: null });
  }

  importLegacy(legacy: LegacyPreferences): LegacyImportField[] {
    if (this.imported) return [];
    const imported: LegacyImportField[] = [];
    const legacyOrder = sanitizeSidebarOrder(legacy.sidebarOrder);
    if (legacyOrder && this.sidebar === null) {
      this.sidebar = legacyOrder;
      imported.push("sidebarOrder");
    }
    const changedDrivers: DriverKind[] = [];
    for (const driver of DRIVER_KINDS) {
      const legacyModels = sanitizeRecentModels(driver, legacy.recentModels?.[driver]);
      const merged = [...new Set([...this.recents[driver], ...legacyModels])].slice(0, RECENT_MODELS_MAX);
      if (sameList(merged, this.recents[driver])) continue;
      this.recents[driver] = merged;
      changedDrivers.push(driver);
    }
    if (changedDrivers.length > 0) imported.push("recentModels");
    this.imported = true;
    this.persistNow();
    if (imported.includes("sidebarOrder")) this.emit({ kind: "sidebarOrder" });
    for (const driver of changedDrivers) this.emit({ kind: "recentModels", driver });
    return imported;
  }

  onChanged(listener: (change: PreferencesChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): void {
    this.clearFlushTimer();
    if (this.dirty) this.write();
  }

  dispose(): void {
    this.flush();
    this.clearFlushTimer();
  }

  private emit(change: PreferencesChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.warn(`preferences listener failed: ${(error as Error).message}`);
      }
    }
  }

  private evictOldestDrafts(protectedKey?: string): string[] {
    const evicted: string[] = [];
    while (this.draftEntries.size > MAX_DRAFTS) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, draft] of this.draftEntries) {
        if (key !== protectedKey && draft.updatedAt < oldestAt) {
          oldestAt = draft.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      this.draftEntries.delete(oldestKey);
      evicted.push(oldestKey);
    }
    return evicted;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.draftFlushMs);
    this.flushTimer.unref?.();
  }

  private persistNow(): void {
    this.dirty = true;
    this.clearFlushTimer();
    this.write();
  }

  private write(): void {
    if (this.loadFailed && !this.load()) {
      this.scheduleFlush();
      return;
    }
    const document: PreferencesDocument = {
      version: PREFERENCES_VERSION,
      sidebarOrder: this.sidebar,
      recentModels: this.recents,
      drafts: this.drafts(),
      legacyImported: this.imported
    };
    try {
      writeFileAtomic(this.filePath, JSON.stringify(document));
      this.dirty = false;
      this.failureWarned = false;
    } catch (error) {
      this.warnOnce(`could not write preferences to ${this.filePath}: ${(error as Error).message}`);
      this.scheduleFlush();
    }
  }

  private warnOnce(message: string): void {
    if (this.failureWarned) return;
    this.failureWarned = true;
    this.warn(message);
  }

  private load(): boolean {
    let bytes: Buffer | null;
    try {
      bytes = readBytesIfExists(this.filePath);
    } catch (error) {
      this.loadFailed = true;
      this.warnOnce(`could not read preferences at ${this.filePath}; changes are not saved until it can be read: ${(error as Error).message}`);
      return false;
    }
    if (bytes) {
      const parsed = this.parse(bytes);
      if (parsed) this.merge(parsed);
      else if (!this.quarantine()) {
        this.loadFailed = true;
        return false;
      }
    }
    this.loadFailed = false;
    this.failureWarned = false;
    return true;
  }

  private merge(parsed: Record<string, unknown>): void {
    if (this.sidebar === null) {
      this.sidebar = sanitizeSidebarOrder(parsed.sidebarOrder);
      if (this.sidebar) this.emit({ kind: "sidebarOrder" });
    }
    const recents = isRecord(parsed.recentModels) ? parsed.recentModels : {};
    for (const driver of DRIVER_KINDS) {
      const merged = [...new Set([...this.recents[driver], ...sanitizeRecentModels(driver, recents[driver])])].slice(0, RECENT_MODELS_MAX);
      if (sameList(merged, this.recents[driver])) continue;
      this.recents[driver] = merged;
      this.emit({ kind: "recentModels", driver });
    }
    this.imported = this.imported || parsed.legacyImported === true;
    const drafts = isRecord(parsed.drafts) ? parsed.drafts : {};
    for (const [key, value] of Object.entries(drafts)) {
      const draft = sanitizeDraft(value);
      if (!draft || isEmptyDraft(draft.text, draft.attachments) || this.draftEntries.has(key)) continue;
      this.draftEntries.set(key, draft);
      this.emit({ kind: "draft", key, draft: cloneDraft(draft) });
    }
    for (const evictedKey of this.evictOldestDrafts()) this.emit({ kind: "draft", key: evictedKey, draft: null });
  }

  private parse(bytes: Buffer): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8").replace(BYTE_ORDER_MARK, ""));
      return isRecord(parsed) && parsed.version === PREFERENCES_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  private quarantine(): boolean {
    const target = `${this.filePath}.corrupt-${this.now()}`;
    try {
      renameSync(this.filePath, target);
      this.warn(`preferences at ${this.filePath} were unreadable; moved to ${target} and starting empty`);
      return true;
    } catch (error) {
      this.warnOnce(`preferences at ${this.filePath} were unreadable and could not be quarantined: ${(error as Error).message}`);
      return false;
    }
  }
}
