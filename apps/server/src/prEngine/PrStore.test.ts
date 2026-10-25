import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { PrDetail, PrDetailEntry, PrInboxResult, PrRef, PrsTopicData, PrSummary, PrWorkflow, SessionMeta, SessionPrLink, TopicPatch } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { sessionTopic } from "@cw-code/shared/topics";
import { advanceTimersByTimeAsync } from "../../tests/testing.js";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { TopicHub } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { PrStore } from "./PrStore.js";

const REF: PrRef = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
const KEY = prKey(REF);
const OTHER_REF: PrRef = { ...REF, number: 43 };
const OTHER_KEY = prKey(OTHER_REF);

function refN(number: number): PrRef {
  return { ...REF, number };
}

function summary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: REF,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add feature",
    state: "OPEN",
    isDraft: false,
    author: { login: "author", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: "feature",
    headRefOid: "sha-1",
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "passing",
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 2000,
    ...overrides
  };
}

function detailOf(pr: PrSummary): PrDetail {
  return { ...pr, body: "body", createdAt: 0, timeline: [], threads: [], checkRuns: [], commits: [], viewerLogin: "me" };
}

function link(overrides: Partial<SessionPrLink> = {}): SessionPrLink {
  return { ref: REF, origin: "linked", lastSeenSha: "sha-1", lastSeenAt: 9000, ...overrides };
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    projectId: "project",
    driver: "claude",
    title: "Session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 5,
    prs: [link()],
    ...overrides
  };
}

function babysitWorkflow(): PrWorkflow {
  return {
    id: "babysit",
    label: "Babysit",
    description: "",
    icon: "eye",
    builtIn: true,
    enabled: true,
    target: "pr",
    autoFollowUp: true,
    suggestWhen: [],
    workspace: "linked",
    harness: { driver: null, model: "", effort: null, permissionMode: null },
    startPrompt: "",
    updatePrompt: ""
  };
}

function inboxResult(items: PrSummary[], overrides: Partial<PrInboxResult> = {}): PrInboxResult {
  return { account: { host: "github.com", login: "me" }, items, fetchedAt: 100, error: null, ...overrides };
}

interface Harness {
  prStore: PrStore;
  hub: TopicHub;
  sessions: SessionMeta[];
  fetchedDetails: string[];
  fetchedInboxes: boolean[];
  patches: TopicPatch[];
  detailResults: Map<string, PrDetail>;
  detailFailures: Map<string, string>;
  detailControl: { hold: boolean; auto: boolean; running: number; peak: number };
  releases: Map<string, () => void>;
  setSettings(patch: { prRefreshIntervalSeconds?: number; prWorkflows?: PrWorkflow[] }): void;
  setInbox(result: PrInboxResult): void;
  data(): PrsTopicData;
  subscribePrs(): void;
  unsubscribePrs(): void;
  openSession(id: string): void;
  closeSession(id: string): void;
}

function createHarness(sessions: SessionMeta[] = [], workflows: PrWorkflow[] = []): Harness {
  let settings = { ...DEFAULT_SETTINGS, prRefreshIntervalSeconds: 60, prWorkflows: workflows };
  let inbox = inboxResult([]);
  const fetchedDetails: string[] = [];
  const fetchedInboxes: boolean[] = [];
  const patches: TopicPatch[] = [];
  const detailResults = new Map<string, PrDetail>();
  const detailFailures = new Map<string, string>();
  const state = { sessions };
  const detailControl = { hold: false, auto: false, running: 0, peak: 0 };
  const releases = new Map<string, () => void>();
  const prStore = new PrStore({
    sessions: () => state.sessions,
    settings: () => settings,
    projects: () => [{ id: "project", rootPath: "/repo" }],
    githubRemote: async () => ({ host: "github.com", owner: "acme", repository: "widgets" }),
    fetchInbox: async (force) => {
      fetchedInboxes.push(force);
      return inbox;
    },
    fetchDetail: async (ref) => {
      const key = prKey(ref);
      fetchedDetails.push(key);
      detailControl.running += 1;
      detailControl.peak = Math.max(detailControl.peak, detailControl.running);
      try {
        if (detailControl.hold) await new Promise<void>((resolve) => releases.set(key, resolve));
        const failure = detailFailures.get(key);
        if (failure) throw new Error(failure);
        const result = detailResults.get(key) ?? (detailControl.auto ? detailOf(summary({ ref })) : undefined);
        if (!result) throw new Error(`no detail for ${key}`);
        return result;
      } finally {
        detailControl.running -= 1;
      }
    }
  });
  const hub = new TopicHub((_clientIds, frame) => {
    const message = JSON.parse(frame) as TopicPatch & { t: string };
    if (message.t === "patch") patches.push(message);
  });
  let store: TopicStore<Record<string, unknown>> | null = null;
  const prsProvider = prStore.attach(hub);
  hub.register({
    ...prsProvider,
    acquire: (topic, owner) => {
      store = prsProvider.acquire(topic, owner);
      return store;
    }
  });
  hub.register({
    owns: (topic) => topic.startsWith("session/"),
    acquire: (topic, owner) => owner.createStore<Record<string, unknown>>(topic, {}),
    release: () => {},
    onSubscribe: () => prStore.reevaluate(),
    onUnsubscribe: () => prStore.reevaluate()
  });
  return {
    prStore,
    hub,
    sessions,
    fetchedDetails,
    fetchedInboxes,
    patches,
    detailResults,
    detailFailures,
    detailControl,
    releases,
    setSettings(patch) {
      settings = { ...settings, ...patch };
      prStore.onSettingsChanged();
    },
    setInbox(result) {
      inbox = result;
    },
    data: () => (store?.snapshot().data ?? {}) as PrsTopicData,
    subscribePrs: () => void hub.subscribeClient("c1", ["prs"]),
    unsubscribePrs: () => hub.unsubscribeClient("c1", ["prs"]),
    openSession: (id) => void hub.subscribeClient("c1", [sessionTopic(id)]),
    closeSession: (id) => hub.unsubscribeClient("c1", [sessionTopic(id)])
  };
}

function entry(h: Harness, key: string): PrDetailEntry | undefined {
  return h.data()[`detail/${key}`];
}

const settle = () => advanceTimersByTimeAsync(0);

describe("PrStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("detail policy", () => {
    it("loads detail for unseen PRs of live sessions only", async () => {
      const h = createHarness([session({ prs: [link({ lastSeenAt: 1000 })] }), session({ id: "s2", status: "resolved", prs: [link({ ref: OTHER_REF, lastSeenAt: 1000 })] })]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.prStore.onTracked([summary(), summary({ ref: OTHER_REF })]);
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);
      expect(h.prStore.detail(KEY)?.body).toBe("body");
      expect(h.prStore.detail(OTHER_KEY)).toBeUndefined();
    });

    it("does not request the same unseen PR twice for the same version", async () => {
      const h = createHarness([session({ prs: [link({ lastSeenAt: 1000 })] })]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.prStore.onTracked([summary()]);
      await settle();
      h.prStore.onTracked([summary()]);
      h.prStore.onSessionsChanged();
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);
    });

    it("loads and refreshes detail for auto follow-up PRs", async () => {
      const h = createHarness([session({ prs: [link({ workflowId: "babysit" })] })], [babysitWorkflow()]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.prStore.onTracked([summary()]);
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);

      const newer = summary({ updatedAt: 3000, headRefOid: "sha-2" });
      h.detailResults.set(KEY, detailOf(newer));
      h.prStore.onTracked([newer]);
      await settle();
      expect(h.fetchedDetails).toEqual([KEY, KEY]);
      expect(h.prStore.detail(KEY)?.headRefOid).toBe("sha-2");
    });

    it("ignores auto follow-up PRs that are no longer open", async () => {
      const h = createHarness([session({ prs: [link({ workflowId: "babysit" })] })], [babysitWorkflow()]);
      h.prStore.onTracked([summary({ state: "MERGED" })]);
      await settle();
      expect(h.fetchedDetails).toEqual([]);
    });

    it("loads links of a session only while its topic is open", async () => {
      const h = createHarness([session()]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.prStore.onSessionsChanged();
      await settle();
      expect(h.fetchedDetails).toEqual([]);

      h.openSession("s1");
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);

      h.closeSession("s1");
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);
    });

    it("skips finished PRs that are cached", async () => {
      const h = createHarness([session()]);
      const merged = summary({ state: "MERGED" });
      h.detailResults.set(KEY, detailOf(merged));
      await h.prStore.loadDetail(REF);
      expect(h.fetchedDetails).toEqual([KEY]);

      h.openSession("s1");
      h.prStore.onTracked([summary({ state: "MERGED", updatedAt: 5000 })]);
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);
    });

    it("reloads a cached open PR when its summary changes", async () => {
      const h = createHarness([session()]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.openSession("s1");
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);

      const newer = summary({ updatedAt: 3000, ci: "failing" });
      h.detailResults.set(KEY, detailOf(newer));
      h.prStore.onTracked([newer]);
      await settle();
      expect(h.fetchedDetails).toEqual([KEY, KEY]);

      h.prStore.onTracked([newer]);
      await settle();
      expect(h.fetchedDetails).toEqual([KEY, KEY]);
    });

    it("does not loop when the fetched detail stays older than the summary", async () => {
      const h = createHarness([session()]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.openSession("s1");
      h.prStore.onTracked([summary({ updatedAt: 3000 })]);
      await settle();
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);
    });

    it("records failures in the detail entry without retrying", async () => {
      const h = createHarness([session()]);
      h.detailFailures.set(KEY, "gh failed");
      h.subscribePrs();
      await settle();
      h.openSession("s1");
      await settle();
      expect(entry(h, KEY)).toEqual({ detail: null, loading: false, error: "gh failed" });
      await settle();
      expect(h.fetchedDetails).toEqual([KEY]);
    });

    it("rejects explicit loads and keeps the error in the topic", async () => {
      const h = createHarness();
      h.subscribePrs();
      h.detailFailures.set(KEY, "boom");
      const [result] = await Promise.allSettled([h.prStore.loadDetail(REF)]);
      expect(result.status).toBe("rejected");
      expect(entry(h, KEY)?.error).toBe("boom");
    });

    it("shares one request between concurrent explicit loads", async () => {
      const h = createHarness();
      h.detailResults.set(KEY, detailOf(summary()));
      const [first, second] = await Promise.all([h.prStore.loadDetail(REF), h.prStore.loadDetail(REF)]);
      expect(first).toBe(second);
      expect(h.fetchedDetails).toEqual([KEY]);
    });

    it("publishes detail entries with a loading flag", async () => {
      const h = createHarness();
      h.subscribePrs();
      h.detailResults.set(KEY, detailOf(summary()));
      const request = h.prStore.loadDetail(REF);
      expect(entry(h, KEY)).toEqual({ detail: null, loading: true, error: null });
      await request;
      expect(entry(h, KEY)?.loading).toBe(false);
      expect(entry(h, KEY)?.detail?.body).toBe("body");
    });
  });

  describe("detail load queue", () => {
    const manyLinks = (count: number) => Array.from({ length: count }, (_, index) => link({ ref: refN(index + 1) }));

    it("runs at most three detail loads at once and drains the queue", async () => {
      const h = createHarness([session({ prs: manyLinks(7) })]);
      h.detailControl.hold = true;
      h.detailControl.auto = true;
      h.openSession("s1");
      await settle();
      expect(h.fetchedDetails).toHaveLength(3);

      for (let round = 0; round < 7; round++) {
        for (const release of [...h.releases.values()]) release();
        h.releases.clear();
        await settle();
      }
      expect(h.fetchedDetails).toHaveLength(7);
      expect(h.detailControl.peak).toBe(3);
      expect(h.prStore.detail(prKey(refN(7)))?.ref.number).toBe(7);
    });

    it("lets explicit loads jump the queue", async () => {
      const h = createHarness([session({ prs: manyLinks(5) })]);
      h.detailControl.hold = true;
      h.detailControl.auto = true;
      h.openSession("s1");
      await settle();
      expect(h.fetchedDetails).toEqual([1, 2, 3].map((n) => prKey(refN(n))));

      const explicit = h.prStore.loadDetail(refN(5));
      h.releases.get(prKey(refN(1)))?.();
      await settle();
      expect(h.fetchedDetails.at(3)).toBe(prKey(refN(5)));
      h.detailControl.hold = false;
      for (const release of h.releases.values()) release();
      await explicit;
    });

    it("keeps attempt dedupe for queued loads", async () => {
      const h = createHarness([session({ prs: manyLinks(5) })]);
      h.detailControl.hold = true;
      h.detailControl.auto = true;
      h.openSession("s1");
      await settle();
      h.prStore.onSessionsChanged();
      await settle();
      h.detailControl.hold = false;
      for (const release of h.releases.values()) release();
      await settle();
      expect(h.fetchedDetails).toHaveLength(5);
      expect(new Set(h.fetchedDetails).size).toBe(5);
    });

    it("ignores results that arrive after dispose and rejects queued loads", async () => {
      const h = createHarness([session({ prs: manyLinks(4) })]);
      h.detailControl.hold = true;
      h.detailControl.auto = true;
      h.openSession("s1");
      await settle();
      const queued = h.prStore.loadDetail(refN(4));
      h.prStore.dispose();
      const [result] = await Promise.allSettled([queued]);
      expect(result.status).toBe("rejected");
      for (const release of h.releases.values()) release();
      await settle();
      expect(h.prStore.detail(prKey(refN(1)))).toBeUndefined();
      expect(h.fetchedDetails).toHaveLength(3);
    });
  });

  describe("detail cache eviction", () => {
    it("drops details nobody wants once the session closes", async () => {
      const h = createHarness([session()]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.openSession("s1");
      await settle();
      expect(h.prStore.detail(KEY)).toBeDefined();
      h.closeSession("s1");
      await settle();
      expect(h.prStore.detail(KEY)).toBeUndefined();
    });

    it("keeps explicitly requested details for ten minutes", async () => {
      const h = createHarness();
      h.detailResults.set(KEY, detailOf(summary()));
      await h.prStore.loadDetail(REF);
      await advanceTimersByTimeAsync(9 * 60_000);
      h.prStore.onSessionsChanged();
      await settle();
      expect(h.prStore.detail(KEY)).toBeDefined();
      await advanceTimersByTimeAsync(2 * 60_000);
      h.prStore.onSessionsChanged();
      await settle();
      expect(h.prStore.detail(KEY)).toBeUndefined();
    });

    it("keeps details of PRs that sessions still care about", async () => {
      const h = createHarness([session({ prs: [link({ workflowId: "babysit" })] })], [babysitWorkflow()]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.prStore.onTracked([summary()]);
      await settle();
      await advanceTimersByTimeAsync(30 * 60_000);
      h.prStore.onSessionsChanged();
      await settle();
      expect(h.prStore.detail(KEY)).toBeDefined();
      expect(h.fetchedDetails).toEqual([KEY]);
    });

    it("caps the cache at 100 details", async () => {
      const h = createHarness();
      h.detailControl.auto = true;
      await Promise.all(Array.from({ length: 105 }, (_, index) => h.prStore.loadDetail(refN(index + 1))));
      await settle();
      const cached = Array.from({ length: 105 }, (_, index) => h.prStore.detail(prKey(refN(index + 1)))).filter(Boolean);
      expect(cached).toHaveLength(100);
    });
  });

  describe("projection", () => {
    it("publishes nothing when a change leaves the data identical", async () => {
      const h = createHarness([session()]);
      h.setInbox(inboxResult([summary()]));
      h.subscribePrs();
      await settle();
      const count = h.patches.length;
      h.prStore.onSessionsChanged();
      h.prStore.onTracked([]);
      await settle();
      expect(h.patches).toHaveLength(count);
    });

    it("coalesces bursts of changes into one patch", async () => {
      const h = createHarness([]);
      h.setInbox(inboxResult([summary()]));
      h.subscribePrs();
      await settle();
      const count = h.patches.length;
      h.sessions.push(session());
      for (let index = 0; index < 5; index++) h.prStore.onSessionsChanged();
      await settle();
      expect(h.patches).toHaveLength(count + 1);
    });
  });

  describe("inbox schedule", () => {
    it("refreshes on first subscriber, then on the configured interval, and stops on release", async () => {
      const h = createHarness();
      await advanceTimersByTimeAsync(10 * 60_000);
      expect(h.fetchedInboxes).toEqual([]);

      h.subscribePrs();
      await settle();
      expect(h.fetchedInboxes).toEqual([false]);

      await advanceTimersByTimeAsync(60_000);
      expect(h.fetchedInboxes).toHaveLength(2);
      await advanceTimersByTimeAsync(60_000);
      expect(h.fetchedInboxes).toHaveLength(3);

      h.unsubscribePrs();
      await advanceTimersByTimeAsync(10 * 60_000);
      expect(h.fetchedInboxes).toHaveLength(3);
    });

    it("clamps the interval to 30 seconds and reschedules on settings change", async () => {
      const h = createHarness();
      h.setSettings({ prRefreshIntervalSeconds: 5 });
      h.subscribePrs();
      await settle();
      expect(h.fetchedInboxes).toHaveLength(1);
      await advanceTimersByTimeAsync(30_000);
      expect(h.fetchedInboxes).toHaveLength(2);

      h.setSettings({ prRefreshIntervalSeconds: 600 });
      await advanceTimersByTimeAsync(30_000 * 10);
      expect(h.fetchedInboxes).toHaveLength(2);
      await advanceTimersByTimeAsync(300_000);
      expect(h.fetchedInboxes).toHaveLength(3);
    });

    it("does not schedule anything after dispose and resumes on resume", async () => {
      const h = createHarness();
      h.subscribePrs();
      await settle();
      h.prStore.dispose();
      await advanceTimersByTimeAsync(10 * 60_000);
      expect(h.fetchedInboxes).toHaveLength(1);

      h.prStore.resume();
      await settle();
      expect(h.fetchedInboxes).toHaveLength(2);
      await advanceTimersByTimeAsync(60_000);
      expect(h.fetchedInboxes).toHaveLength(3);
      h.prStore.dispose();
    });

    it("runs a forced refresh after a non-forced one that is already in flight", async () => {
      const h = createHarness();
      await Promise.all([h.prStore.refreshInbox(false), h.prStore.refreshInbox(true)]);
      expect(h.fetchedInboxes).toEqual([false, true]);
    });

    it("ignores an inbox result that arrives after dispose", async () => {
      const h = createHarness();
      h.setInbox(inboxResult([summary()]));
      const request = h.prStore.refreshInbox(false);
      h.prStore.dispose();
      await request;
      expect(h.prStore.summaryLookup().size).toBe(0);
    });

    it("resumes an active subscription after dispose without a resync", async () => {
      const h = createHarness();
      h.subscribePrs();
      await settle();
      h.prStore.dispose();
      h.prStore.resume();
      await settle();
      const before = h.fetchedInboxes.length;
      await advanceTimersByTimeAsync(60_000);
      expect(h.fetchedInboxes.length).toBe(before + 1);
      h.prStore.dispose();
    });

    it("refreshes on demand with the force flag and shares an in-flight refresh", async () => {
      const h = createHarness();
      await Promise.all([h.prStore.refreshInbox(true), h.prStore.refreshInbox(false)]);
      expect(h.fetchedInboxes).toEqual([true]);
    });
  });

  describe("topic data", () => {
    it("publishes the inbox, context and summaries", async () => {
      const h = createHarness();
      h.setInbox(inboxResult([summary()], { truncated: true, limit: 50, fetchedAt: 777 }));
      h.subscribePrs();
      await settle();
      const data = h.data();
      expect(data.inbox).toEqual({ keys: [KEY], account: { host: "github.com", login: "me" }, fetchedAt: 777, error: null, truncated: true, limit: 50, loading: false });
      expect(data.context).toEqual({ viewer: "me", org: "acme", projectRepos: [{ projectId: "project", host: "github.com", owner: "acme", repo: "widgets" }] });
      expect(data[`summary/${KEY}`]?.title).toBe("Add feature");
      expect(h.prStore.summaryLookup().get(KEY)?.title).toBe("Add feature");
    });

    it("replaces the inbox with a refresh result that carries an error", async () => {
      const h = createHarness();
      h.setInbox(inboxResult([summary()]));
      h.subscribePrs();
      await settle();
      h.setInbox(inboxResult([], { error: "rate limited", account: null, fetchedAt: 200 }));
      await h.prStore.refreshInbox(true);
      expect(h.data().inbox.error).toBe("rate limited");
      expect(h.data().inbox.keys).toEqual([]);
    });

    it("exposes detail-only summaries without the heavy detail fields", async () => {
      const h = createHarness();
      h.subscribePrs();
      h.detailResults.set(KEY, detailOf(summary()));
      await h.prStore.loadDetail(REF);
      const published = h.data()[`summary/${KEY}`];
      expect(published?.title).toBe("Add feature");
      expect(published).not.toHaveProperty("timeline");
      expect(h.prStore.summaryLookup().get(KEY)).toHaveProperty("timeline");
    });

    it("prefers the newer of inbox and tracked summaries", async () => {
      const h = createHarness();
      h.setInbox(inboxResult([summary({ title: "from inbox", updatedAt: 1000 })]));
      h.subscribePrs();
      await settle();
      h.prStore.onTracked([summary({ title: "from tracker", updatedAt: 2000 })]);
      await settle();
      expect(h.data()[`summary/${KEY}`]?.title).toBe("from tracker");
    });

    it("computes relations for a babysat PR", async () => {
      const h = createHarness([session({ prs: [link({ workflowId: "babysit" })] })], [babysitWorkflow()]);
      h.detailResults.set(KEY, detailOf(summary()));
      h.subscribePrs();
      h.prStore.onTracked([summary()]);
      await settle();
      const relations = h.data()[`rel/${KEY}`];
      expect(relations?.linkedSessionIds).toEqual(["s1"]);
      expect(relations?.mainSessionId).toBe("s1");
      expect(relations?.babysitter).toEqual({ sessionId: "s1", workflowId: "babysit" });
    });

    it("updates relations when sessions change", async () => {
      const h = createHarness([]);
      h.subscribePrs();
      h.prStore.onTracked([summary()]);
      await settle();
      expect(h.data()[`rel/${KEY}`]?.linkedSessionIds).toEqual([]);
      h.sessions.push(session());
      h.prStore.onSessionsChanged();
      await settle();
      expect(h.data()[`rel/${KEY}`]?.linkedSessionIds).toEqual(["s1"]);
    });

    it("leaves archived sessions out of relations", async () => {
      const h = createHarness([session({ status: "archived" })]);
      h.subscribePrs();
      h.prStore.onTracked([summary()]);
      await settle();
      expect(h.data()[`rel/${KEY}`]?.linkedSessionIds).toEqual([]);
    });

    it("notifies change listeners until they unsubscribe", async () => {
      const h = createHarness();
      let calls = 0;
      const off = h.prStore.onChanged(() => {
        calls += 1;
      });
      h.prStore.onTracked([summary()]);
      h.prStore.onSessionsChanged();
      await settle();
      expect(calls).toBe(1);
      off();
      h.prStore.onTracked([]);
      await settle();
      expect(calls).toBe(1);
    });

    it("returns project repos through the store and caches them in the context", async () => {
      const h = createHarness();
      h.subscribePrs();
      const repos = await h.prStore.refreshProjectRepos();
      expect(repos).toEqual([{ projectId: "project", host: "github.com", owner: "acme", repo: "widgets" }]);
      expect(h.data().context.projectRepos).toEqual(repos);
    });
  });

  describe("services recreation", () => {
    it("keeps revisions continuous when a new store takes over the topic", async () => {
      const h = createHarness();
      h.setInbox(inboxResult([summary()]));
      h.subscribePrs();
      await settle();
      const before = h.patches.filter((patch) => patch.topic === "prs").at(-1)?.rev ?? 0;
      h.prStore.dispose();

      const next = createHarness();
      next.setInbox(inboxResult([summary({ title: "fresh" })]));
      h.hub.clearProviders();
      h.hub.register(next.prStore.attach(h.hub));
      h.hub.reacquireAll();
      await settle();

      const after = h.patches.filter((patch) => patch.topic === "prs" && patch.rev > before);
      expect(after[0]?.rev).toBe(before + 1);
      expect(after[0]?.ops[0]?.op).toBe("replace");
      next.prStore.dispose();
    });
  });
});
