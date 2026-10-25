import type { AppSettings, ServerEndpoint, ShutdownStatus, StartupState } from "@cw-code/contracts";
import { ServerClient, TopicCache } from "@cw-code/client";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { attentionCountOf, type AttentionTopicState } from "./attention.js";

export type ServerLinkChange = "settings" | "shutdown" | "startup" | "attention";

const IDLE_SHUTDOWN: ShutdownStatus = { idle: true, committed: false, reason: null };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ServerLink {
  private readonly client: ServerClient;
  private readonly topics: TopicCache;
  private releaseApp: () => void;
  private cachedAttention: number | null = null;
  private cachedSettings: AppSettings | null = null;
  private cachedShutdown: ShutdownStatus = IDLE_SHUTDOWN;
  private cachedStartup: StartupState | null = null;
  private refreshing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(change: ServerLinkChange) => void>();

  constructor(endpoint: () => Promise<ServerEndpoint>) {
    this.client = new ServerClient({ endpoint, client: "desktop-shell", reconnect: true });
    this.client.on("settings.changed", (payload) => this.setSettings(payload as AppSettings));
    this.client.on("shutdown.changed", (payload) => this.setShutdown(payload as ShutdownStatus));
    this.client.on("startup.changed", (payload) => void this.applyStartup(payload as StartupState));
    this.client.onState((state) => {
      if (state === "open") this.refreshing = this.refresh();
    });
    this.topics = new TopicCache(this.client);
    this.topics.listen(APP_TOPIC, () => this.readAttention());
    this.releaseApp = this.topics.acquire(APP_TOPIC);
  }

  get attentionCount(): number | null {
    return this.cachedAttention;
  }

  get isOpen(): boolean {
    return this.client.state === "open";
  }

  get settings(): AppSettings | null {
    return this.cachedSettings;
  }

  get shutdown(): ShutdownStatus {
    return this.cachedShutdown;
  }

  get startup(): StartupState | null {
    return this.cachedStartup;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.refreshing;
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.client.call<T>(method, params);
  }

  on(channel: string, cb: (payload: unknown) => void): () => void {
    return this.client.on(channel, cb);
  }

  onChange(cb: (change: ServerLinkChange) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  close(): void {
    this.topics.dispose();
    this.client.close();
  }

  private readAttention(): void {
    const state = this.topics.state<AttentionTopicState["data"]>(APP_TOPIC);
    const count = state?.status === "error" ? null : attentionCountOf(state);
    if ((count === null && state?.status !== "error") || count === this.cachedAttention) return;
    this.cachedAttention = count;
    this.notify("attention");
  }

  private async refresh(): Promise<void> {
    try {
      const [startup, shutdown] = await Promise.all([
        this.client.call<StartupState>("startup.state"),
        this.client.call<ShutdownStatus>("shutdown.status")
      ]);
      this.setShutdown(shutdown);
      await this.applyStartup(startup);
    } catch (error) {
      console.warn(`[server] could not refresh the shell's server state: ${errorMessage(error)}`);
    }
  }

  private async applyStartup(startup: StartupState): Promise<void> {
    if (startup.mode === "ready" && this.topics.state(APP_TOPIC)?.status === "error") {
      this.releaseApp();
      this.releaseApp = this.topics.acquire(APP_TOPIC);
    }
    if (startup.mode === "ready") {
      try {
        this.setSettings(await this.client.call<AppSettings>("settings.get"));
      } catch (error) {
        console.warn(`[server] could not read settings: ${errorMessage(error)}`);
      }
    }
    this.cachedStartup = startup;
    this.notify("startup");
  }

  private setSettings(settings: AppSettings): void {
    this.cachedSettings = settings;
    this.notify("settings");
  }

  private setShutdown(status: ShutdownStatus): void {
    this.cachedShutdown = status;
    this.notify("shutdown");
  }

  private notify(change: ServerLinkChange): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(change);
      } catch (error) {
        console.error(`[server] ${change} listener failed`, error);
      }
    }
  }
}
