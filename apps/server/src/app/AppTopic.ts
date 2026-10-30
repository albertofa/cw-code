import type {
  AppSettings,
  AppTopicData,
  ComposerDraft,
  DriverKind,
  HarnessAvailability,
  HarnessUpdateInfo,
  HarnessUpdates,
  ShutdownAssessment,
  ShutdownStatus
} from "@cw-code/contracts";
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

function pendingUpdate(binary: DriverKind): HarnessUpdateInfo {
  return {
    binary,
    status: "unknown",
    currentVersion: null,
    latestVersion: null,
    installMethod: "unknown",
    canUpdate: false,
    updateCommand: null,
    message: null,
    checkedAt: null,
    phase: "idle",
    phaseMessage: null,
    startedAt: null,
    finishedAt: null,
    output: null
  };
}

export const PENDING_HARNESS_UPDATES: HarnessUpdates = {
  claude: pendingUpdate("claude"),
  opencode: pendingUpdate("opencode"),
  codex: pendingUpdate("codex")
};

function emptyRecentModels(): Record<DriverKind, string[]> {
  return { claude: [], opencode: [], codex: [] };
}

function draftEntryKey(key: string): `draft/${string}` {
  return `draft/${key}`;
}

export class AppTopic implements TopicProvider {
  readonly exactTopics = [APP_TOPIC];
  private data: AppTopicData;
  private store: AppStore | null = null;

  constructor(
    private readonly hub: TopicHub,
    init: AppTopicInit
  ) {
    this.data = {
      settings: init.settings,
      home: { homeDir: init.homeDir },
      harnesses: PENDING_HARNESSES,
      harnessUpdates: PENDING_HARNESS_UPDATES,
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

  get harnessUpdates(): HarnessUpdates {
    return this.data.harnessUpdates;
  }

  setHarnessUpdates(updates: HarnessUpdates): void {
    this.data.harnessUpdates = updates;
    this.store?.upsert("harnessUpdates", updates);
  }

  setAttention(count: number): void {
    this.data.attention = { count };
    this.store?.upsert("attention", this.data.attention);
  }

  setShutdown(status: ShutdownStatus, assessment: ShutdownAssessment): void {
    this.data.shutdown = { status, assessment };
    this.store?.upsert("shutdown", this.data.shutdown);
  }

  setShutdownStatus(status: ShutdownStatus): void {
    this.data.shutdown = { ...this.data.shutdown, status };
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
