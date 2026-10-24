import { APP_TOPIC, GITHUB_RUNS_TOPIC, gitTopic, PRS_TOPIC, sessionTopic, SIDEBAR_TOPIC } from "@cw-code/shared/topics";

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

const CHANNEL_TOPICS: ReadonlyMap<string, TopicResolver> = new Map([
  ["turn.event", bySession(sessionTopic)],
  ["composer.changed", bySession(sessionTopic)],
  ["session.title", fixed(SIDEBAR_TOPIC)],
  ["session.updated", fixed(SIDEBAR_TOPIC)],
  ["projects.changed", fixed(SIDEBAR_TOPIC)],
  ["git.statusChanged", bySession(gitTopic)],
  ["fs.changed", broadcast],
  ["prs.tracked", fixed(PRS_TOPIC)],
  ["github.runsChanged", fixed(GITHUB_RUNS_TOPIC)],
  ["github.ciActivity", fixed(GITHUB_RUNS_TOPIC)],
  ["pty.data", broadcast],
  ["pty.exit", broadcast],
  ["skills.changed", fixed(APP_TOPIC)],
  ["devices.changed", fixed(APP_TOPIC)],
  ["shutdown.expired", broadcast],
  ["settings.changed", broadcast],
  ["startup.changed", broadcast],
  ["shutdown.changed", broadcast],
  ["app.notice", broadcast]
]);

const warnedChannels = new Set<string>();

export function eventTopic(channel: string, payload: unknown): string | null {
  const resolve = CHANNEL_TOPICS.get(channel);
  if (resolve) return resolve(payload);
  if (!warnedChannels.has(channel)) {
    warnedChannels.add(channel);
    console.warn(`[events] channel '${channel}' has no topic; broadcasting it`);
  }
  return null;
}
