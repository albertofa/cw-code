import { APP_TOPIC, filesTopic, isValidTopic, ptyTopic, sessionTopic, SIDEBAR_TOPIC } from "@cw-code/shared/topics";

type TopicResolver = (payload: unknown) => string | null;

function field(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null) return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

const fixed =
  (topic: string): TopicResolver =>
  () =>
    topic;

const broadcast: TopicResolver = () => null;

const bySession = (build: (sessionId: string) => string): TopicResolver => (payload) => build(field(payload, "sessionId"));

const byPty: TopicResolver = (payload) => ptyTopic(field(payload, "ptyId"));

const CHANNEL_TOPICS: ReadonlyMap<string, TopicResolver> = new Map([
  ["composer.changed", bySession(sessionTopic)],
  ["projects.changed", fixed(SIDEBAR_TOPIC)],
  ["fs.changed", bySession(filesTopic)],
  ["pty.data", byPty],
  ["pty.exit", byPty],
  ["skills.changed", fixed(APP_TOPIC)],
  ["devices.changed", fixed(APP_TOPIC)],
  ["shutdown.expired", broadcast],
  ["settings.changed", broadcast],
  ["startup.changed", broadcast],
  ["shutdown.changed", broadcast],
  ["app.notice", broadcast]
]);

const warnedChannels = new Set<string>();

const warnedInvalidChannels = new Set<string>();

export function isRoutableTopic(channel: string, topic: string): boolean {
  if (isValidTopic(topic)) return true;
  if (!warnedInvalidChannels.has(channel)) {
    warnedInvalidChannels.add(channel);
    console.warn(`[events] channel '${channel}' produced invalid topic ${JSON.stringify(topic)}; dropping its events`);
  }
  return false;
}

export function eventTopic(channel: string, payload: unknown): string | null {
  const resolve = CHANNEL_TOPICS.get(channel);
  if (resolve) return resolve(payload);
  if (!warnedChannels.has(channel)) {
    warnedChannels.add(channel);
    console.warn(`[events] channel '${channel}' has no topic; broadcasting it`);
  }
  return null;
}
