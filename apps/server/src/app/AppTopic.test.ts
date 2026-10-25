import { describe, expect, test } from "bun:test";
import type { AppTopicData, TopicPatch } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { TopicHub } from "../topics/TopicHub.js";
import type { CallContext } from "../transport/Router.js";
import { AppTopic, PENDING_HARNESSES } from "./AppTopic.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };
const SHUTDOWN = {
  status: { idle: true, committed: false, reason: null },
  assessment: { activeTurns: [], backgroundTasks: 0, terminals: [] }
};

function setup() {
  const patches: TopicPatch[] = [];
  const hub = new TopicHub((_clientIds, frame) => patches.push(JSON.parse(frame) as TopicPatch));
  const app = new AppTopic(hub, { settings: DEFAULT_SETTINGS, homeDir: "/home/me", shutdown: SHUTDOWN });
  hub.register(app);
  return { hub, app, patches };
}

describe("AppTopic", () => {
  test("snapshot carries every app entry", () => {
    const { hub } = setup();
    const snapshot = hub.subscribe(ctx, [APP_TOPIC])[APP_TOPIC];
    expect(snapshot?.rev).toBe(0);
    expect(snapshot?.data as AppTopicData).toEqual({
      settings: DEFAULT_SETTINGS,
      home: { homeDir: "/home/me" },
      harnesses: PENDING_HARNESSES,
      attention: { count: 0 },
      shutdown: SHUTDOWN,
      recentModels: { claude: [], opencode: [], codex: [] }
    });
  });

  test("setSettings upserts the settings entry for subscribers", () => {
    const { hub, app, patches } = setup();
    hub.subscribe(ctx, [APP_TOPIC]);
    const saved = { ...DEFAULT_SETTINGS, claudeReasoningExpanded: !DEFAULT_SETTINGS.claudeReasoningExpanded };
    app.setSettings(saved);
    expect(patches).toMatchObject([{ topic: APP_TOPIC, rev: 1, ops: [{ op: "upsert", key: "settings", value: saved }] }]);
  });

  test("an unchanged settings value publishes nothing", () => {
    const { hub, app, patches } = setup();
    hub.subscribe(ctx, [APP_TOPIC]);
    app.setSettings({ ...DEFAULT_SETTINGS });
    expect(patches).toEqual([]);
  });

  test("changes made without subscribers show up in the next snapshot and revs continue", () => {
    const { hub, app } = setup();
    hub.subscribe(ctx, [APP_TOPIC]);
    app.setAttention(2);
    hub.unsubscribe(ctx, [APP_TOPIC]);
    app.setAttention(3);
    const saved = { ...DEFAULT_SETTINGS, holdingHours: DEFAULT_SETTINGS.holdingHours + 1 };
    app.setSettings(saved);
    const snapshot = hub.subscribe(ctx, [APP_TOPIC])[APP_TOPIC];
    expect(snapshot?.rev).toBeGreaterThan(0);
    expect((snapshot?.data as AppTopicData).attention).toEqual({ count: 3 });
    expect((snapshot?.data as AppTopicData).settings).toEqual(saved);
  });
});
