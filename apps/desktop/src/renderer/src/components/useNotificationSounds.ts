import { useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { latestUnseenPrUpdateAt, trackNotificationSounds, type SessionSoundState, type SoundTracker } from "./notificationSoundTriggers.js";
import { playNotificationSound } from "./notificationSounds.js";
import { prSummaryLookup } from "./sessionPrLinks.js";
import { useBabysitStates } from "./useBabysit.js";

function openSessionId(): string | null {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return null;
  if (usePrStore.getState().mainView.kind !== "session") return null;
  return useAppStore.getState().activeSessionId;
}

export function useNotificationSounds(): void {
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const pendingQuestions = useAppStore((s) => s.pendingQuestions);
  const inboxItems = usePrStore((s) => s.inbox?.items);
  const detailByKey = usePrStore((s) => s.detailByKey);
  const babysitOf = useBabysitStates();
  const tracker = useRef<SoundTracker | null>(null);
  const summaryByKey = useMemo(() => prSummaryLookup(inboxItems ?? [], detailByKey), [inboxItems, detailByKey]);

  useEffect(() => {
    const states: Record<string, SessionSoundState> = {};
    for (const session of Object.values(sessionsByProject).flat()) {
      const closed = session.status === "resolved" || session.status === "archived";
      states[session.id] = {
        status: session.status,
        questionIds: (pendingQuestions[session.id] ?? []).map((request) => request.requestId),
        latestPrUpdateAt: closed ? null : latestUnseenPrUpdateAt(session, summaryByKey, detailByKey),
        prMuted: babysitOf(session) !== null
      };
    }
    const result = trackNotificationSounds(tracker.current, states, Date.now(), openSessionId());
    tracker.current = result.tracker;
    const settings = useAppStore.getState().notificationSounds;
    const event = settings ? result.events.find((candidate) => settings[candidate].enabled && settings[candidate].volume > 0) : undefined;
    if (settings && event) void playNotificationSound(settings[event].sound, settings[event].volume);
  }, [sessionsByProject, pendingQuestions, summaryByKey, detailByKey, babysitOf]);
}
