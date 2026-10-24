import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ServerClient } from "@cw-code/client";
import type { DesktopApi } from "@cw-code/contracts";
import { ipcErrorMessage } from "../components/ipcError.js";
import { createCwApi } from "./createCwApi.js";

type Phase = { kind: "connecting" } | { kind: "failed"; message: string } | { kind: "ready" };
type Link = "up" | "reconnecting" | "lost";

export function ServerGate({ desktop, children }: { desktop: DesktopApi; children: ReactNode }) {
  const [client] = useState(() => new ServerClient({ endpoint: () => desktop.serverEndpoint(), client: "desktop-ui", reconnect: true }));
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [link, setLink] = useState<Link>("up");

  const connect = useCallback(() => {
    setPhase({ kind: "connecting" });
    client.connect().then(
      () => {
        window.cw = createCwApi(client, desktop);
        setPhase({ kind: "ready" });
      },
      (err) => setPhase({ kind: "failed", message: ipcErrorMessage(err) })
    );
  }, [client, desktop]);

  useEffect(() => {
    const offState = client.onState((state, previous) => {
      if (state === "reconnecting") setLink("reconnecting");
      else if (state === "open" && previous === "reconnecting") window.location.reload();
      else if (state === "closed" && previous !== "connecting") setLink("lost");
    });
    const offStartup = client.on("startup.changed", () => window.location.reload());
    connect();
    return () => {
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
      {link === "lost" && (
        <div className="server-gate server-gate-overlay" role="alert">
          <div className="preload-error">The connection to the cw-code server was closed.</div>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
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
