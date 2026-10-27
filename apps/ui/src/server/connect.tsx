import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ServerCallError, ServerClient, TopicCache } from "@cw-code/client";
import type { ConnectionList, ConnectionProfile, DesktopApi, ServerInfo } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { flushAllComposerDrafts } from "../components/composerDrafts.js";
import { ConnectionsPanel } from "../components/ConnectionsPanel.js";
import { ipcErrorMessage } from "../components/ipcError.js";
import { describeConnectionError, type ConnectionSide } from "./connectionErrors.js";
import { createCwApi, type ShutdownHandlers } from "./createCwApi.js";
import { migrateLegacyPreferences } from "./legacyPrefs.js";
import { initTopics, waitForTopicSettled } from "./topics.js";

type Phase = { kind: "connecting" } | { kind: "failed"; error: ServerCallError } | { kind: "ready" };
type Link = "up" | "reconnecting" | "lost";

export interface ServerConnection {
  phase: Phase;
  link: Link;
  connect: () => void;
}

const RECONNECTING_BANNER_DELAY_MS = 1_000;
const APP_SETTLE_TIMEOUT_MS = 15_000;

type AppSettle = { kind: "settled"; status: string | undefined } | { kind: "timeout" } | { kind: "link-down" };

export function reload(): void {
  flushAllComposerDrafts();
  window.location.reload();
}

function asServerCallError(error: unknown): ServerCallError {
  return error instanceof ServerCallError ? error : new ServerCallError(ipcErrorMessage(error));
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

export function useServerConnection(
  client: ServerClient,
  desktop: DesktopApi | null,
  profile: { readonly current: ConnectionProfile | null },
  shutdownHandlers: ShutdownHandlers
): ServerConnection {
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
      window.cw = createCwApi(client, topicCache.current, desktop, profile.current, shutdownHandlers);
      appHold.current ??= topicCache.current.acquire(APP_TOPIC);
      const settle = await settleAppTopic(client);
      if (settle.kind === "link-down") throw client.lastError ?? new Error("the connection to the cw-code server was lost");
      if (settle.kind === "timeout") console.warn("[cw-code] the app topic did not settle in time; continuing without it");
      if (settle.kind === "settled" && settle.status === "ready") void migrateLegacyPreferences(window.cw);
      setPhase({ kind: "ready" });
    };
    open().catch((err: unknown) => setPhase({ kind: "failed", error: asServerCallError(err) }));
  }, [client, desktop, profile, shutdownHandlers]);

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

  return { phase, link, connect };
}

export function ServerConnectionView({
  client,
  connection,
  side,
  renderFailure,
  children
}: {
  client: ServerClient;
  connection: ServerConnection;
  side: ConnectionSide;
  renderFailure?: (error: ServerCallError, retry: () => void) => ReactNode;
  children: ReactNode;
}) {
  const { phase, link, connect } = connection;
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
    if (renderFailure) return <>{renderFailure(phase.error, connect)}</>;
    const text = describeConnectionError(phase.error, null, side);
    return (
      <div className="server-gate">
        <div className="preload-error">
          {text.title}: {text.message}
        </div>
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

function activeRemote(list: ConnectionList | null): Extract<ConnectionProfile, { kind: "remote" }> | null {
  const active = list?.profiles.find((profile) => profile.id === list.activeId);
  return active?.kind === "remote" ? active : null;
}

function DesktopFailure({ desktop, error, retry }: { desktop: DesktopApi; error: ServerCallError; retry: () => void }) {
  const [list, setList] = useState<ConnectionList | null>(null);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [showConnections, setShowConnections] = useState(false);
  const remote = activeRemote(list);

  useEffect(() => {
    let cancelled = false;
    desktop.connections.list().then(
      (next) => {
        if (!cancelled) setList(next);
      },
      (err: unknown) => console.warn(`[cw-code] could not load the saved connections: ${ipcErrorMessage(err)}`)
    );
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  useEffect(() => {
    if (error.code !== "protocol-mismatch" || !remote) return;
    let cancelled = false;
    desktop.connections.test({ url: remote.url, id: remote.id }).then(
      (result) => {
        if (!cancelled && result.info) setInfo(result.info);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [desktop, error, remote]);

  const text = describeConnectionError(error, info, "desktop");
  return (
    <div className="server-gate" role="alert">
      <div className="preload-error">
        {text.title}: {text.message}
      </div>
      {remote && (
        <div className="connections-hint">
          Connection: {remote.name} ({remote.url})
        </div>
      )}
      <div className="connections-actions">
        <button type="button" className="btn" aria-expanded={showConnections} onClick={() => setShowConnections((shown) => !shown)}>
          Connections…
        </button>
        <button type="button" className="btn btn-primary" onClick={retry}>
          Retry
        </button>
        {remote && (
          <button type="button" className="btn" onClick={() => desktop.connections.activate("local")}>
            Use this computer
          </button>
        )}
      </div>
      {showConnections && (
        <div className="server-gate-connections">
          <ConnectionsPanel connections={desktop.connections} />
        </div>
      )}
    </div>
  );
}

export function DesktopGate({ desktop, children }: { desktop: DesktopApi; children: ReactNode }) {
  const profile = useRef<ConnectionProfile | null>(null);
  const [client] = useState(
    () =>
      new ServerClient({
        endpoint: async () => {
          const connection = await desktop.connection();
          profile.current = connection.profile;
          return connection.endpoint;
        },
        client: "desktop-ui",
        reconnect: true
      })
  );
  const [shutdownHandlers] = useState<ShutdownHandlers>(() => new Set());
  const connection = useServerConnection(client, desktop, profile, shutdownHandlers);

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

  return (
    <ServerConnectionView
      client={client}
      connection={connection}
      side="desktop"
      renderFailure={(error, retry) => <DesktopFailure desktop={desktop} error={error} retry={retry} />}
    >
      {children}
    </ServerConnectionView>
  );
}
