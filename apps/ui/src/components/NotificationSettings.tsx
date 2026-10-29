import type { ReactNode } from "react";
import { CheckCircle2, GitPullRequest, MessageCircleQuestion, Music, Play } from "lucide-react";
import type { AppSettings, NotificationSoundEvent, NotificationSoundPreference } from "../cw.js";
import { MenuSelect, type MenuOption } from "./MenuSelect.js";
import { isNotificationSoundId, NOTIFICATION_SOUNDS, playNotificationSound } from "./notificationSounds.js";
import { SettingsGroup, SettingsSwitch } from "./SettingsLayout.js";

const EVENTS: { id: NotificationSoundEvent; title: string; hint: string; icon: ReactNode }[] = [
  {
    id: "done",
    title: "Session done",
    hint: "A session finishes its turn.",
    icon: <CheckCircle2 size={13} aria-hidden="true" />
  },
  {
    id: "question",
    title: "Question asked",
    hint: "A session asks you a question and waits for the answer.",
    icon: <MessageCircleQuestion size={13} aria-hidden="true" />
  },
  {
    id: "prUpdate",
    title: "Pull request update",
    hint: "A linked pull request gets new commits, reviews, comments or check results. Silent while babysit handles it.",
    icon: <GitPullRequest size={13} aria-hidden="true" />
  }
];

const SOUND_OPTIONS: MenuOption[] = EVENTS.flatMap((event, index) => [
  ...(index > 0 ? [{ id: `separator-${event.id}`, label: "", separator: true }] : []),
  ...Object.entries(NOTIFICATION_SOUNDS)
    .filter(([, sound]) => sound.family === event.id)
    .map(([id, sound]) => ({ id, label: sound.label, hint: sound.label, description: sound.description }))
]);

export function NotificationSettings({
  draft,
  onDraftChange
}: {
  draft: AppSettings;
  onDraftChange: (patch: Partial<AppSettings>) => void;
}) {
  const sounds = draft.notificationSounds;
  const change = (event: NotificationSoundEvent, patch: Partial<NotificationSoundPreference>) =>
    onDraftChange({ notificationSounds: { ...sounds, [event]: { ...sounds[event], ...patch } } });

  return (
    <SettingsGroup title="Sounds">
      {EVENTS.map((event) => {
        const pref = sounds[event.id];
        const id = `sp-sound-${event.id}`;
        return (
          <div key={event.id} className="sp-card">
            <div className="sp-card-head">
              <label className="sp-lab" htmlFor={id}>
                <span className="sp-lab-icon">
                  {event.icon} {event.title}
                </span>
                <small>{event.hint}</small>
              </label>
              <SettingsSwitch id={id} checked={pref.enabled} onChange={(enabled) => change(event.id, { enabled })} label={`Play a sound for ${event.title.toLowerCase()}`} />
            </div>
            <div className="sp-card-grid">
              <div className="sp-field">
                <span>Sound</span>
                <MenuSelect
                  label={`${event.title} sound`}
                  direction="down"
                  value={pref.sound}
                  display={NOTIFICATION_SOUNDS[pref.sound].label}
                  icon={<Music size={13} aria-hidden="true" />}
                  options={SOUND_OPTIONS}
                  onPick={(picked) => {
                    if (!isNotificationSoundId(picked)) return;
                    change(event.id, { sound: picked });
                    void playNotificationSound(picked, pref.volume);
                  }}
                />
              </div>
              <label className="sp-field">
                <span>Volume</span>
                <span className="sp-volume">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={pref.volume}
                    aria-label={`${event.title} volume`}
                    onChange={(e) => change(event.id, { volume: Number(e.target.value) })}
                  />
                  <output>{pref.volume}</output>
                </span>
              </label>
              <div className="sp-field">
                <span>Preview</span>
                <button
                  type="button"
                  className="btn sp-sound-preview"
                  disabled={pref.volume === 0}
                  onClick={() => void playNotificationSound(pref.sound, pref.volume)}
                >
                  <Play size={12} aria-hidden="true" /> Play
                </button>
              </div>
            </div>
            <div className="sp-card-foot">{NOTIFICATION_SOUNDS[pref.sound].description}.</div>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
