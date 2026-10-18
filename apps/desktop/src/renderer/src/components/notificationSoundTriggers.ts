import type { NotificationSoundEvent, PrDetail, Session, SessionStatus } from "../cw.js";
import { prKey } from "./prInbox.js";
import { detailIsCurrent } from "./needsYou.js";
import { hasUnseen, updatesSince } from "./prUpdates.js";
import { sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export interface SessionSoundState {
  status: SessionStatus;
  questionIds: string[];
  /** Newest unseen PR update time, or null when nothing is unseen. */
  latestPrUpdateAt: number | null;
  /** True while babysit handles the session's PR, so its updates stay silent. */
  prMuted: boolean;
}

interface TrackedSession {
  status: SessionStatus;
  questionIds: string[];
  prHeardAt: number;
}

export interface SoundTracker {
  sessions: Record<string, TrackedSession>;
}

const EVENT_ORDER: NotificationSoundEvent[] = ["question", "done", "prUpdate"];

export function latestUnseenPrUpdateAt(session: Session, summaryByKey: PrSummaryLookup, detailByKey: Record<string, PrDetail>): number | null {
  let latest: number | null = null;
  for (const link of sessionLinks(session)) {
    const key = prKey(link.ref);
    const summary = summaryByKey.get(key);
    const detail = detailByKey[key];
    if (!summary || !hasUnseen(summary, link) || !detailIsCurrent(detail, summary)) continue;
    for (const update of updatesSince(detail, link)) latest = Math.max(latest ?? update.at, update.at);
  }
  return latest;
}

function sessionEvents(prev: TrackedSession, next: SessionSoundState): NotificationSoundEvent[] {
  const events: NotificationSoundEvent[] = [];
  if (next.questionIds.some((id) => !prev.questionIds.includes(id))) events.push("question");
  if (next.status === "done" && prev.status !== "done") events.push("done");
  if (!next.prMuted && next.latestPrUpdateAt !== null && next.latestPrUpdateAt > prev.prHeardAt) events.push("prUpdate");
  return events;
}

/**
 * Compares the current session states with what was last heard and returns the events that are new.
 * Sessions seen for the first time are only recorded, PR updates from before a session was first seen never sound,
 * and the session the user is looking at stays silent.
 */
export function trackNotificationSounds(
  tracker: SoundTracker | null,
  sessions: Record<string, SessionSoundState>,
  now: number,
  openSessionId: string | null
): { tracker: SoundTracker; events: NotificationSoundEvent[] } {
  const found = new Set<NotificationSoundEvent>();
  const tracked: Record<string, TrackedSession> = {};
  for (const [id, next] of Object.entries(sessions)) {
    const prev = tracker?.sessions[id];
    if (prev && id !== openSessionId) for (const event of sessionEvents(prev, next)) found.add(event);
    const heardFloor = prev?.prHeardAt ?? now;
    tracked[id] = {
      status: next.status,
      questionIds: next.questionIds,
      prHeardAt: Math.max(heardFloor, next.latestPrUpdateAt ?? heardFloor)
    };
  }
  return { tracker: { sessions: tracked }, events: EVENT_ORDER.filter((event) => found.has(event)) };
}
