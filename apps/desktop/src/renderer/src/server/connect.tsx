import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ServerClient, TopicCache } from "@cw-code/client";
import type { DesktopApi } from "@cw-code/contracts";
import { ipcErrorMessage } from "../components/ipcError.js";
import { useEditorBuffers } from "../stores/editorBuffers.js";
import { createCwApi, type ShutdownHandlers } from "./createCwApi.js";
import { initTopics } from "./topics.js";

type Phase = { kind: "connecting" } | { kind: "failed"; message: string } | { kind: "ready" };
type Link = "up" | "reconnecting" | "stale" | "lost";

const RECONNECTING_BANNER_DELAY_MS = 1_000;

function reload(): void {
  window.location.reload();
}

export function ServerGate({ desktop, children }: { desktop: DesktopApi; children: ReactNode }) {
  const [client] = useState(() => new ServerClient({ endpoint: () => desktop.serverEndpoint(), client: "desktop-ui", reconnect: true }));
  const [shutdownHandlers] = useState<ShutdownHandlers>(() => new Set());
  const topicCache = useRef<TopicCache | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [link, setLink] = useState<Link>("up");

  const connect = useCallback(() => {
    setPhase({ kind: "connecting" });
    client.connect().then(
      () => {
        topicCache.current ??= new TopicCache(client);
        initTopics(topicCache.current);
        window.cw = createCwApi(client, topicCache.current, desktop, shutdownHandlers);
        setPhase({ kind: "ready" });
      },
      (err) => setPhase({ kind: "failed", message: ipcErrorMessage(err) })
    );
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
      else if (state === "open" && previous === "reconnecting") {
        if (useEditorBuffers.getState().dirty().length === 0) reload();
        else setLink("stale");
      } else if (state === "closed" && previous !== "connecting") setLink("lost");
    });
    const offStartup = client.on("startup.changed", reload);
    connect();
    return () => {
      clearBannerTimer();
      offState();
      offStartup();
    };
  }, [client, connect]);

  if (phase.kind === "connecting") return <div className="server-gate">Connecting to the cw-code server…</div>;
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
      {link === "stale" && (
        <div className="server-banner" role="status">
          The cw-code server restarted — reload to resync
          <button type="button" className="btn" onClick={reload}>
            Reload
          </button>
        </div>
      )}
      {link === "lost" && (
        <div className="server-gate server-gate-overlay" role="alert">
          <div className="preload-error">
            The connection to the cw-code server was closed{client.lastError ? `: ${client.lastError.message}` : "."}
          </div>
          <button type="button" className="btn btn-primary" onClick={reload}>
            Reload
          </button>
        </div>
      )}
      {children}
    </>
  );
}

export function DesktopMissing() {
  return <div className="preload-error">cw-code must run inside the desktop app for now.</div>;
}
