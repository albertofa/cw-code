import type { AppSettings, AppTopicData, ComposerDraft, DriverKind, HarnessAvailability, ShutdownAssessment, ShutdownStatus } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";

type AppStore = TopicStore<AppTopicData>;

export interface AppTopicInit {
  settings: AppSettings;
  homeDir: string;
  shutdown: AppTopicData["shutdown"];
  recentModels?: Record<DriverKind, string[]>;
  drafts?: Record<string, ComposerDraft>;
}

export const PENDING_HARNESSES: HarnessAvailability = {
  checks: [],
  installed: [],
  issues: [],
  checkedAt: null,
  trigger: "startup",
  error: null
};

function emptyRecentModels(): Record<DriverKind, string[]> {
  return { claude: [], opencode: [], codex: [] };
}

function draftEntryKey(key: string): `draft/${string}` {
  return `draft/${key}`;
}

export class AppTopic implements TopicProvider {
  private data: AppTopicData;
  private store: AppStore | null = null;
  readonly exactTopics = [APP_TOPIC];

  constructor(
    private readonly hub: TopicHub,
    init: AppTopicInit
  ) {
    this.data = {
      settings: init.settings,
      home: { homeDir: init.homeDir },
      harnesses: PENDING_HARNESSES,
      attention: { count: 0 },
      shutdown: init.shutdown,
      recentModels: init.recentModels ?? emptyRecentModels()
    };
    for (const [key, draft] of Object.entries(init.drafts ?? {})) this.data[draftEntryKey(key)] = draft;
  }

  owns(topic: string): boolean {
    return topic === APP_TOPIC;
  }

  acquire(topic: string): AppStore {
    this.store = this.hub.createStore<AppTopicData>(topic, { ...this.data });
    return this.store;
  }

  release(): void {
    this.store = null;
  }

  get harnesses(): HarnessAvailability {
    return this.data.harnesses;
  }

  setSettings(settings: AppSettings): void {
    this.data.settings = settings;
    this.store?.upsert("settings", settings);
  }

  setHarnesses(harnesses: HarnessAvailability): void {
    this.data.harnesses = harnesses;
    this.store?.upsert("harnesses", harnesses);
  }

  setAttention(count: number): void {
    this.data.attention = { count };
    this.store?.upsert("attention", this.data.attention);
  }

  setShutdown(status: ShutdownStatus, assessment: ShutdownAssessment): void {
    this.data.shutdown = { status, assessment };
    this.store?.upsert("shutdown", this.data.shutdown);
  }

  setRecentModels(driver: DriverKind, models: string[]): void {
    this.data.recentModels = { ...this.data.recentModels, [driver]: models };
    this.store?.upsert("recentModels", this.data.recentModels);
  }

  setDraft(key: string, draft: ComposerDraft | null): void {
    const entryKey = draftEntryKey(key);
    if (draft) {
      this.data[entryKey] = draft;
      this.store?.upsert(entryKey, draft);
      return;
    }
    delete this.data[entryKey];
    this.store?.remove(entryKey);
  }
}
