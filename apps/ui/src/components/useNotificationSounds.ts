import { useEffect, useRef } from "react";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { trackNotificationSounds, type SessionSoundState, type SoundTracker } from "./notificationSoundTriggers.js";
import { playNotificationSound } from "./notificationSounds.js";
import { useSessions } from "./useSessions.js";

function openSessionId(): string | null {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return null;
  if (usePrStore.getState().mainView.kind !== "session") return null;
  return useAppStore.getState().activeSessionId;
}

export function useNotificationSounds(): void {
  const rows = useSessions();
  const tracker = useRef<SoundTracker | null>(null);

  useEffect(() => {
    const states: Record<string, SessionSoundState> = {};
    for (const row of rows) {
      states[row.session.id] = {
        status: row.session.status,
        questionIds: row.pendingQuestionIds,
        latestPrUpdateAt: row.latestUnseenPrUpdateAt,
        prMuted: row.prMuted
      };
    }
    const result = trackNotificationSounds(tracker.current, states, Date.now(), openSessionId());
    tracker.current = result.tracker;
    const settings = useAppStore.getState().notificationSounds;
    const event = settings ? result.events.find((candidate) => settings[candidate].enabled && settings[candidate].volume > 0) : undefined;
    if (settings && event) void playNotificationSound(settings[event].sound, settings[event].volume);
  }, [rows]);
}
