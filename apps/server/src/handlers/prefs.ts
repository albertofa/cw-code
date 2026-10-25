import type { DriverKind, LegacyPreferences, SidebarOrderPrefs } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { DRIVER_KINDS, type LegacyImportField } from "../prefs/PreferencesStore.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs, parseString } from "./shared.js";

export const MAX_DRAFT_KEY_LENGTH = 200;
export const MAX_DRAFT_TEXT_LENGTH = 200_000;
export const MAX_DRAFT_ATTACHMENTS = 50;
export const MAX_ATTACHMENT_LENGTH = 4_096;
export const MAX_MODEL_LENGTH = 200;
export const MAX_ORDER_ENTRIES = 10_000;

function parseDriver(value: unknown): DriverKind {
  if (typeof value !== "string" || !DRIVER_KINDS.includes(value as DriverKind)) throw new Error("driver must be claude, opencode or codex");
  return value as DriverKind;
}

function parseBoundedString(value: unknown, name: string, max: number): string {
  const text = parseString(value, name);
  if (text.length > max) throw new Error(`${name} must be at most ${max} characters`);
  return text;
}

function parseStringList(value: unknown, name: string, maxEntries: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  if (value.length > maxEntries) throw new Error(`${name} must have at most ${maxEntries} entries`);
  return value.map((item, index) => parseBoundedString(item, `${name}[${index}]`, maxLength));
}

function parseSidebarOrder(value: unknown): SidebarOrderPrefs {
  const order = parseArgs(value, "sidebarOrder");
  return {
    main: parseStringList(order.main, "sidebarOrder.main", MAX_ORDER_ENTRIES, MAX_DRAFT_KEY_LENGTH),
    resolved: parseStringList(order.resolved, "sidebarOrder.resolved", MAX_ORDER_ENTRIES, MAX_DRAFT_KEY_LENGTH),
    pinned: parseStringList(order.pinned, "sidebarOrder.pinned", MAX_ORDER_ENTRIES, MAX_DRAFT_KEY_LENGTH)
  };
}

function parseLegacyPreferences(value: unknown): LegacyPreferences {
  const args = parseArgs(value, "prefs.importLegacy");
  const legacy: LegacyPreferences = {};
  if (args.sidebarOrder !== undefined) legacy.sidebarOrder = parseSidebarOrder(args.sidebarOrder);
  if (args.recentModels !== undefined) {
    const recent = parseArgs(args.recentModels, "recentModels");
    legacy.recentModels = {};
    for (const driver of DRIVER_KINDS) {
      if (recent[driver] !== undefined) {
        legacy.recentModels[driver] = parseStringList(recent[driver], `recentModels.${driver}`, MAX_ORDER_ENTRIES, MAX_MODEL_LENGTH);
      }
    }
  }
  return legacy;
}

export function registerPrefsHandlers(router: Router, app: ServerApp): void {
  const preferences = () => app.requireServices().preferences;
  handle<unknown>(router, "prefs.importLegacy", (args): { imported: LegacyImportField[] } => ({
    imported: preferences().importLegacy(parseLegacyPreferences(args))
  }));
  handle<unknown>(router, "prefs.pushRecentModel", (args) => {
    const params = parseArgs(args, "prefs.pushRecentModel");
    preferences().pushRecentModel(parseDriver(params.driver), parseBoundedString(params.model, "model", MAX_MODEL_LENGTH));
  });
  handle<unknown>(router, "prefs.setDraft", (args) => {
    const params = parseArgs(args, "prefs.setDraft");
    const key = parseBoundedString(params.key, "key", MAX_DRAFT_KEY_LENGTH);
    if (!key) throw new Error("key must not be empty");
    const text = parseBoundedString(params.text, "text", MAX_DRAFT_TEXT_LENGTH);
    const attachments = parseStringList(params.attachments, "attachments", MAX_DRAFT_ATTACHMENTS, MAX_ATTACHMENT_LENGTH);
    preferences().setDraft(key, text, attachments);
  });
}
