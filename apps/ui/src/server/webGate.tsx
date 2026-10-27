import { useEffect, useState, type ReactNode } from "react";
import { ServerClient, type ServerCallError } from "@cw-code/client";
import type { ServerInfo } from "@cw-code/contracts";
import { INFO_PATH, isServerInfo } from "@cw-code/shared/protocol";
import { wsUrlFromPage } from "@cw-code/shared/serverAddress";
import { WebLogin } from "../components/WebLogin.js";
import { useEditorBuffers } from "../stores/editorBuffers.js";
import { describeConnectionError } from "./connectionErrors.js";
import { reload, ServerConnectionView, useServerConnection } from "./connect.js";
import type { ShutdownHandlers } from "./createCwApi.js";
import { clearDeviceToken, readDeviceToken, storeDeviceToken } from "./webToken.js";

const NO_PROFILE = { current: null };

interface Mismatch {
  error: ServerCallError;
  info: ServerInfo | null;
}

async function fetchServerInfo(): Promise<ServerInfo | null> {
  try {
    const response = await fetch(new URL(INFO_PATH.slice(1), window.location.href), { cache: "no-store" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isServerInfo(body) ? body : null;
  } catch {
    return null;
  }
}

export function signOutOfBrowser(): void {
  clearDeviceToken();
  reload();
}

function warnOnDirtyBuffers(e: BeforeUnloadEvent): void {
  if (useEditorBuffers.getState().dirty().length === 0) return;
  e.preventDefault();
  e.returnValue = "";
}

function MismatchScreen({ error, info }: { error: ServerCallError; info: ServerInfo | null }) {
  const text = describeConnectionError(error, info, "web");
  return (
    <div className="server-gate" role="alert">
      <div className="preload-error">
        {text.title}: {text.message}
      </div>
      <button type="button" className="btn btn-primary" onClick={reload}>
        Reload
      </button>
    </div>
  );
}

function WebSession({ token, onRejected, children }: { token: string; onRejected: (message: string) => void; children: ReactNode }) {
  const [client] = useState(() => new ServerClient({ endpoint: { url: wsUrlFromPage(window.location.href), token }, client: "web", reconnect: true }));
  const [shutdownHandlers] = useState<ShutdownHandlers>(() => new Set());
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const connection = useServerConnection(client, null, NO_PROFILE, shutdownHandlers);

  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      if (client.state !== "closed") return;
      const error = client.lastError;
      if (error?.code === "unauthorized") {
        client.close();
        onRejected(describeConnectionError(error, null, "web").message);
      } else if (error?.code === "protocol-mismatch") {
        setMismatch({ error, info: null });
        void fetchServerInfo().then((info) => {
          if (!cancelled) setMismatch({ error, info });
        });
      }
    };
    const offState = client.onState(check);
    check();
    return () => {
      cancelled = true;
      offState();
    };
  }, [client, onRejected]);

  useEffect(() => {
    window.addEventListener("beforeunload", warnOnDirtyBuffers);
    return () => window.removeEventListener("beforeunload", warnOnDirtyBuffers);
  }, []);

  if (mismatch) return <MismatchScreen error={mismatch.error} info={mismatch.info} />;
  return (
    <ServerConnectionView client={client} connection={connection} side="web">
      {children}
    </ServerConnectionView>
  );
}

export function WebGate({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(readDeviceToken);
  const [notice, setNotice] = useState<string | null>(null);
  const [onRejected] = useState(() => (message: string) => {
    clearDeviceToken();
    setNotice(message);
    setToken(null);
  });

  if (!token) {
    return (
      <WebLogin
        notice={notice}
        onToken={(next) => {
          if (!storeDeviceToken(next)) console.warn("[cw-code] could not save the device token; this browser will ask for it again after a reload");
          setNotice(null);
          setToken(next);
        }}
      />
    );
  }
  return (
    <WebSession key={token} token={token} onRejected={onRejected}>
      {children}
    </WebSession>
  );
}
