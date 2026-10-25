import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ServerClient, TopicCache } from "@cw-code/client";
import type { DesktopApi } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { flushAllComposerDrafts } from "../components/composerDrafts.js";
import { ipcErrorMessage } from "../components/ipcError.js";
import { createCwApi, type ShutdownHandlers } from "./createCwApi.js";
import { migrateLegacyPreferences } from "./legacyPrefs.js";
import { initTopics, waitForTopicSettled } from "./topics.js";

type Phase = { kind: "connecting" } | { kind: "failed"; message: string } | { kind: "ready" };
type Link = "up" | "reconnecting" | "lost";

const RECONNECTING_BANNER_DELAY_MS = 1_000;
const APP_SETTLE_TIMEOUT_MS = 15_000;

type AppSettle = { kind: "settled"; status: string | undefined } | { kind: "timeout" } | { kind: "link-down" };

function reload(): void {
  flushAllComposerDrafts();
  window.location.reload();
}

async function settleAppTopic(client: ServerClient): Promise<AppSettle> {
  const abort = new AbortController();
  let timer: number | null = null;
  let offState = (): void => undefined;
  const linkDown = new Promise<AppSettle>((resolve) => {
    const check = (): void => {
      if (client.state === "closed" || client.state === "reconnecting") resolve({ kind: "link-down" });
    };
    offState = client.onState(check);
    check();
  });
  const timeout = new Promise<AppSettle>((resolve) => {
    timer = window.setTimeout(() => resolve({ kind: "timeout" }), APP_SETTLE_TIMEOUT_MS);
  });
  const settled = waitForTopicSettled(APP_TOPIC, abort.signal).then((state): AppSettle => ({ kind: "settled", status: state?.status }));
  try {
    return await Promise.race([settled, linkDown, timeout]);
  } finally {
    abort.abort();
    offState();
    if (timer !== null) window.clearTimeout(timer);
  }
}

export function ServerGate({ desktop, children }: { desktop: DesktopApi; children: ReactNode }) {
  const [client] = useState(() => new ServerClient({ endpoint: () => desktop.serverEndpoint(), client: "desktop-ui", reconnect: true }));
  const [shutdownHandlers] = useState<ShutdownHandlers>(() => new Set());
  const topicCache = useRef<TopicCache | null>(null);
  const appHold = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [link, setLink] = useState<Link>("up");

  const connect = useCallback(() => {
    setPhase({ kind: "connecting" });
    setLink("up");
    const open = async (): Promise<void> => {
      await client.connect();
      if (!topicCache.current) {
        topicCache.current = new TopicCache(client);
        topicCache.current.onEpoch(flushAllComposerDrafts);
      }
      initTopics(topicCache.current);
      window.cw = createCwApi(client, topicCache.current, desktop, shutdownHandlers);
      appHold.current ??= topicCache.current.acquire(APP_TOPIC);
      const settle = await settleAppTopic(client);
      if (settle.kind === "link-down") throw client.lastError ?? new Error("the connection to the cw-code server was lost");
      if (settle.kind === "timeout") console.warn("[cw-code] the app topic did not settle in time; continuing without it");
      if (settle.kind === "settled" && settle.status === "ready") void migrateLegacyPreferences(window.cw);
      setPhase({ kind: "ready" });
    };
    open().catch((err: unknown) => setPhase({ kind: "failed", message: ipcErrorMessage(err) }));
  }, [client, desktop, shutdownHandlers]);

  useEffect(
    () =>
      desktop.shutdown.onRequested((event) => {
        if (shutdownHandlers.size === 0 || client.state === "closed") {
          desktop.shutdown.quit();
          return;
        }
        for (const handler of [...shutdownHandlers]) handler(event);
      }),
    [client, desktop, shutdownHandlers]
  );

  useEffect(() => {
    let bannerTimer: number | null = null;
    const clearBannerTimer = (): void => {
      if (bannerTimer === null) return;
      window.clearTimeout(bannerTimer);
      bannerTimer = null;
    };
    const offState = client.onState((state, previous) => {
      if (state !== "reconnecting") clearBannerTimer();
      if (state === "reconnecting") bannerTimer ??= window.setTimeout(() => setLink("reconnecting"), RECONNECTING_BANNER_DELAY_MS);
      else if (state === "open") setLink("up");
      else if (state === "closed" && previous !== "connecting") setLink("lost");
    });
    const offStartup = client.on("startup.changed", reload);
    window.addEventListener("pagehide", flushAllComposerDrafts);
    window.addEventListener("beforeunload", flushAllComposerDrafts);
    connect();
    return () => {
      clearBannerTimer();
      offState();
      offStartup();
      window.removeEventListener("pagehide", flushAllComposerDrafts);
      window.removeEventListener("beforeunload", flushAllComposerDrafts);
    };
  }, [client, connect]);

  const lostOverlay = link === "lost" && (
    <div className="server-gate server-gate-overlay" role="alert">
      <div className="preload-error">
        The connection to the cw-code server was closed{client.lastError ? `: ${client.lastError.message}` : "."}
      </div>
      <button type="button" className="btn btn-primary" onClick={reload}>
        Reload
      </button>
    </div>
  );
  if (phase.kind === "connecting") {
    return (
      <>
        <div className="server-gate">Connecting to the cw-code server…</div>
        {lostOverlay}
      </>
    );
  }
  if (phase.kind === "failed") {
    return (
      <div className="server-gate">
        <div className="preload-error">Could not connect to the cw-code server: {phase.message}</div>
        <button type="button" className="btn btn-primary" onClick={connect}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <>
      {link === "reconnecting" && <div className="server-banner">Reconnecting to the cw-code server…</div>}
      {lostOverlay}
      {children}
    </>
  );
}

export function DesktopMissing() {
  return <div className="preload-error">cw-code must run inside the desktop app for now.</div>;
}
