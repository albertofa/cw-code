import { useEffect, useRef } from "react";
import type { DriverKind, HarnessAvailability, HarnessIssue } from "@cw-code/contracts";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { useTopicEntry } from "../server/topics.js";
import { usePrStore } from "../stores/prStore.js";
import { errorMessage } from "./errorMessage.js";
import { type NotifAction, useNotifs } from "./Notifications.js";

const BINARY_NOTIF_ID = "cli-binaries";
const VERSION_NOTIF_ID = "cli-versions";
const FALLBACK_BINARY: DriverKind = "claude";

const openSettings = (harness: DriverKind): void => usePrStore.getState().openSettings(undefined, harness);

function recheck(): void {
  window.cw.recheckClis().catch((err: unknown) => {
    useNotifs.getState().push({ kind: "error", title: "Could not recheck the CLIs", message: errorMessage(err) });
  });
}

const RECHECK: NotifAction = { label: "Recheck", onClick: recheck };

function configureActions(binaries: DriverKind[]): NotifAction[] {
  const targets = binaries.length > 0 ? binaries : [FALLBACK_BINARY];
  return targets.map((binary, index) => ({
    label: `Configure ${harnessLabel(binary)}`,
    primary: index === 0,
    onClick: () => openSettings(binary)
  }));
}

function showBinaryIssue(issue: HarnessIssue): void {
  useNotifs.getState().upsert({
    id: BINARY_NOTIF_ID,
    kind: issue.level,
    title: issue.title,
    message: issue.message,
    sticky: true,
    actions: [...configureActions(issue.binaries), RECHECK]
  });
}

function showVersionIssue(issue: HarnessIssue): void {
  const notifs = useNotifs.getState();
  notifs.upsert({
    id: VERSION_NOTIF_ID,
    kind: issue.level,
    title: issue.title,
    message: issue.message,
    sticky: true,
    actions: [{ ...RECHECK, primary: true }, { label: "Dismiss", onClick: () => notifs.dismiss(VERSION_NOTIF_ID) }]
  });
}

function showCheckFailure(message: string): void {
  useNotifs.getState().upsert({
    id: BINARY_NOTIF_ID,
    kind: "error",
    title: "CLI binary check failed",
    message,
    sticky: true,
    actions: [
      ...(["claude", "opencode", "codex"] as const).map((binary) => ({ label: `Configure ${harnessLabel(binary)}`, primary: binary === "claude", onClick: () => openSettings(binary) })),
      RECHECK
    ]
  });
}

function syncIssue(notifId: string, issue: HarnessIssue | undefined, show: (issue: HarnessIssue) => void): void {
  if (issue) show(issue);
  else useNotifs.getState().dismiss(notifId);
}

function syncNotices(harnesses: HarnessAvailability): void {
  const find = (id: HarnessIssue["id"]) => harnesses.issues.find((issue) => issue.id === id);
  if (harnesses.error !== null) showCheckFailure(harnesses.error);
  else syncIssue(BINARY_NOTIF_ID, find("cli-binaries"), showBinaryIssue);
  syncIssue(VERSION_NOTIF_ID, find("cli-versions"), showVersionIssue);
}

export function HarnessNotices(): null {
  const harnesses = useTopicEntry<HarnessAvailability>(APP_TOPIC, "harnesses");
  const lastCheckedAt = useRef<number | null | undefined>(undefined);
  const syncedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!harnesses) return;
    const previous = lastCheckedAt.current;
    lastCheckedAt.current = harnesses.checkedAt;
    if (harnesses.checkedAt === null && harnesses.error === null) return;
    const key = JSON.stringify({ issues: harnesses.issues, error: harnesses.error });
    const contentChanged = key !== syncedKey.current;
    syncedKey.current = key;
    if (contentChanged) syncNotices(harnesses);
    const isNewSettingsResult = previous !== undefined && harnesses.checkedAt !== previous;
    if (isNewSettingsResult && harnesses.trigger === "settings" && harnesses.error === null && harnesses.issues.length === 0) {
      useNotifs.getState().push({ kind: "success", title: "CLI settings verified" });
    }
  }, [harnesses]);

  return null;
}
